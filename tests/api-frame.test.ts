import { afterEach, describe, expect, it } from "vitest";
import { LIVE_FRAME_PROTOCOL, type StartScoutRunRequest } from "@happy/contracts";
import {
  EventHub,
  InMemoryActivityStore,
  InMemoryLiveFrameHub,
  InMemorySnapshotStore,
  LocalUnavailableLiveViewProvider,
  ScoutCoordinator,
  type ScoutDriver,
  type ScoutRunContext
} from "@happy/runtime";
import { buildApp } from "../apps/api/src/app.js";

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

class SlowScoutDriver implements ScoutDriver {
  async run(context: ScoutRunContext): Promise<void> {
    await context.callbacks.onBrowserSession(`session-${context.scout.id}`);
    await context.callbacks.onStage("discovering", "Waiting for frame API test");
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    throw new Error("test driver finished");
  }
}

const request: StartScoutRunRequest = {
  activityId: "frame-api-activity",
  items: [{
    itemId: "frame-item",
    name: "Frame test item",
    specs: {},
    quantity: 1,
    rankingPreset: "best_overall",
    shipToCountry: "SG",
    locale: "en-SG"
  }]
};

describe("Scout frame WebSocket", () => {
  it("negotiates the protocol and sends status separately from binary JPEG frames", async () => {
    const events = new EventHub();
    const frames = new InMemoryLiveFrameHub();
    const coordinator = new ScoutCoordinator({
      store: new InMemoryActivityStore(),
      publisher: events,
      driver: new SlowScoutDriver(),
      snapshots: new InMemorySnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider(),
      liveFrames: frames
    });
    const app = await buildApp({
      coordinator,
      events,
      frames,
      info: {
        mode: "local",
        browser: "playwright",
        extraction: "fixture",
        persistence: "memory",
        imagery: "binary_websocket"
      }
    });
    openApps.push(app);
    const activity = await coordinator.start(request, "frame-api-test");
    const scoutId = activity.items[0]!.scouts[0].id;
    await app.ready();
    let resolveInitial!: (value: Buffer) => void;
    const initialMessage = new Promise<Buffer>((resolve) => { resolveInitial = resolve; });
    const socket = await app.injectWS(
      `/v1/scouts/${encodeURIComponent(scoutId)}/frames?view=expanded`,
      { headers: { "sec-websocket-protocol": LIVE_FRAME_PROTOCOL } },
      { onInit: (client) => client.once("message", (data) => resolveInitial(Buffer.from(data))) }
    );
    const nextMessage = () => new Promise<Buffer>((resolve, reject) => {
      socket.once("message", (data) => resolve(Buffer.from(data)));
      socket.once("error", reject);
    });

    const status = JSON.parse((await initialMessage).toString("utf8")) as { type: string; framesPerSecond: number };
    expect(status).toMatchObject({ type: "ready", framesPerSecond: 3 });

    const eventsBeforeFrame = await coordinator.eventsAfter(activity.id, 0);
    const binaryMessage = nextMessage();
    await frames.publish({
      activityId: activity.id,
      itemId: "frame-item",
      scoutId,
      capturedAt: new Date().toISOString(),
      contentType: "image/jpeg",
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    });
    expect([...(await binaryMessage)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect((await coordinator.eventsAfter(activity.id, 0))).toHaveLength(eventsBeforeFrame.length);
    socket.terminate();
  });
});
