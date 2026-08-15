import type { ScoutStage } from "@happy/contracts";

const transitions: Record<ScoutStage, ReadonlySet<ScoutStage>> = {
  queued: new Set(["pending", "cancelled"]),
  pending: new Set(["discovering", "failed", "cancelled"]),
  discovering: new Set(["analyzing", "failed", "cancelled"]),
  analyzing: new Set(["gathering", "discovering", "failed", "cancelled"]),
  gathering: new Set(["discovering", "comparing", "failed", "cancelled"]),
  comparing: new Set(["selected", "failed", "cancelled"]),
  selected: new Set(["discovering"]),
  failed: new Set(["pending", "discovering"]),
  cancelled: new Set()
};

export function canTransitionScout(from: ScoutStage, to: ScoutStage): boolean {
  return from === to || transitions[from].has(to);
}

export function assertScoutTransition(from: ScoutStage, to: ScoutStage): void {
  if (!canTransitionScout(from, to)) {
    throw new Error(`Invalid Scout transition: ${from} -> ${to}`);
  }
}
