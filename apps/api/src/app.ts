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
  ActivityNotFoundError
} from "@happy/runtime";
import Fastify from "fastify";
import { ZodError } from "zod";
import { createDependenciesFromEnv, type AppDependencies } from "./dependencies.js";

export type { AppDependencies } from "./dependencies.js";

export async function buildApp(providedDependencies?: AppDependencies) {
  const dependencies = providedDependencies ?? await createDependenciesFromEnv();
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie"] } });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  app.addHook("onClose", async () => dependencies.shutdown?.());

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

  app.get("/health", async () => ({ status: "ok", ...dependencies.info }));

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

  app.get<{ Params: { scoutId: string } }>("/v1/scouts/:scoutId/state", async (request) =>
    dependencies.coordinator.scoutState(request.params.scoutId));

  app.get<{ Params: { scoutId: string } }>("/v1/scouts/:scoutId/live", async (request, reply) => {
    await dependencies.coordinator.scoutState(request.params.scoutId);
    const encodedScoutId = JSON.stringify(Buffer.from(request.params.scoutId, "utf8").toString("base64"));
    return reply
      .header("content-security-policy", "default-src 'self'; img-src 'self'; connect-src 'self' ws: wss:; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
      .type("text/html; charset=utf-8")
      .send(`<!doctype html><html><head><meta charset="utf-8"><title>Happy Scout viewer</title><style>body{font-family:system-ui;background:#f4f6f2;color:#14221d;margin:0;padding:24px}main{max-width:1100px;margin:auto}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}.card{background:white;border:1px solid #dce3de;border-radius:10px;padding:12px}.card span{display:block;color:#718078;font-size:12px}.card strong{display:block;margin-top:4px}img{width:100%;background:white;border:1px solid #dce3de;border-radius:12px}.note{color:#718078}</style></head><body><main><h1>Happy Scout live snapshot</h1><p class="note">This is a low-rate screenshot stream, not remote browser control.</p><div class="meta"><div class="card"><span>Item</span><strong id="item">Loading</strong></div><div class="card"><span>Scout</span><strong id="scout"></strong></div><div class="card"><span>Stage</span><strong id="stage"></strong></div><div class="card"><span>Detail</span><strong id="detail"></strong></div></div><img id="snapshot" alt="Latest Scout browser snapshot"></main><script>const scoutId=atob(${encodedScoutId});let socket;let refreshTimer;function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,100)}async function refresh(){const state=await fetch('/v1/scouts/'+encodeURIComponent(scoutId)+'/state').then(r=>r.json());document.getElementById('item').textContent=state.itemName;document.getElementById('scout').textContent=state.scout.id;document.getElementById('stage').textContent=state.scout.stage;document.getElementById('detail').textContent=state.scout.detail||'—';if(state.scout.snapshotKey)document.getElementById('snapshot').src='/v1/scouts/'+encodeURIComponent(scoutId)+'/snapshot?v='+encodeURIComponent(state.scout.snapshotKey);if(!socket){const protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(protocol+'//'+location.host+'/v1/events?activityId='+encodeURIComponent(state.activityId)+'&afterSequence=0');socket.onmessage=scheduleRefresh;socket.onclose=()=>{socket=undefined;setTimeout(scheduleRefresh,500)}}}refresh().catch(()=>setTimeout(scheduleRefresh,1000));</script></body></html>`);
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
