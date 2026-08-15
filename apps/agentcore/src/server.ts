import {
  AgentCoreBrowserSessions,
  BedrockBrowserScoutDriver,
  DynamoActivityStore,
  DynamoWebSocketPublisher,
  S3SnapshotStore
} from "@happy/aws";
import { StartScoutRunRequestSchema } from "@happy/contracts";
import { EventHub, ResilientScoutDriver, ScoutCoordinator } from "@happy/runtime";
import Fastify from "fastify";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || value.startsWith("replace-with")) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const region = process.env.AWS_REGION ?? "ap-southeast-1";
const browsers = new AgentCoreBrowserSessions({
  region,
  browserIdentifier: process.env.AGENTCORE_BROWSER_ID ?? "aws.browser.v1"
});
const localEvents = new EventHub();
const remoteEvents = process.env.WEBSOCKET_MANAGEMENT_ENDPOINT
  ? new DynamoWebSocketPublisher({
      tableName: required("SCOUTS_TABLE_NAME"),
      endpoint: process.env.WEBSOCKET_MANAGEMENT_ENDPOINT,
      region
    })
  : undefined;
const publisher = {
  publish: async (event: Parameters<EventHub["publish"]>[0]) => {
    await localEvents.publish(event);
    await remoteEvents?.publish(event);
  }
};
const coordinator = new ScoutCoordinator({
  store: new DynamoActivityStore(required("SCOUTS_TABLE_NAME"), { region }),
  publisher,
  driver: new ResilientScoutDriver(new BedrockBrowserScoutDriver({
      region,
      modelId: required("BEDROCK_MODEL_ID"),
      browsers,
      candidatesPerScout: 2
    }), { backupAttempts: 2, timeoutMs: 360_000 }),
  snapshots: new S3SnapshotStore(required("SCOUTS_SCREENSHOT_BUCKET"), { region }),
  liveView: browsers,
  maxConcurrentItems: 5
});

const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.body.credentials"] } });
let busyTasks = 0;

app.get("/ping", async () => ({ status: busyTasks > 0 ? "HealthyBusy" : "Healthy" }));

app.post("/invocations", async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const action = body.action ?? "start";
  if (action === "start") {
    const scoutRequest = StartScoutRunRequestSchema.parse(body.request);
    const idempotencyKey = String(body.idempotencyKey ?? scoutRequest.activityId);
    const activity = await coordinator.start(scoutRequest, idempotencyKey);
    busyTasks += 1;
    void coordinator.waitForIdle(activity.id).finally(() => { busyTasks = Math.max(0, busyTasks - 1); });
    return reply.send({ accepted: true, activityId: activity.id });
  }
  const activityId = String(body.activityId ?? "");
  if (action === "pause") await coordinator.pause(activityId);
  else if (action === "resume") await coordinator.resume(activityId);
  else if (action === "cancel") await coordinator.cancel(activityId);
  else if (action === "confirm") await coordinator.confirm(activityId, body.itemIds as string[]);
  else if (action === "reject") await coordinator.reject(activityId, String(body.itemId), body.reason ? String(body.reason) : undefined);
  else return reply.code(400).send({ error: "unsupported_action" });
  return reply.send({ accepted: true, activityId, action });
});

await app.listen({ host: "0.0.0.0", port: 8080 });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
