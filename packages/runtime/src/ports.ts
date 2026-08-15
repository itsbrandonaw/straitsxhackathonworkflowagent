import type {
  ActivityEvent,
  ActivityRecord,
  Candidate,
  ItemSearchRequest,
  ScoutRecord,
  ScoutStage,
  StartScoutRunRequest
} from "@happy/contracts";

export type CreateActivityResult = { created: boolean; activity: ActivityRecord };

export interface ActivityStore {
  create(activity: ActivityRecord): Promise<CreateActivityResult>;
  get(activityId: string): Promise<ActivityRecord | undefined>;
  save(activity: ActivityRecord, expectedVersion: number): Promise<void>;
  appendEvent(event: ActivityEvent): Promise<void>;
  eventsAfter(activityId: string, sequence: number): Promise<ActivityEvent[]>;
}

export interface EventPublisher {
  publish(event: ActivityEvent): Promise<void>;
}

export type ScoutRunCallbacks = {
  onStage(stage: ScoutStage, detail?: string): Promise<void>;
  onBrowserSession(sessionId: string): Promise<void>;
  onBrowserSessionEnded(): Promise<void>;
  onCandidate(candidate: Candidate): Promise<void>;
  onScreenshot(bytes: Uint8Array, contentType: string): Promise<void>;
};

export type ScoutRunContext = {
  activityId: string;
  item: ItemSearchRequest;
  itemAttempt: number;
  scout: ScoutRecord;
  signal: AbortSignal;
  callbacks: ScoutRunCallbacks;
};

export interface ScoutDriver {
  run(context: ScoutRunContext): Promise<void>;
}

export type SnapshotAccess =
  | { kind: "bytes"; bytes: Uint8Array; contentType: string }
  | { kind: "redirect"; url: string };

export interface SnapshotStore {
  put(input: {
    activityId: string;
    itemId: string;
    scoutId: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<string>;
  get(key: string): Promise<SnapshotAccess | undefined>;
}

export interface LiveViewProvider {
  createUrl(scout: ScoutRecord): Promise<{ url: string; expiresAt: string }>;
}

export interface ActivityInvoker {
  invoke(request: StartScoutRunRequest, idempotencyKey: string): Promise<void>;
}
