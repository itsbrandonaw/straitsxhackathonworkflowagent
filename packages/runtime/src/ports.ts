import type {
  ActivityEvent,
  ActivityRecord,
  Candidate,
  ItemSearchRequest,
  ScoutRecord,
  ScoutStage,
  ScoutStrategy,
  StartScoutRunRequest,
  LiveFrameView
} from "@happy/contracts";

export type CreateActivityResult = { created: boolean; activity: ActivityRecord };

export interface ActivityStore {
  create(activity: ActivityRecord): Promise<CreateActivityResult>;
  get(activityId: string): Promise<ActivityRecord | undefined>;
  save(activity: ActivityRecord, expectedVersion: number): Promise<void>;
  appendEvent(event: ActivityEvent): Promise<void>;
  eventsAfter(activityId: string, sequence: number): Promise<ActivityEvent[]>;
  findByScoutId?(scoutId: string): Promise<ActivityRecord | undefined>;
}

export interface EventPublisher {
  publish(event: ActivityEvent): Promise<void>;
}

export type ScoutRunCallbacks = {
  onStage(stage: ScoutStage, detail?: string): Promise<void>;
  onBrowserSession(sessionId: string): Promise<void>;
  /** Returns true only when the coordinator accepted this candidate into the shared item pool. */
  onCandidate(candidate: Candidate): Promise<boolean>;
  onScreenshot(bytes: Uint8Array, contentType: string): Promise<void>;
  requestedLiveFrameFps?(): number;
  onLiveFrame?(bytes: Uint8Array, contentType: "image/jpeg"): Promise<void>;
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

export type { LiveFrameView } from "@happy/contracts";

export type LiveFrame = {
  activityId: string;
  itemId: string;
  scoutId: string;
  capturedAt: string;
  contentType: "image/jpeg";
  bytes: Uint8Array;
};

export type LiveFrameStatus = "completed";

export type LiveFrameListener = {
  onFrame(frame: LiveFrame): void;
  onRateChanged?(framesPerSecond: number): void;
  onStatus?(status: LiveFrameStatus): void;
};

export type LiveFrameSubscription = {
  id: string;
  framesPerSecond(): number;
  unsubscribe(): void;
};

export interface LiveFramePublisher {
  requestedFps(scoutId: string): number;
  publish(frame: LiveFrame): Promise<void>;
  complete(scoutId: string): void;
}

export interface LiveFrameChannel extends LiveFramePublisher {
  subscribe(scoutId: string, view: LiveFrameView, listener: LiveFrameListener): LiveFrameSubscription;
  close(): void;
}

export interface ActivityInvoker {
  invoke(request: StartScoutRunRequest, idempotencyKey: string): Promise<void>;
}

export interface BrowserPage {
  goto(url: string, timeoutMs?: number): Promise<void>;
  links(): Promise<string[]>;
  text(maxCharacters: number): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  url(): Promise<string>;
}

export type BrowserSessionHandle = {
  id: string;
  page: BrowserPage;
};

export interface BrowserSessionProvider {
  start(input: {
    activityId: string;
    itemId: string;
    scoutId: string;
    locale: string;
  }): Promise<BrowserSessionHandle>;
  stop(session: BrowserSessionHandle): Promise<void>;
  close?(): Promise<void>;
}

export interface CandidateExtractor {
  extract(input: {
    activityId: string;
    item: ItemSearchRequest;
    scout: ScoutRecord;
    canonicalUrl: string;
    untrustedPageText: string;
  }): Promise<Candidate>;
}

export interface SearchSource {
  discover(input: {
    item: ItemSearchRequest;
    strategy: ScoutStrategy;
    attempt: number;
    page: BrowserPage;
  }): Promise<string[]>;
}

export type RuntimeInfo = {
  mode: "mock" | "local" | "aws";
  browser: "synthetic" | "playwright" | "agentcore";
  extraction: "fixture" | "ollama" | "bedrock";
  persistence: "memory" | "local_disk" | "dynamodb";
  imagery: "snapshots" | "binary_websocket" | "agentcore_live_view";
};
