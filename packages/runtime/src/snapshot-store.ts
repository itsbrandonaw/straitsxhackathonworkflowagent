import { randomUUID } from "node:crypto";
import type { SnapshotAccess, SnapshotStore } from "./ports.js";

type Snapshot = { bytes: Uint8Array; contentType: string };

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>();

  async put(input: {
    activityId: string;
    itemId: string;
    scoutId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<string> {
    const key = `${input.activityId}/${input.itemId}/${input.scoutId}/${randomUUID()}`;
    this.snapshots.set(key, { bytes: input.bytes, contentType: input.contentType });
    return key;
  }

  async get(key: string): Promise<SnapshotAccess | undefined> {
    const snapshot = this.snapshots.get(key);
    return snapshot ? { kind: "bytes", ...snapshot } : undefined;
  }
}

export class LocalUnavailableLiveViewProvider {
  async createUrl(): Promise<{ url: string; expiresAt: string }> {
    throw new Error("Live View is available only when AgentCore Browser mode is configured");
  }
}
