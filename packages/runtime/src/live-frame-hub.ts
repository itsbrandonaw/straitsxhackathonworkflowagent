import { randomUUID } from "node:crypto";
import type {
  LiveFrame,
  LiveFrameChannel,
  LiveFrameListener,
  LiveFrameSubscription,
  LiveFrameView
} from "./ports.js";

type Viewer = {
  id: string;
  view: LiveFrameView;
  listener: LiveFrameListener;
  lastRate: number;
};

type ScoutViewers = {
  viewers: Map<string, Viewer>;
  latest?: LiveFrame;
  lastPublishedAt?: number;
  completed: boolean;
};

export type LiveFrameHubOptions = {
  collapsedFps?: number;
  expandedFps?: number;
  maxScoutFps?: number;
  globalFpsBudget?: number;
};

const finitePositive = (value: number, name: string): number => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
};

export class InMemoryLiveFrameHub implements LiveFrameChannel {
  private readonly scouts = new Map<string, ScoutViewers>();
  private allocations = new Map<string, number>();
  private readonly collapsedFps: number;
  private readonly expandedFps: number;
  private readonly maxScoutFps: number;
  private readonly globalFpsBudget: number;

  constructor(options: LiveFrameHubOptions = {}) {
    this.collapsedFps = finitePositive(options.collapsedFps ?? 0.5, "collapsedFps");
    this.expandedFps = finitePositive(options.expandedFps ?? 3, "expandedFps");
    this.maxScoutFps = finitePositive(options.maxScoutFps ?? 3, "maxScoutFps");
    this.globalFpsBudget = finitePositive(options.globalFpsBudget ?? 12, "globalFpsBudget");
  }

  subscribe(scoutId: string, view: LiveFrameView, listener: LiveFrameListener): LiveFrameSubscription {
    const state: ScoutViewers = this.scouts.get(scoutId) ?? { viewers: new Map(), completed: false };
    this.scouts.set(scoutId, state);
    const id = randomUUID();
    const viewer: Viewer = { id, view, listener, lastRate: -1 };
    state.viewers.set(id, viewer);
    this.recalculate();
    if (state.latest) this.safe(() => listener.onFrame(state.latest!));
    if (state.completed) this.safe(() => listener.onStatus?.("completed"));

    let active = true;
    return {
      id,
      framesPerSecond: () => this.requestedFps(scoutId),
      unsubscribe: () => {
        if (!active) return;
        active = false;
        const current = this.scouts.get(scoutId);
        current?.viewers.delete(id);
        if (current && current.viewers.size === 0) {
          delete current.latest;
          delete current.lastPublishedAt;
          this.scouts.delete(scoutId);
        }
        this.recalculate();
      }
    };
  }

  requestedFps(scoutId: string): number {
    return this.allocations.get(scoutId) ?? 0;
  }

  async publish(frame: LiveFrame): Promise<void> {
    const state = this.scouts.get(frame.scoutId);
    if (!state || state.completed || state.viewers.size === 0) return;
    const fps = this.requestedFps(frame.scoutId);
    if (fps <= 0) return;
    const now = Date.now();
    if (state.lastPublishedAt !== undefined && now - state.lastPublishedAt < 1_000 / fps) return;
    state.lastPublishedAt = now;
    state.latest = frame;
    for (const viewer of state.viewers.values()) {
      this.safe(() => viewer.listener.onFrame(frame));
    }
  }

  complete(scoutId: string): void {
    const state = this.scouts.get(scoutId);
    if (!state) return;
    state.completed = true;
    delete state.latest;
    delete state.lastPublishedAt;
    for (const viewer of state.viewers.values()) {
      this.safe(() => viewer.listener.onStatus?.("completed"));
    }
    this.recalculate();
  }

  close(): void {
    for (const state of this.scouts.values()) {
      for (const viewer of state.viewers.values()) {
        this.safe(() => viewer.listener.onStatus?.("completed"));
      }
    }
    this.scouts.clear();
    this.allocations.clear();
  }

  private recalculate(): void {
    const requested = new Map<string, number>();
    for (const [scoutId, state] of this.scouts) {
      if (state.completed || state.viewers.size === 0) continue;
      const highest = Math.max(...[...state.viewers.values()].map((viewer) =>
        viewer.view === "expanded" ? this.expandedFps : this.collapsedFps));
      requested.set(scoutId, Math.min(highest, this.maxScoutFps));
    }

    const total = [...requested.values()].reduce((sum, value) => sum + value, 0);
    const allocations = new Map<string, number>();
    if (total <= this.globalFpsBudget) {
      for (const [scoutId, demand] of requested) allocations.set(scoutId, demand);
    } else {
      const count = requested.size;
      const minimumPerScout = Math.min(this.collapsedFps, this.globalFpsBudget / Math.max(1, count));
      const minimumTotal = minimumPerScout * count;
      const extraBudget = Math.max(0, this.globalFpsBudget - minimumTotal);
      const totalExtraDemand = [...requested.values()]
        .reduce((sum, demand) => sum + Math.max(0, demand - minimumPerScout), 0);
      for (const [scoutId, demand] of requested) {
        const extraDemand = Math.max(0, demand - minimumPerScout);
        const extra = totalExtraDemand === 0 ? 0 : extraBudget * extraDemand / totalExtraDemand;
        allocations.set(scoutId, Math.min(demand, minimumPerScout + extra));
      }
    }
    this.allocations = allocations;

    for (const [scoutId, state] of this.scouts) {
      const rate = allocations.get(scoutId) ?? 0;
      for (const viewer of state.viewers.values()) {
        if (Math.abs(viewer.lastRate - rate) < 0.001) continue;
        viewer.lastRate = rate;
        this.safe(() => viewer.listener.onRateChanged?.(rate));
      }
    }
  }

  private safe(operation: () => void): void {
    try {
      operation();
    } catch {
      // A viewer failure is non-fatal and cannot interrupt Scout work or other viewers.
    }
  }
}
