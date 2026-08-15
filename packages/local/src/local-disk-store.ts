import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ActivityEvent, ActivityRecord } from "@happy/contracts";
import type { ActivityStore, CreateActivityResult } from "@happy/runtime";

const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

export class LocalDiskActivityStore implements ActivityStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly activitiesDir: string;
  private readonly idempotencyDir: string;
  private readonly eventsDir: string;

  constructor(private readonly root: string, private readonly eventTtlMs = 86_400_000) {
    this.activitiesDir = join(root, "activities");
    this.idempotencyDir = join(root, "idempotency");
    this.eventsDir = join(root, "events");
  }

  async create(activity: ActivityRecord): Promise<CreateActivityResult> {
    return this.lock(async () => {
      await this.ensureDirectories();
      const idempotencyPath = join(this.idempotencyDir, `${digest(activity.idempotencyKey)}.txt`);
      const existingActivityId = await this.readOptional(idempotencyPath);
      if (existingActivityId) {
        const existing = await this.readActivity(existingActivityId.trim());
        if (existing) return { created: false, activity: existing };
      }
      const byId = await this.readActivity(activity.id);
      if (byId) return { created: false, activity: byId };
      await this.atomicJson(this.activityPath(activity.id), activity);
      await this.atomicText(idempotencyPath, activity.id);
      return { created: true, activity: clone(activity) };
    });
  }

  async get(activityId: string): Promise<ActivityRecord | undefined> {
    return this.readActivity(activityId);
  }

  async save(activity: ActivityRecord, expectedVersion: number): Promise<void> {
    await this.lock(async () => {
      const current = await this.readActivity(activity.id);
      if (!current) throw new Error(`Activity not found: ${activity.id}`);
      if (current.version !== expectedVersion) {
        throw new Error(`Version conflict for ${activity.id}: expected ${expectedVersion}, received ${current.version}`);
      }
      await this.atomicJson(this.activityPath(activity.id), activity);
    });
  }

  async appendEvent(event: ActivityEvent): Promise<void> {
    await this.lock(async () => {
      await this.ensureDirectories();
      const events = await this.readEvents(event.activityId);
      const fresh = this.onlyFresh(events);
      if (!fresh.some((existing) => existing.eventId === event.eventId)) fresh.push(clone(event));
      fresh.sort((left, right) => left.sequence - right.sequence);
      await this.atomicJson(this.eventsPath(event.activityId), fresh);
    });
  }

  async eventsAfter(activityId: string, sequence: number): Promise<ActivityEvent[]> {
    const events = this.onlyFresh(await this.readEvents(activityId));
    return clone(events.filter((event) => event.sequence > sequence).sort((left, right) => left.sequence - right.sequence));
  }

  async findByScoutId(scoutId: string): Promise<ActivityRecord | undefined> {
    await this.ensureDirectories();
    for (const entry of await readdir(this.activitiesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const activity = JSON.parse(await readFile(join(this.activitiesDir, entry.name), "utf8")) as ActivityRecord;
      if (activity.items.some((item) => item.scouts.some((scout) => scout.id === scoutId))) return activity;
    }
    return undefined;
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(operation);
    this.chain = next;
    return next;
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.activitiesDir, { recursive: true }),
      mkdir(this.idempotencyDir, { recursive: true }),
      mkdir(this.eventsDir, { recursive: true })
    ]);
  }

  private activityPath(activityId: string): string {
    return join(this.activitiesDir, `${digest(activityId)}.json`);
  }

  private eventsPath(activityId: string): string {
    return join(this.eventsDir, `${digest(activityId)}.json`);
  }

  private async readActivity(activityId: string): Promise<ActivityRecord | undefined> {
    const text = await this.readOptional(this.activityPath(activityId));
    return text ? JSON.parse(text) as ActivityRecord : undefined;
  }

  private async readEvents(activityId: string): Promise<ActivityEvent[]> {
    const text = await this.readOptional(this.eventsPath(activityId));
    return text ? JSON.parse(text) as ActivityEvent[] : [];
  }

  private onlyFresh(events: ActivityEvent[]): ActivityEvent[] {
    const cutoff = Date.now() - this.eventTtlMs;
    return events.filter((event) => Date.parse(event.timestamp) >= cutoff);
  }

  private async readOptional(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async atomicJson(path: string, value: unknown): Promise<void> {
    await this.atomicText(path, `${JSON.stringify(value)}\n`);
  }

  private async atomicText(path: string, value: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }
}
