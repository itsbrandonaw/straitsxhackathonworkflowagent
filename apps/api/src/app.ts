import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  ConfirmScoutRunRequestSchema,
  RejectItemRequestSchema,
  StartScoutRunRequestSchema
} from "@happy/contracts";
import {
  ActivityConflictError,
  ActivityNotFoundError,
  EventHub,
  InMemoryActivityStore,
  InMemorySnapshotStore,
  LocalUnavailableLiveViewProvider,
  MockScoutDriver,
  ResilientScoutDriver,
  ScoutCoordinator
} from "@happy/runtime";
import Fastify from "fastify";
import { ZodError } from "zod";

export type AppDependencies = {
  coordinator: ScoutCoordinator;
  events: EventHub;
};

export function createLocalDependencies(): AppDependencies {
  const events = new EventHub();
  return {
    events,
    coordinator: new ScoutCoordinator({
      store: new InMemoryActivityStore(),
      publisher: events,
      // Slow the diagnostic run enough for queued and active states to be visible.
      driver: new ResilientScoutDriver(new MockScoutDriver(200)),
      snapshots: new InMemorySnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider(),
      maxConcurrentItems: 5
    })
  };
}

export async function buildApp(dependencies: AppDependencies = createLocalDependencies()) {
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie"] } });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({ error: "validation_error", issues: error.issues });
      return;
    }
    if (error instanceof ActivityNotFoundError) {
      void reply.code(404).send({ error: "not_found", message: error.message });
      return;
    }
    if (error instanceof ActivityConflictError) {
      void reply.code(409).send({ error: "conflict", message: error.message });
      return;
    }
    app.log.error({ err: error }, "request failed");
    void reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ status: "ok", mode: process.env.SCOUT_MODE ?? "mock" }));

  app.post("/v1/scout-runs", async (request, reply) => {
    const body = StartScoutRunRequestSchema.parse(request.body);
    const header = request.headers["idempotency-key"];
    const idempotencyKey = typeof header === "string" && header.length > 0 ? header : `generated-${randomUUID()}`;
    const activity = await dependencies.coordinator.start(body, idempotencyKey);
    return reply.code(202).send(activity);
  });

  app.get<{ Params: { activityId: string } }>("/v1/scout-runs/:activityId", async (request) =>
    dependencies.coordinator.get(request.params.activityId));

  app.post<{ Params: { activityId: string } }>("/v1/scout-runs/:activityId/pause", async (request) =>
    dependencies.coordinator.pause(request.params.activityId));

  app.post<{ Params: { activityId: string } }>("/v1/scout-runs/:activityId/resume", async (request) =>
    dependencies.coordinator.resume(request.params.activityId));

  app.post<{ Params: { activityId: string } }>("/v1/scout-runs/:activityId/cancel", async (request) =>
    dependencies.coordinator.cancel(request.params.activityId));

  app.post<{ Params: { activityId: string } }>("/v1/scout-runs/:activityId/confirm", async (request) => {
    const body = ConfirmScoutRunRequestSchema.parse(request.body);
    return dependencies.coordinator.confirm(request.params.activityId, body.itemIds);
  });

  app.post<{ Params: { activityId: string; itemId: string } }>(
    "/v1/scout-runs/:activityId/items/:itemId/reject",
    async (request) => {
      const body = RejectItemRequestSchema.parse(request.body ?? {});
      return dependencies.coordinator.reject(request.params.activityId, request.params.itemId, body.reason);
    }
  );

  app.get<{ Params: { activityId: string } }>("/v1/scout-runs/:activityId/closer-handoff", async (request) =>
    dependencies.coordinator.closerHandoff(request.params.activityId));

  app.post<{ Params: { scoutId: string } }>("/v1/scouts/:scoutId/live-view-url", async (request, reply) => {
    try {
      return await dependencies.coordinator.liveViewUrl(request.params.scoutId);
    } catch (error) {
      return reply.code(503).send({
        error: "live_view_unavailable",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get<{ Params: { scoutId: string } }>("/v1/scouts/:scoutId/snapshot", async (request, reply) => {
    const snapshot = await dependencies.coordinator.snapshot(request.params.scoutId);
    if (!snapshot) return reply.code(404).send({ error: "snapshot_not_found" });
    if (snapshot.kind === "redirect") return reply.redirect(snapshot.url);
    return reply.type(snapshot.contentType).send(Buffer.from(snapshot.bytes));
  });

  app.get("/v1/events", { websocket: true }, (socket, request) => {
    const requestUrl = new URL(request.url, "http://localhost");
    const activityId = requestUrl.searchParams.get("activityId");
    const afterSequence = Number(requestUrl.searchParams.get("afterSequence") ?? "0");
    if (!activityId || !Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      socket.send(JSON.stringify({ error: "invalid_subscription" }));
      socket.close(1008, "activityId and a valid afterSequence are required");
      return;
    }
    let unsubscribe: () => void = () => {};
    void dependencies.coordinator.eventsAfter(activityId, afterSequence).then((events) => {
      for (const event of events) socket.send(JSON.stringify(event));
      unsubscribe = dependencies.events.subscribe(activityId, (event) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });
    }).catch(() => socket.close(1008, "activity not found"));
    socket.on("close", () => unsubscribe());
  });

  return app;
}
