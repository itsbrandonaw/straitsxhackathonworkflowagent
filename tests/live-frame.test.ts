import { describe, expect, it, vi } from "vitest";
import { LIVE_FRAME_PROTOCOL, LiveFrameStatusMessageSchema } from "@happy/contracts";
import { InMemoryLiveFrameHub, type LiveFrame } from "@happy/runtime";

function frame(scoutId = "scout-1"): LiveFrame {
  return {
    activityId: "activity-1",
    itemId: "item-1",
    scoutId,
    capturedAt: new Date().toISOString(),
    contentType: "image/jpeg",
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  };
}

describe("live-frame protocol", () => {
  it("validates public status messages", () => {
    expect(LIVE_FRAME_PROTOCOL).toBe("happy.scout-jpeg.v1");
    expect(LiveFrameStatusMessageSchema.parse({
      schemaVersion: 1,
      type: "ready",
      scoutId: "scout-1",
      view: "expanded",
      framesPerSecond: 3
    }).type).toBe("ready");
    expect(() => LiveFrameStatusMessageSchema.parse({
      schemaVersion: 1,
      type: "ready",
      scoutId: "scout-1",
      view: "full-speed",
      framesPerSecond: 60
    })).toThrow();
  });

  it("broadcasts one ephemeral frame to every viewer of that Scout", async () => {
    const hub = new InMemoryLiveFrameHub();
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const firstSubscription = hub.subscribe("scout-1", "collapsed", { onFrame: first });
    const secondSubscription = hub.subscribe("scout-1", "expanded", { onFrame: second });
    const otherSubscription = hub.subscribe("scout-2", "expanded", { onFrame: other });

    expect(hub.requestedFps("scout-1")).toBe(3);
    await hub.publish(frame());
    await hub.publish(frame());
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();

    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    expect(hub.requestedFps("scout-1")).toBe(0);
    await hub.publish(frame());
    expect(first).toHaveBeenCalledOnce();
    otherSubscription.unsubscribe();
  });

  it("shares the global budget fairly and completes without affecting Scout work", () => {
    const hub = new InMemoryLiveFrameHub({ globalFpsBudget: 12 });
    const completed = Array.from({ length: 10 }, () => vi.fn());
    const subscriptions = completed.map((listener, index) => hub.subscribe(`scout-${index}`, "expanded", {
      onFrame: () => undefined,
      onStatus: listener
    }));
    const rates = subscriptions.map((subscription) => subscription.framesPerSecond());
    expect(rates.reduce((sum, rate) => sum + rate, 0)).toBeCloseTo(12);
    expect(new Set(rates.map((rate) => rate.toFixed(3))).size).toBe(1);

    hub.complete("scout-0");
    expect(completed[0]).toHaveBeenCalledWith("completed");
    expect(subscriptions[0]?.framesPerSecond()).toBe(0);
    subscriptions.forEach((subscription) => subscription.unsubscribe());
  });
});
