import { describe, expect, it } from "vitest";
import type { StartScoutRunRequest } from "@happy/contracts";
import {
  EventHub,
  InMemoryActivityStore,
  InMemorySnapshotStore,
  LocalUnavailableLiveViewProvider,
  MockScoutDriver,
  ScoutCoordinator
} from "@happy/runtime";
import type { ScoutDriver, ScoutRunContext, SnapshotStore } from "@happy/runtime";

class OneScoutFailsDriver implements ScoutDriver {
  private readonly working = new MockScoutDriver(1, 2);
  async run(context: ScoutRunContext): Promise<void> {
    if (context.scout.strategy === "specialist_independent") throw new Error("source unavailable");
    await this.working.run(context);
  }
}

class FailingSnapshotStore implements SnapshotStore {
  async put(): Promise<string> { throw new Error("image backend unavailable"); }
  async get(): Promise<undefined> { return undefined; }
}

function request(itemCount: number): StartScoutRunRequest {
  return {
    activityId: `activity-${itemCount}`,
    items: Array.from({ length: itemCount }, (_, index) => ({
      itemId: `item-${index + 1}`,
      name: `Item ${index + 1}`,
      specs: { type: "demo" },
      quantity: 1,
      rankingPreset: "best_overall",
      shipToCountry: "SG",
      locale: "en-SG"
    }))
  };
}

describe("ScoutCoordinator", () => {
  it("queues a sixth item, completes twelve Scouts, replays events, and hands off confirmed URLs", async () => {
    const store = new InMemoryActivityStore();
    const events = new EventHub();
    const coordinator = new ScoutCoordinator({
      store,
      publisher: events,
      driver: new MockScoutDriver(15, 2),
      snapshots: new InMemorySnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider(),
      maxConcurrentItems: 5
    });
    const created = await coordinator.start(request(6), "idempotency-6");
    expect(created.items.flatMap((item) => item.scouts)).toHaveLength(12);

    let observedQueuedOverflow = false;
    while ((await coordinator.get(created.id)).status === "searching") {
      const current = await coordinator.get(created.id);
      const active = current.items.flatMap((item) => item.scouts)
        .filter((scout) => !["queued", "selected", "failed", "cancelled"].includes(scout.stage));
      expect(active.length).toBeLessThanOrEqual(10);
      observedQueuedOverflow ||= current.items[5]?.scouts.every((scout) => scout.stage === "queued") ?? false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await coordinator.waitForIdle(created.id);
    const completed = await coordinator.get(created.id);
    expect(observedQueuedOverflow).toBe(true);
    expect(completed.status).toBe("awaiting_confirmation");
    expect(completed.items.every((item) => item.status === "selected")).toBe(true);
    expect(completed.items.every((item) => item.candidates.length === 4)).toBe(true);
    expect(completed.items.every((item) => item.scouts.every((scout) => scout.listingsGathered === 2))).toBe(true);

    const replay = await coordinator.eventsAfter(created.id, 0);
    expect(replay.map((event) => event.sequence)).toEqual(
      Array.from({ length: replay.length }, (_, index) => index + 1)
    );
    expect(replay.some((event) => event.type === "scout.snapshot_ready")).toBe(true);
    expect(replay.some((event) => event.type === "comparison.completed")).toBe(true);

    const confirmed = await coordinator.confirm(created.id, completed.items.map((item) => item.request.itemId));
    expect(confirmed.status).toBe("ready_for_closer");
    const handoff = await coordinator.closerHandoff(created.id);
    expect(handoff.selections).toHaveLength(6);
    expect(handoff.selections.every((selection) => selection.url.startsWith("https://"))).toBe(true);
  }, 10_000);

  it("is idempotent and advances to a retained alternative on rejection", async () => {
    const coordinator = new ScoutCoordinator({
      store: new InMemoryActivityStore(),
      publisher: new EventHub(),
      driver: new MockScoutDriver(1, 2),
      snapshots: new InMemorySnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider()
    });
    const first = await coordinator.start(request(1), "same-key");
    const duplicate = await coordinator.start(request(1), "same-key");
    expect(duplicate.id).toBe(first.id);
    await coordinator.waitForIdle(first.id);
    const selected = await coordinator.get(first.id);
    const original = selected.items[0]?.selectedCandidateId;
    const rejected = await coordinator.reject(first.id, "item-1", "show me another");
    expect(rejected.items[0]?.selectedCandidateId).not.toBe(original);
    expect(rejected.items[0]?.rejectedCandidateIds).toContain(original);
  });

  it("restarts only the rejected item after its first three ranked choices are exhausted", async () => {
    const coordinator = new ScoutCoordinator({
      store: new InMemoryActivityStore(),
      publisher: new EventHub(),
      driver: new MockScoutDriver(1, 2),
      snapshots: new InMemorySnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider()
    });
    const activity = await coordinator.start(request(2), "re-search");
    await coordinator.waitForIdle(activity.id);
    await coordinator.confirm(activity.id, ["item-2"]);

    await coordinator.reject(activity.id, "item-1", "try the second choice");
    await coordinator.reject(activity.id, "item-1", "try the third choice");
    const restarted = await coordinator.reject(activity.id, "item-1", "search again");
    expect(restarted.items[0]?.attempt).toBe(2);
    expect(restarted.items[0]?.status).toBe("queued");

    await coordinator.waitForIdle(activity.id);
    const completed = await coordinator.get(activity.id);
    expect(completed.items[0]?.status).toBe("selected");
    expect(completed.items[0]?.attempt).toBe(2);
    expect(completed.items[0]?.rejectedCandidateIds).toHaveLength(3);
    expect(completed.items[1]?.status).toBe("confirmed");
    expect(completed.items[1]?.attempt).toBe(1);
  });

  it("selects with low coverage when one Scout and snapshot observability fail", async () => {
    const coordinator = new ScoutCoordinator({
      store: new InMemoryActivityStore(),
      publisher: new EventHub(),
      driver: new OneScoutFailsDriver(),
      snapshots: new FailingSnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider()
    });
    const activity = await coordinator.start(request(1), "partial-failure");
    await coordinator.waitForIdle(activity.id);
    const completed = await coordinator.get(activity.id);
    expect(completed.items[0]?.status).toBe("selected");
    expect(completed.items[0]?.lowCoverage).toBe(true);
    expect(completed.items[0]?.scouts.some((scout) => scout.stage === "failed")).toBe(true);
    expect(completed.items[0]?.scouts.some((scout) => scout.stage === "selected")).toBe(true);
  });
});
