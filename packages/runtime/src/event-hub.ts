import type { ActivityEvent } from "@happy/contracts";
import type { EventPublisher } from "./ports.js";

type Listener = (event: ActivityEvent) => void;

export class EventHub implements EventPublisher {
  private readonly listeners = new Map<string, Set<Listener>>();

  async publish(event: ActivityEvent): Promise<void> {
    for (const listener of this.listeners.get(event.activityId) ?? []) listener(event);
  }

  subscribe(activityId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(activityId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(activityId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(activityId);
    };
  }
}
