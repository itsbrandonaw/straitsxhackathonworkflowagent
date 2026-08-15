import { randomBytes, randomUUID } from "node:crypto";
import type {
  ActivityEvent,
  Candidate,
  ScoutStage,
  StartScoutRunRequest
} from "@happy/contracts";
import type { EventHub, ScoutCoordinator } from "@happy/runtime";
import { z } from "zod";

const CallbackSchema = z.object({
  url: z.url(),
  token: z.string().min(1).optional()
});

const WishlistItemSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(240),
  short: z.string().min(1).max(16),
  spec: z.string().max(1_000),
  budget: z.string().max(100),
  hueIndex: z.number().int().min(0).max(5),
  category: z.string().min(1).max(100).optional()
});

const ClarificationSchema = z.object({
  itemId: z.string().min(1).max(100),
  prompt: z.string().max(1_000),
  chosen: z.string().max(240).optional()
}).passthrough();

export const WebsiteSearchRequestSchema = z.object({
  activityId: z.string().min(1),
  items: z.array(WishlistItemSchema).min(1).max(10),
  clarifications: z.array(ClarificationSchema).max(10).default([]),
  callback: CallbackSchema,
  scouts: z.object({
    perItem: z.literal(2),
    maxConcurrentItems: z.number().int().min(1).max(5),
    listingsPerScout: z.number().int().min(1).max(3),
    strategies: z.tuple([z.literal("large-marketplaces"), z.literal("specialist-independent")])
  })
});
export type WebsiteSearchRequest = z.infer<typeof WebsiteSearchRequestSchema>;

export const WebsiteControlRequestSchema = z.object({ callback: CallbackSchema });
export const WebsiteRejectRequestSchema = WebsiteControlRequestSchema.extend({
  itemId: z.string().min(1).max(100),
  feedback: z.string().max(1_000).optional()
});

type StageIndex = 0 | 1 | 2 | 3 | 4;
type WebsiteCallback =
  | { type: "item.progress"; progress: { itemId: string; stage: StageIndex; previousStage: StageIndex; queued: boolean } }
  | { type: "agent.update"; agent: WebsiteAgent }
  | { type: "shortlist.ready"; shortlist: WebsiteShortlistPick[] }
  | { type: "run.failed"; message: string };

type WebsiteAgent = {
  agentId: string;
  itemId: string;
  slot: 0 | 1;
  url: string;
  stage: StageIndex;
  action: string;
  queued: boolean;
  liveStreamUrl?: string;
};

type WebsiteListing = {
  title: string;
  seller: string;
  rating: string;
  price: string;
  amountMinor: number;
  why: string;
  url: string;
};

type WebsiteShortlistPick = {
  itemId: string;
  listing: WebsiteListing;
  reSearched: boolean;
  alternates?: WebsiteListing[];
};

type StoredCallback = {
  id: string;
  body: string;
  attempts: number;
  delivered: boolean;
};

type RunBridge = {
  request: WebsiteSearchRequest;
  callback: z.infer<typeof CallbackSchema>;
  progress: Map<string, { stage: StageIndex; queued: boolean }>;
  agents: Map<string, WebsiteAgent>;
  reSearchedItems: Set<string>;
  shortlistSent: boolean;
  failedSent: boolean;
  cancelled: boolean;
  outbox: StoredCallback[];
  chain: Promise<void>;
  unsubscribe: () => void;
};

type Capability = { activityId: string; scoutId: string; expiresAt: number };

export class LiveViewCapabilities {
  private readonly capabilities = new Map<string, Capability>();
  private readonly tokenByScout = new Map<string, string>();

  constructor(
    private readonly coordinator: ScoutCoordinator,
    private readonly viewerBaseUrl: string,
    private readonly lifetimeMs = 20 * 60 * 1_000
  ) {}

  issue(activityId: string, scoutId: string): string {
    const existing = this.tokenByScout.get(scoutId);
    if (existing && this.capabilities.has(existing)) return this.viewerUrl(existing);
    const token = randomBytes(32).toString("base64url");
    this.capabilities.set(token, { activityId, scoutId, expiresAt: Date.now() + this.lifetimeMs });
    this.tokenByScout.set(scoutId, token);
    return this.viewerUrl(token);
  }

  revokeScout(scoutId: string): void {
    const capabilityId = this.tokenByScout.get(scoutId);
    if (capabilityId) this.capabilities.delete(capabilityId);
    this.tokenByScout.delete(scoutId);
  }

  revokeActivity(activityId: string): void {
    for (const [token, capability] of this.capabilities) {
      if (capability.activityId !== activityId) continue;
      this.capabilities.delete(token);
      this.tokenByScout.delete(capability.scoutId);
    }
  }

  async exchange(token: string): Promise<{ url: string; expiresAt: string }> {
    const capability = this.capabilities.get(token);
    if (!capability || capability.expiresAt <= Date.now()) {
      if (capability) this.revokeScout(capability.scoutId);
      throw new Error("Live View capability is missing or expired");
    }
    return this.coordinator.liveViewUrl(capability.scoutId);
  }

  private viewerUrl(token: string): string {
    return `${this.viewerBaseUrl.replace(/\/$/, "")}/live#${token}`;
  }
}

export class WebsiteCallbackBridge {
  private readonly runs = new Map<string, RunBridge>();

  constructor(
    private readonly coordinator: ScoutCoordinator,
    private readonly events: EventHub,
    readonly capabilities: LiveViewCapabilities,
    private readonly options: { fetch?: typeof fetch; retryDelaysMs?: number[] } = {}
  ) {}

  register(request: WebsiteSearchRequest): void {
    const current = this.runs.get(request.activityId);
    if (current) {
      current.callback = request.callback;
      return;
    }
    const run: RunBridge = {
      request,
      callback: request.callback,
      progress: new Map(),
      agents: new Map(),
      reSearchedItems: new Set(),
      shortlistSent: false,
      failedSent: false,
      cancelled: false,
      outbox: [],
      chain: Promise.resolve(),
      unsubscribe: () => undefined
    };
    run.unsubscribe = this.events.subscribe(request.activityId, (event) => {
      run.chain = run.chain.then(() => this.handle(run, event)).catch(() => undefined);
    });
    this.runs.set(request.activityId, run);
  }

  updateCallback(activityId: string, callback: z.infer<typeof CallbackSchema>): void {
    const run = this.runs.get(activityId);
    if (run) run.callback = callback;
  }

  async waitForIdle(activityId: string): Promise<void> {
    await this.runs.get(activityId)?.chain;
  }

  private async handle(run: RunBridge, event: ActivityEvent): Promise<void> {
    if (run.cancelled) return;
    if (event.type === "activity.cancelled") {
      run.cancelled = true;
      this.capabilities.revokeActivity(event.activityId);
      return;
    }
    if (event.type === "item.queued" && event.itemId) {
      await this.sendProgress(run, event.itemId, 0, true);
      for (const slot of [0, 1] as const) {
        await this.sendAgent(run, this.initialAgent(event.itemId, slot, true));
      }
      return;
    }
    if (event.type === "item.search_started" && event.itemId) {
      await this.sendProgress(run, event.itemId, 0, false);
      for (const slot of [0, 1] as const) {
        await this.sendAgent(run, {
          ...this.initialAgent(event.itemId, slot, false),
          action: "starting managed browser"
        });
      }
      return;
    }
    if (event.type === "scout.stage_changed" && event.itemId && event.scoutId) {
      const payload = event.payload as { to?: ScoutStage; detail?: string; browserSessionId?: string };
      const current = run.agents.get(event.scoutId) ?? this.initialAgent(event.itemId, this.slot(event.scoutId), false);
      const stage = payload.to ? this.stageIndex(payload.to, current.stage) : current.stage;
      const next: WebsiteAgent = {
        ...current,
        stage,
        action: payload.detail ?? (payload.browserSessionId ? "managed browser connected" : current.action),
        queued: false,
        ...(payload.browserSessionId
          ? { liveStreamUrl: this.capabilities.issue(event.activityId, event.scoutId) }
          : {})
      };
      await this.sendAgent(run, next);
      if (payload.to === "discovering") await this.advanceProgress(run, event.itemId, 0);
      if (payload.to === "analyzing") await this.advanceProgress(run, event.itemId, 1);
      return;
    }
    if (event.type === "candidate.accepted" && event.itemId) {
      await this.advanceProgress(run, event.itemId, 2);
      return;
    }
    if (event.type === "scout.browser_session_ended" && event.itemId && event.scoutId) {
      this.capabilities.revokeScout(event.scoutId);
      const current = run.agents.get(event.scoutId);
      if (current) {
        const { liveStreamUrl: _removed, ...withoutStream } = current;
        await this.sendAgent(run, { ...withoutStream, action: "browser session closed" });
      }
      return;
    }
    if (event.type === "comparison.started" && event.itemId) {
      await this.sendPairStage(run, event.itemId, 3, "comparing persisted candidates");
      await this.sendProgress(run, event.itemId, 3, false);
      return;
    }
    if (event.type === "item.selected" && event.itemId) {
      await this.sendPairStage(run, event.itemId, 4, "selected best compliant listing");
      await this.sendProgress(run, event.itemId, 4, false);
      return;
    }
    if (event.type === "item.rejected" && event.itemId) {
      const payload = event.payload as { discoveryRestarted?: boolean };
      run.reSearchedItems.add(event.itemId);
      run.shortlistSent = false;
      if (!payload.discoveryRestarted) await this.sendShortlist(run);
      return;
    }
    if (event.type === "activity.awaiting_confirmation") {
      await this.sendShortlist(run);
      return;
    }
    if ((event.type === "activity.failed" || event.type === "item.failed") && !run.failedSent) {
      run.failedSent = true;
      await this.enqueue(run, {
        type: "run.failed",
        message: event.type === "item.failed"
          ? `Scout discovery failed for item ${event.itemId ?? "unknown"}.`
          : "Scout discovery failed before a complete shortlist was available."
      });
    }
  }

  private async advanceProgress(run: RunBridge, itemId: string, requested: StageIndex): Promise<void> {
    const current = run.progress.get(itemId) ?? { stage: 0 as StageIndex, queued: false };
    const allowed = (current.stage === 0 && requested === 1)
      || (current.stage === 1 && requested === 2)
      || (current.stage === 2 && requested === 0);
    if (allowed) await this.sendProgress(run, itemId, requested, false);
  }

  private async sendProgress(run: RunBridge, itemId: string, stage: StageIndex, queued: boolean): Promise<void> {
    const current = run.progress.get(itemId);
    if (current?.stage === stage && current.queued === queued) return;
    const previousStage = current?.stage ?? stage;
    run.progress.set(itemId, { stage, queued });
    await this.enqueue(run, { type: "item.progress", progress: { itemId, stage, previousStage, queued } });
  }

  private async sendPairStage(run: RunBridge, itemId: string, stage: StageIndex, action: string): Promise<void> {
    for (const slot of [0, 1] as const) {
      const agentId = `scout-${itemId}-${slot === 0 ? "a" : "b"}`;
      const current = run.agents.get(agentId) ?? this.initialAgent(itemId, slot, false);
      await this.sendAgent(run, { ...current, stage, action, queued: false });
    }
  }

  private async sendAgent(run: RunBridge, agent: WebsiteAgent): Promise<void> {
    run.agents.set(agent.agentId, agent);
    await this.enqueue(run, { type: "agent.update", agent });
  }

  private initialAgent(itemId: string, slot: 0 | 1, queued: boolean): WebsiteAgent {
    return {
      agentId: `scout-${itemId}-${slot === 0 ? "a" : "b"}`,
      itemId,
      slot,
      url: slot === 0 ? "marketplace search" : "specialist search",
      stage: 0,
      action: queued ? "queued for an AgentCore browser slot" : "discovering listings",
      queued
    };
  }

  private slot(scoutId: string): 0 | 1 {
    return scoutId.endsWith("-b") ? 1 : 0;
  }

  private stageIndex(stage: ScoutStage, fallback: StageIndex): StageIndex {
    if (stage === "discovering") return 0;
    if (stage === "analyzing") return 1;
    if (stage === "gathering") return 2;
    if (stage === "comparing") return 3;
    if (stage === "selected") return 4;
    return fallback;
  }

  private async sendShortlist(run: RunBridge): Promise<void> {
    if (run.shortlistSent) return;
    const activity = await this.coordinator.get(run.request.activityId);
    if (!activity.items.every((item) => item.status === "selected" || item.status === "confirmed")) {
      if (!run.failedSent && activity.items.some((item) => item.status === "failed")) {
        run.failedSent = true;
        await this.enqueue(run, { type: "run.failed", message: "A complete shortlist could not be produced for every item." });
      }
      return;
    }
    const shortlist = activity.items.map((item): WebsiteShortlistPick => {
      const selected = item.rankedCandidates.find((candidate) => candidate.id === item.selectedCandidateId);
      if (!selected) throw new Error(`Selected candidate is missing for ${item.request.itemId}`);
      const alternates = item.rankedCandidates
        .filter((candidate) => candidate.eligible && candidate.id !== selected.id)
        .slice(0, 10)
        .map((candidate) => this.listing(candidate));
      return {
        itemId: item.request.itemId,
        listing: this.listing(selected),
        reSearched: run.reSearchedItems.has(item.request.itemId),
        ...(alternates.length > 0 ? { alternates } : {})
      };
    });
    run.shortlistSent = true;
    await this.enqueue(run, { type: "shortlist.ready", shortlist });
  }

  private listing(candidate: Candidate & { scores?: { authenticity: number; confidence: number } }): WebsiteListing {
    const amountMinor = Math.max(1, candidate.amountMinor);
    const rating = candidate.ratingAvg === undefined
      ? "No review data"
      : `${candidate.ratingAvg.toFixed(1)}/5${candidate.reviewCount === undefined ? "" : ` · ${candidate.reviewCount} reviews`}`;
    const evidence = candidate.scores
      ? `Authenticity ${candidate.scores.authenticity.toFixed(0)}/100; confidence ${Math.round(candidate.scores.confidence * 100)}%.`
      : "Matches the locked specification and passed Scout safety checks.";
    return {
      title: candidate.title,
      seller: candidate.seller,
      rating,
      price: `S$${(amountMinor / 100).toFixed(2)}`,
      amountMinor,
      why: evidence,
      url: candidate.url
    };
  }

  private async enqueue(run: RunBridge, payload: WebsiteCallback): Promise<void> {
    const stored: StoredCallback = {
      id: randomUUID(),
      body: JSON.stringify(payload),
      attempts: 0,
      delivered: false
    };
    // The exact serialized callback is stored before its first transmission and
    // reused byte-for-byte for every retry.
    run.outbox.push(stored);
    const requestFetch = this.options.fetch ?? fetch;
    const delays = this.options.retryDelaysMs ?? [0, 250, 1_000];
    for (const delayMs of delays) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      stored.attempts += 1;
      try {
        const response = await requestFetch(run.callback.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(run.callback.token ? { authorization: `Bearer ${run.callback.token}` } : {})
          },
          body: stored.body,
          signal: AbortSignal.timeout(10_000)
        });
        if (response.ok) {
          stored.delivered = true;
          return;
        }
      } catch {
        // Retry below with the stored bytes. Callback delivery never changes
        // persisted Scout discovery state.
      }
    }
  }
}

export function toScoutRequest(request: WebsiteSearchRequest): StartScoutRunRequest {
  return {
    activityId: request.activityId,
    items: request.items.map((item) => {
      const clarifications = request.clarifications
        .filter((clarification) => clarification.itemId === item.id && clarification.chosen)
        .map((clarification) => [clarification.prompt, clarification.chosen!] as const);
      const cap = item.budget.match(/(?:S\$|SGD)?\s*([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1];
      return {
        itemId: item.id,
        name: item.name,
        specs: Object.fromEntries([
          ["lockedSpecification", item.spec],
          ...(item.category ? [["category", item.category] as const] : []),
          ...clarifications
        ]),
        quantity: 1,
        ...(cap ? { priceCapSGD: Number(cap) } : {}),
        rankingPreset: "best_overall" as const,
        shipToCountry: "SG",
        locale: "en-SG"
      };
    })
  };
}
