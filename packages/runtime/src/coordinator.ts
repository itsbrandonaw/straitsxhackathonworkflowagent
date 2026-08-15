import { randomUUID } from "node:crypto";
import type {
  ActivityEvent,
  ActivityEventType,
  ActivityRecord,
  Candidate,
  CloserHandoff,
  ItemRecord,
  ScoutRecord,
  ScoutStage,
  StartScoutRunRequest
} from "@happy/contracts";
import { assertScoutTransition, candidateDeduplicationKey, compareCandidates } from "@happy/core";
import type {
  ActivityStore,
  EventPublisher,
  LiveViewProvider,
  ScoutDriver,
  SnapshotAccess,
  SnapshotStore
} from "./ports.js";

type Control = { paused: boolean; cancelled: boolean; waiters: Set<() => void>; abort: AbortController };
type EventLocation = { itemId?: string; scoutId?: string; attempt?: number };

export class ActivityNotFoundError extends Error {}
export class ActivityConflictError extends Error {}

export class ScoutCoordinator {
  private readonly controls = new Map<string, Control>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly mutationChains = new Map<string, Promise<unknown>>();
  private readonly lastSnapshotAt = new Map<string, number>();

  constructor(private readonly dependencies: {
    store: ActivityStore;
    publisher: EventPublisher;
    driver: ScoutDriver;
    snapshots: SnapshotStore;
    liveView: LiveViewProvider;
    maxConcurrentItems?: number;
  }) {}

  async start(request: StartScoutRunRequest, idempotencyKey: string): Promise<ActivityRecord> {
    const now = new Date().toISOString();
    const activity: ActivityRecord = {
      id: request.activityId,
      idempotencyKey,
      status: "searching",
      version: 0,
      sequence: 0,
      createdAt: now,
      updatedAt: now,
      items: request.items.map((item): ItemRecord => ({
        request: item,
        status: "queued",
        attempt: 1,
        scouts: [
          this.createScout(item.itemId, "a", "broad_mainstream"),
          this.createScout(item.itemId, "b", "specialist_independent")
        ],
        candidates: [],
        rankedCandidates: [],
        rejectedCandidateIds: [],
        lowCoverage: false
      }))
    };
    const created = await this.dependencies.store.create(activity);
    if (!created.created) {
      this.controls.set(created.activity.id, this.newControl(created.activity.status === "paused"));
      return created.activity;
    }

    this.controls.set(activity.id, this.newControl());
    await this.emit(activity.id, "activity.started", { itemCount: activity.items.length });
    for (const item of activity.items) {
      await this.emit(activity.id, "item.queued", { name: item.request.name }, { itemId: item.request.itemId, attempt: item.attempt });
    }
    const run = this.runActivity(activity.id).finally(() => this.running.delete(activity.id));
    this.running.set(activity.id, run);
    void run.catch(() => undefined);
    return this.requireActivity(activity.id);
  }

  async get(activityId: string): Promise<ActivityRecord> {
    return this.requireActivity(activityId);
  }

  async eventsAfter(activityId: string, sequence: number): Promise<ActivityEvent[]> {
    await this.requireActivity(activityId);
    return this.dependencies.store.eventsAfter(activityId, sequence);
  }

  async pause(activityId: string): Promise<ActivityRecord> {
    const control = this.requireControl(activityId);
    control.paused = true;
    return this.emit(activityId, "activity.paused", {}, {}, (activity) => { activity.status = "paused"; });
  }

  async resume(activityId: string): Promise<ActivityRecord> {
    const control = this.requireControl(activityId);
    control.paused = false;
    for (const waiter of control.waiters) waiter();
    control.waiters.clear();
    return this.emit(activityId, "activity.resumed", {}, {}, (activity) => { activity.status = "searching"; });
  }

  async cancel(activityId: string): Promise<ActivityRecord> {
    const control = this.requireControl(activityId);
    control.cancelled = true;
    control.abort.abort();
    for (const waiter of control.waiters) waiter();
    control.waiters.clear();
    return this.emit(activityId, "activity.cancelled", {}, {}, (activity) => {
      activity.status = "cancelled";
      for (const item of activity.items) {
        if (["selected", "confirmed", "failed"].includes(item.status)) continue;
        item.status = "cancelled";
        for (const scout of item.scouts) {
          if (!["selected", "failed", "cancelled"].includes(scout.stage)) scout.stage = "cancelled";
        }
      }
    });
  }

  async confirm(activityId: string, itemIds: string[]): Promise<ActivityRecord> {
    const requested = new Set(itemIds);
    const activity = await this.requireActivity(activityId);
    for (const itemId of requested) {
      const item = activity.items.find((candidate) => candidate.request.itemId === itemId);
      if (!item || item.status !== "selected") throw new ActivityConflictError(`Item is not selectable: ${itemId}`);
      await this.emit(activityId, "item.confirmed", {}, { itemId, attempt: item.attempt }, (next) => {
        const mutable = this.findItem(next, itemId);
        mutable.status = "confirmed";
      });
    }
    const updated = await this.requireActivity(activityId);
    const complete = updated.items.every((item) => item.status === "confirmed" || item.status === "failed");
    if (!complete) return updated;
    return this.emit(activityId, "activity.ready_for_closer", {}, {}, (next) => { next.status = "ready_for_closer"; });
  }

  async reject(activityId: string, itemId: string, reason?: string): Promise<ActivityRecord> {
    const activity = await this.requireActivity(activityId);
    const item = this.findItem(activity, itemId);
    if (item.status !== "selected" && item.status !== "confirmed") {
      throw new ActivityConflictError(`Item cannot be rejected from ${item.status}`);
    }
    const currentId = item.selectedCandidateId;
    const next = item.rankedCandidates.slice(0, 3).find((candidate) =>
      candidate.eligible && candidate.id !== currentId && !item.rejectedCandidateIds.includes(candidate.id));
    if (!currentId) throw new ActivityConflictError("The item has no selected candidate");
    if (next) {
      return this.emit(activityId, "item.rejected", { reason, replacementCandidateId: next.id }, { itemId, attempt: item.attempt }, (record) => {
        const mutable = this.findItem(record, itemId);
        mutable.rejectedCandidateIds.push(currentId);
        mutable.selectedCandidateId = next.id;
        mutable.status = "selected";
        if (record.status === "ready_for_closer") record.status = "awaiting_confirmation";
      });
    }

    const restarted = await this.emit(activityId, "item.rejected", { reason, discoveryRestarted: true }, { itemId, attempt: item.attempt }, (record) => {
      const mutable = this.findItem(record, itemId);
      if (!mutable.rejectedCandidateIds.includes(currentId)) mutable.rejectedCandidateIds.push(currentId);
      mutable.attempt += 1;
      mutable.status = "queued";
      delete mutable.selectedCandidateId;
      mutable.lowCoverage = false;
      mutable.scouts = [
        { ...this.createScout(itemId, "a", "broad_mainstream"), attempt: mutable.attempt },
        { ...this.createScout(itemId, "b", "specialist_independent"), attempt: mutable.attempt }
      ];
      record.status = "searching";
    });
    if (!this.controls.has(activityId)) this.controls.set(activityId, this.newControl());
    const run = this.restartItem(activityId, itemId).finally(() => this.running.delete(activityId));
    this.running.set(activityId, run);
    void run.catch(() => undefined);
    return restarted;
  }

  async closerHandoff(activityId: string): Promise<CloserHandoff> {
    const activity = await this.requireActivity(activityId);
    if (activity.status !== "ready_for_closer") throw new ActivityConflictError("Activity is not ready for Closer");
    return {
      activityId,
      selections: activity.items.flatMap((item) => {
        if (item.status !== "confirmed" || !item.selectedCandidateId) return [];
        const selected = item.rankedCandidates.find((candidate) => candidate.id === item.selectedCandidateId);
        return selected ? [{ itemId: item.request.itemId, url: selected.url }] : [];
      })
    };
  }

  async liveViewUrl(scoutId: string): Promise<{ url: string; expiresAt: string }> {
    const { scout } = await this.findScoutAcrossActivities(scoutId);
    return this.dependencies.liveView.createUrl(scout);
  }

  async snapshot(scoutId: string): Promise<SnapshotAccess | undefined> {
    const { scout } = await this.findScoutAcrossActivities(scoutId);
    return scout.snapshotKey ? this.dependencies.snapshots.get(scout.snapshotKey) : undefined;
  }

  async scoutState(scoutId: string): Promise<{
    activityId: string;
    itemId: string;
    itemName: string;
    scout: ScoutRecord;
  }> {
    const { activity, scout } = await this.findScoutAcrossActivities(scoutId);
    const item = this.findItem(activity, scout.itemId);
    return {
      activityId: activity.id,
      itemId: item.request.itemId,
      itemName: item.request.name,
      scout
    };
  }

  async waitForIdle(activityId: string): Promise<void> {
    await this.running.get(activityId);
  }

  private createScout(itemId: string, suffix: string, strategy: ScoutRecord["strategy"]): ScoutRecord {
    return { id: `scout-${randomUUID()}-${suffix}`, itemId, strategy, stage: "queued", attempt: 1, listingsGathered: 0 };
  }

  private async runActivity(activityId: string): Promise<void> {
    const activity = await this.requireActivity(activityId);
    const queue = activity.items.map((item) => item.request.itemId);
    const workerCount = Math.min(this.dependencies.maxConcurrentItems ?? 5, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        await this.waitUntilRunnable(activityId);
        const itemId = queue.shift();
        if (!itemId || this.requireControl(activityId).cancelled) return;
        await this.processItem(activityId, itemId);
      }
    }));
    const final = await this.requireActivity(activityId);
    if (final.status === "cancelled") return;
    const allFailed = final.items.every((item) => item.status === "failed");
    await this.emit(activityId, allFailed ? "activity.failed" : "activity.awaiting_confirmation", {
      selected: final.items.filter((item) => item.status === "selected").length,
      failed: final.items.filter((item) => item.status === "failed").length
    }, {}, (record) => { record.status = allFailed ? "failed" : "awaiting_confirmation"; });
  }

  private async processItem(activityId: string, itemId: string): Promise<void> {
    const before = await this.requireActivity(activityId);
    const itemBefore = this.findItem(before, itemId);
    await this.emit(activityId, "item.search_started", {}, { itemId, attempt: itemBefore.attempt }, (activity) => {
      const item = this.findItem(activity, itemId);
      item.status = "searching";
      for (const scout of item.scouts) {
        assertScoutTransition(scout.stage, "pending");
        scout.stage = "pending";
      }
    });
    const current = await this.requireActivity(activityId);
    const item = this.findItem(current, itemId);
    await Promise.all(item.scouts.map((scout) => this.runScout(activityId, item.request.itemId, scout.id)));

    const gathered = await this.requireActivity(activityId);
    const gatheredItem = this.findItem(gathered, itemId);
    const usableCandidates = gatheredItem.candidates.filter((candidate) =>
      !gatheredItem.rejectedCandidateIds.includes(candidate.id));
    if (usableCandidates.length < 2) {
      await this.failItem(activityId, itemId, "Fewer than two valid candidates after recovery");
      return;
    }
    await this.emit(activityId, "comparison.started", { candidateCount: usableCandidates.length }, { itemId, attempt: gatheredItem.attempt }, (activity) => {
      const mutable = this.findItem(activity, itemId);
      mutable.status = "comparing";
      for (const scout of mutable.scouts) {
        if (scout.stage === "failed") continue;
        assertScoutTransition(scout.stage, "comparing");
        scout.stage = "comparing";
      }
    });
    const comparing = await this.requireActivity(activityId);
    const comparingItem = this.findItem(comparing, itemId);
    const result = compareCandidates(
      comparingItem.request,
      comparingItem.candidates.filter((candidate) => !comparingItem.rejectedCandidateIds.includes(candidate.id))
    );
    if (!result.selected) {
      await this.failItem(activityId, itemId, "No eligible candidate remained after comparison");
      return;
    }
    const selected = result.selected;
    await this.emit(activityId, "comparison.completed", {
      selectedCandidateId: selected.id,
      rankedCandidateIds: result.ranked.map((candidate) => candidate.id),
      lowCoverage: result.lowCoverage
    }, { itemId, attempt: comparingItem.attempt }, (activity) => {
      const mutable = this.findItem(activity, itemId);
      mutable.rankedCandidates = result.ranked;
      mutable.selectedCandidateId = selected.id;
      mutable.lowCoverage = result.lowCoverage;
    });
    await this.emit(activityId, "item.selected", { candidateId: selected.id }, { itemId, attempt: comparingItem.attempt }, (activity) => {
      const mutable = this.findItem(activity, itemId);
      mutable.status = "selected";
      for (const scout of mutable.scouts) {
        if (scout.stage === "failed") continue;
        assertScoutTransition(scout.stage, "selected");
        scout.stage = "selected";
      }
    });
  }

  private async restartItem(activityId: string, itemId: string): Promise<void> {
    await this.processItem(activityId, itemId);
    const activity = await this.requireActivity(activityId);
    const item = this.findItem(activity, itemId);
    if (activity.status === "cancelled") return;
    await this.emit(activityId, "activity.awaiting_confirmation", {
      restartedItemId: itemId,
      itemStatus: item.status
    }, {}, (record) => {
      record.status = "awaiting_confirmation";
    });
  }

  private async runScout(activityId: string, itemId: string, scoutId: string): Promise<void> {
    const control = this.requireControl(activityId);
    const current = await this.requireActivity(activityId);
    const item = this.findItem(current, itemId);
    const scout = this.findScout(item, scoutId);
    await this.emit(activityId, "scout.started", { strategy: scout.strategy }, { itemId, scoutId, attempt: scout.attempt });
    try {
      await this.dependencies.driver.run({
        activityId,
        item: item.request,
        itemAttempt: item.attempt,
        scout,
        signal: control.abort.signal,
        callbacks: {
          onBrowserSession: async (sessionId) => {
            await this.emit(activityId, "scout.stage_changed", { browserSessionId: sessionId }, { itemId, scoutId, attempt: scout.attempt }, (record) => {
              this.findScout(this.findItem(record, itemId), scoutId).browserSessionId = sessionId;
            });
          },
          onStage: async (stage, detail) => {
            await this.waitUntilRunnable(activityId);
            await this.transitionScout(activityId, itemId, scoutId, stage, detail);
          },
          onCandidate: async (candidate) => this.acceptCandidate(activityId, itemId, scoutId, candidate),
          onScreenshot: async (bytes, contentType) => this.saveSnapshot(activityId, itemId, scoutId, bytes, contentType)
        }
      });
    } catch (error) {
      if (control.cancelled) return;
      const message = error instanceof Error ? error.message : String(error);
      await this.emit(activityId, "scout.failed", { error: message }, { itemId, scoutId, attempt: scout.attempt }, (activity) => {
        const mutable = this.findScout(this.findItem(activity, itemId), scoutId);
        if (mutable.stage !== "failed") {
          assertScoutTransition(mutable.stage, "failed");
          mutable.stage = "failed";
        }
        mutable.error = message;
      });
    } finally {
      this.lastSnapshotAt.delete(`${activityId}:${scoutId}`);
    }
  }

  private async transitionScout(activityId: string, itemId: string, scoutId: string, stage: ScoutStage, detail?: string): Promise<void> {
    const activity = await this.requireActivity(activityId);
    const scout = this.findScout(this.findItem(activity, itemId), scoutId);
    if (scout.stage === stage) return;
    await this.emit(activityId, "scout.stage_changed", { from: scout.stage, to: stage, detail }, { itemId, scoutId, attempt: scout.attempt }, (record) => {
      const mutable = this.findScout(this.findItem(record, itemId), scoutId);
      assertScoutTransition(mutable.stage, stage);
      mutable.stage = stage;
      if (detail) mutable.detail = detail;
    });
  }

  private async acceptCandidate(activityId: string, itemId: string, scoutId: string, candidate: Candidate): Promise<boolean> {
    const activity = await this.requireActivity(activityId);
    const item = this.findItem(activity, itemId);
    const key = candidateDeduplicationKey(candidate);
    const duplicate = item.candidates.some((existing) => candidateDeduplicationKey(existing) === key);
    if (duplicate) {
      await this.emit(activityId, "candidate.rejected", { candidateId: candidate.id, reason: "duplicate" }, { itemId, scoutId, attempt: item.attempt });
      return false;
    }
    await this.emit(activityId, "candidate.accepted", { candidateId: candidate.id, merchant: candidate.merchant }, { itemId, scoutId, attempt: item.attempt }, (record) => {
      const mutableItem = this.findItem(record, itemId);
      mutableItem.candidates.push(candidate);
      this.findScout(mutableItem, scoutId).listingsGathered += 1;
    });
    return true;
  }

  private async saveSnapshot(activityId: string, itemId: string, scoutId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const throttleKey = `${activityId}:${scoutId}`;
    const now = Date.now();
    if (now - (this.lastSnapshotAt.get(throttleKey) ?? 0) < 1_000) return;
    this.lastSnapshotAt.set(throttleKey, now);
    try {
      const key = await this.dependencies.snapshots.put({ activityId, itemId, scoutId, bytes, contentType });
      const activity = await this.requireActivity(activityId);
      const item = this.findItem(activity, itemId);
      const scout = this.findScout(item, scoutId);
      await this.emit(activityId, "scout.snapshot_ready", { snapshotKey: key }, { itemId, scoutId, attempt: scout.attempt }, (record) => {
        this.findScout(this.findItem(record, itemId), scoutId).snapshotKey = key;
      });
    } catch {
      // Imagery is intentionally non-fatal. Structured logs are added by the API/AWS adapter.
    }
  }

  private async failItem(activityId: string, itemId: string, error: string): Promise<void> {
    const activity = await this.requireActivity(activityId);
    const item = this.findItem(activity, itemId);
    await this.emit(activityId, "item.failed", { error }, { itemId, attempt: item.attempt }, (record) => {
      const mutable = this.findItem(record, itemId);
      mutable.status = "failed";
      mutable.error = error;
      for (const scout of mutable.scouts) {
        if (["failed", "cancelled"].includes(scout.stage)) continue;
        if (scout.stage !== "selected") scout.stage = "failed";
      }
    });
  }

  private async emit(
    activityId: string,
    type: ActivityEventType,
    payload: unknown,
    location: EventLocation = {},
    mutate?: (activity: ActivityRecord) => void
  ): Promise<ActivityRecord> {
    return this.serialize(activityId, async () => {
      const current = await this.requireActivity(activityId);
      const next = structuredClone(current);
      mutate?.(next);
      next.sequence += 1;
      next.version += 1;
      next.updatedAt = new Date().toISOString();
      const event: ActivityEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        sequence: next.sequence,
        type,
        activityId,
        attempt: location.attempt ?? 1,
        timestamp: next.updatedAt,
        payload,
        ...(location.itemId ? { itemId: location.itemId } : {}),
        ...(location.scoutId ? { scoutId: location.scoutId } : {})
      };
      await this.dependencies.store.save(next, current.version);
      await this.dependencies.store.appendEvent(event);
      await this.dependencies.publisher.publish(event);
      return next;
    });
  }

  private serialize<T>(activityId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChains.get(activityId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutationChains.set(activityId, next);
    return next.finally(() => {
      if (this.mutationChains.get(activityId) === next) this.mutationChains.delete(activityId);
    });
  }

  private async waitUntilRunnable(activityId: string): Promise<void> {
    const control = this.requireControl(activityId);
    if (control.cancelled) throw new DOMException("Activity cancelled", "AbortError");
    if (!control.paused) return;
    await new Promise<void>((resolve) => control.waiters.add(resolve));
    if (control.cancelled) throw new DOMException("Activity cancelled", "AbortError");
  }

  private requireControl(activityId: string): Control {
    const control = this.controls.get(activityId);
    if (!control) throw new ActivityNotFoundError(`Activity control not found: ${activityId}`);
    return control;
  }

  private newControl(paused = false): Control {
    return { paused, cancelled: false, waiters: new Set(), abort: new AbortController() };
  }

  private async requireActivity(activityId: string): Promise<ActivityRecord> {
    const activity = await this.dependencies.store.get(activityId);
    if (!activity) throw new ActivityNotFoundError(`Activity not found: ${activityId}`);
    return activity;
  }

  private findItem(activity: ActivityRecord, itemId: string): ItemRecord {
    const item = activity.items.find((candidate) => candidate.request.itemId === itemId);
    if (!item) throw new ActivityNotFoundError(`Item not found: ${itemId}`);
    return item;
  }

  private findScout(item: ItemRecord, scoutId: string): ScoutRecord {
    const scout = item.scouts.find((candidate) => candidate.id === scoutId);
    if (!scout) throw new ActivityNotFoundError(`Scout not found: ${scoutId}`);
    return scout;
  }

  private async findScoutAcrossActivities(scoutId: string): Promise<{ activity: ActivityRecord; scout: ScoutRecord }> {
    const persisted = await this.dependencies.store.findByScoutId?.(scoutId);
    if (persisted) {
      for (const item of persisted.items) {
        const scout = item.scouts.find((candidate) => candidate.id === scoutId);
        if (scout) return { activity: persisted, scout };
      }
    }
    for (const id of this.controls.keys()) {
      const activity = await this.dependencies.store.get(id);
      if (!activity) continue;
      for (const item of activity.items) {
        const scout = item.scouts.find((candidate) => candidate.id === scoutId);
        if (scout) return { activity, scout };
      }
    }
    throw new ActivityNotFoundError(`Scout not found: ${scoutId}`);
  }
}
