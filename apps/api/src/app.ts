import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import {
  ConfirmScoutRunRequestSchema,
  LIVE_FRAME_PROTOCOL,
  RejectItemRequestSchema,
  StartScoutRunRequestSchema,
  type LiveFrameView
} from "@happy/contracts";
import {
  ActivityConflictError,
  ActivityNotFoundError
} from "@happy/runtime";
import Fastify from "fastify";
import { ZodError } from "zod";
import { createDependenciesFromEnv, type AppDependencies } from "./dependencies.js";

export type { AppDependencies } from "./dependencies.js";

function scoutViewerHtml(encodedScoutId: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Happy Scout viewer</title><style>
body{font-family:system-ui;background:#f4f6f2;color:#14221d;margin:0;padding:24px}main{max-width:1100px;margin:auto}.meta{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px}.card{background:white;border:1px solid #dce3de;border-radius:10px;padding:12px}.card span{display:block;color:#718078;font-size:12px}.card strong{display:block;margin-top:4px}.viewer{position:relative;aspect-ratio:16/9;overflow:hidden;border:1px solid #dce3de;border-radius:12px;background:white}.viewer img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 200ms ease}.viewer img.active{opacity:1}.note{color:#718078}@media(max-width:750px){.meta{grid-template-columns:1fr 1fr}}
</style></head><body><main><h1>Happy Scout live frames</h1><p class="note">Low-rate JPEG observability, not remote browser control.</p><div class="meta"><div class="card"><span>Item</span><strong id="item">Loading</strong></div><div class="card"><span>Scout</span><strong id="scout"></strong></div><div class="card"><span>Stage</span><strong id="stage"></strong></div><div class="card"><span>Detail</span><strong id="detail"></strong></div><div class="card"><span>Feed</span><strong id="feed">Connecting</strong></div></div><div class="viewer"><img id="frame-a" alt="Scout browser frame"><img id="frame-b" alt="Scout browser frame"></div></main><script>
const scoutId=atob(${encodedScoutId});const images=[document.getElementById('frame-a'),document.getElementById('frame-b')];const urls=[null,null];let active=-1;let receivedLive=false;let terminal=false;let activitySocket;let frameSocket;let refreshTimer;let frameReconnectTimer;let reconnectDelay=500;
function showFrame(blob){const next=active===0?1:0;const previous=active;if(urls[next])URL.revokeObjectURL(urls[next]);const url=URL.createObjectURL(blob);urls[next]=url;images[next].onload=()=>{images[next].classList.add('active');if(previous>=0){images[previous].classList.remove('active');const old=urls[previous];setTimeout(()=>{if(urls[previous]===old){URL.revokeObjectURL(old);urls[previous]=null}},250)}active=next};images[next].src=url}
function setFeed(value){document.getElementById('feed').textContent=value}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,100)}
async function refresh(){const state=await fetch('/v1/scouts/'+encodeURIComponent(scoutId)+'/state').then(r=>r.json());document.getElementById('item').textContent=state.itemName;document.getElementById('scout').textContent=state.scout.id;document.getElementById('stage').textContent=state.scout.stage;document.getElementById('detail').textContent=state.scout.detail||'—';terminal=['selected','failed','cancelled'].includes(state.scout.stage);if(!receivedLive&&state.scout.snapshotKey){fetch('/v1/scouts/'+encodeURIComponent(scoutId)+'/snapshot?v='+encodeURIComponent(state.scout.snapshotKey)).then(r=>r.blob()).then(showFrame).catch(()=>{})}if(!activitySocket)connectActivity(state.activityId);if(terminal){setFeed('Last frame');frameSocket?.close()}else if(document.visibilityState==='visible'&&!frameSocket)connectFrames()}
function connectActivity(activityId){const protocol=location.protocol==='https:'?'wss:':'ws:';activitySocket=new WebSocket(protocol+'//'+location.host+'/v1/events?activityId='+encodeURIComponent(activityId)+'&afterSequence=0');activitySocket.onmessage=scheduleRefresh;activitySocket.onclose=()=>{activitySocket=undefined;if(!terminal)setTimeout(scheduleRefresh,500)}}
function connectFrames(){clearTimeout(frameReconnectTimer);const protocol=location.protocol==='https:'?'wss:':'ws:';frameSocket=new WebSocket(protocol+'//'+location.host+'/v1/scouts/'+encodeURIComponent(scoutId)+'/frames?view=expanded','${LIVE_FRAME_PROTOCOL}');frameSocket.binaryType='blob';setFeed('Connecting');frameSocket.onopen=()=>{reconnectDelay=500};frameSocket.onmessage=event=>{if(typeof event.data==='string'){try{const status=JSON.parse(event.data);if(status.type==='ready'||status.type==='rate_changed')setFeed('Live '+Number(status.framesPerSecond).toFixed(1)+' FPS');if(status.type==='completed')setFeed('Last frame')}catch{}}else{receivedLive=true;showFrame(event.data)}};frameSocket.onclose=()=>{frameSocket=undefined;if(!terminal&&document.visibilityState==='visible'){setFeed('Reconnecting');frameReconnectTimer=setTimeout(connectFrames,reconnectDelay);reconnectDelay=Math.min(5000,reconnectDelay*2)}}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){frameSocket?.close();setFeed('Paused')}else if(!terminal&&!frameSocket)connectFrames()});window.addEventListener('beforeunload',()=>{activitySocket?.close();frameSocket?.close();urls.forEach(url=>url&&URL.revokeObjectURL(url))});refresh().catch(()=>setTimeout(scheduleRefresh,1000));
</script></body></html>`;
}

export async function buildApp(providedDependencies?: AppDependencies) {
  const dependencies = providedDependencies ?? await createDependenciesFromEnv();
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.cookie"] } });
  await app.register(cors, { origin: true });
  await app.register(websocket, {
    options: {
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(LIVE_FRAME_PROTOCOL) ? LIVE_FRAME_PROTOCOL : false
    }
  });
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

  app.get<{ Params: { scoutId: string } }>("/v1/scouts/:scoutId/frames", { websocket: true }, (socket, request) => {
    const scoutId = request.params.scoutId;
    const requestedView = new URL(request.url, "http://localhost").searchParams.get("view") ?? "collapsed";
    const sendEarlyError = (error: string) => socket.send(JSON.stringify({
      type: "error", schemaVersion: 1, scoutId, view: requestedView, error
    }));
    const requestedProtocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",").map((value) => value.trim());
    if (!requestedProtocols.includes(LIVE_FRAME_PROTOCOL)) {
      sendEarlyError("unsupported_protocol");
      socket.close(1002, `Use ${LIVE_FRAME_PROTOCOL}`);
      return;
    }
    if (!dependencies.frames) {
      sendEarlyError("frame_stream_unavailable");
      socket.close(1013, "Frame streaming is unavailable for this runtime");
      return;
    }
    const view = requestedView;
    if (view !== "collapsed" && view !== "expanded") {
      sendEarlyError("invalid_view");
      socket.close(1008, "view must be collapsed or expanded");
      return;
    }

    const frames = dependencies.frames;
    const maxBufferedBytes = dependencies.frameMaxBufferedBytes ?? 1_048_576;
    let ready = false;
    let negotiatedFps = 0;
    let consecutiveDrops = 0;
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const sendStatus = (type: string, extra: Record<string, unknown> = {}) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify({ type, schemaVersion: 1, scoutId, view, ...extra }));
    };

    void dependencies.coordinator.scoutState(scoutId).then(({ scout }) => {
      if (closed) return;
      if (["selected", "failed", "cancelled"].includes(scout.stage)) {
        sendStatus("completed", { framesPerSecond: 0 });
        socket.close(1000, "Scout completed");
        return;
      }
      const subscription = frames.subscribe(scoutId, view as LiveFrameView, {
        onFrame: (frame) => {
          if (socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > maxBufferedBytes) {
            consecutiveDrops += 1;
            if (consecutiveDrops >= 20) socket.close(1013, "Frame consumer is too slow");
            return;
          }
          consecutiveDrops = 0;
          socket.send(frame.bytes, { binary: true });
        },
        onRateChanged: (framesPerSecond) => {
          negotiatedFps = framesPerSecond;
          if (ready) sendStatus("rate_changed", { framesPerSecond });
        },
        onStatus: (status) => {
          sendStatus(status, { framesPerSecond: 0 });
          if (status === "completed") socket.close(1000, "Scout completed");
        }
      });
      unsubscribe = subscription.unsubscribe;
      ready = true;
      sendStatus("ready", { framesPerSecond: negotiatedFps || subscription.framesPerSecond() });
    }).catch(() => {
      if (closed) return;
      sendStatus("error", { error: "scout_not_found" });
      socket.close(1008, "Scout not found");
    });
    socket.on("close", () => {
      closed = true;
      unsubscribe();
    });
  });

  app.get<{ Params: { scoutId: string } }>("/v1/scouts/:scoutId/live", async (request, reply) => {
    await dependencies.coordinator.scoutState(request.params.scoutId);
    const encodedScoutId = JSON.stringify(Buffer.from(request.params.scoutId, "utf8").toString("base64"));
    return reply
      .header("content-security-policy", "default-src 'self'; img-src 'self' blob:; connect-src 'self' ws: wss:; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
      .type("text/html; charset=utf-8")
      .send(scoutViewerHtml(encodedScoutId));
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
