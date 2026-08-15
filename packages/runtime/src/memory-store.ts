import type { ActivityEvent, ActivityRecord } from "@happy/contracts";
import type { ActivityStore, CreateActivityResult } from "./ports.js";

const clone = <T>(value: T): T => structuredClone(value);

export class InMemoryActivityStore implements ActivityStore {
  private readonly activities = new Map<string, ActivityRecord>();
  private readonly idempotency = new Map<string, string>();
  private readonly events = new Map<string, ActivityEvent[]>();

  async create(activity: ActivityRecord): Promise<CreateActivityResult> {
    const existingId = this.idempotency.get(activity.idempotencyKey);
    const existing = existingId ? this.activities.get(existingId) : this.activities.get(activity.id);
    if (existing) return { created: false, activity: clone(existing) };
    this.activities.set(activity.id, clone(activity));
    this.idempotency.set(activity.idempotencyKey, activity.id);
    return { created: true, activity: clone(activity) };
  }

  async get(activityId: string): Promise<ActivityRecord | undefined> {
    const activity = this.activities.get(activityId);
    return activity ? clone(activity) : undefined;
  }

  async save(activity: ActivityRecord, expectedVersion: number): Promise<void> {
    const current = this.activities.get(activity.id);
    if (!current) throw new Error(`Activity not found: ${activity.id}`);
    if (current.version !== expectedVersion) {
      throw new Error(`Version conflict for ${activity.id}: expected ${expectedVersion}, received ${current.version}`);
    }
    this.activities.set(activity.id, clone(activity));
  }

  async appendEvent(event: ActivityEvent): Promise<void> {
    const events = this.events.get(event.activityId) ?? [];
    if (!events.some((existing) => existing.eventId === event.eventId)) events.push(clone(event));
    this.events.set(event.activityId, events);
  }

  async eventsAfter(activityId: string, sequence: number): Promise<ActivityEvent[]> {
    return clone((this.events.get(activityId) ?? []).filter((event) => event.sequence > sequence));
  }
}
