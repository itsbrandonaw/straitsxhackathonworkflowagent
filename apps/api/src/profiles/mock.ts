import {
  EventHub,
  InMemoryActivityStore,
  InMemorySnapshotStore,
  LocalUnavailableLiveViewProvider,
  MockScoutDriver,
  ResilientScoutDriver,
  ScoutCoordinator
} from "@happy/runtime";
import type { AppDependencies } from "../dependencies.js";

export function createMockDependencies(): AppDependencies {
  const events = new EventHub();
  return {
    events,
    info: {
      mode: "mock", browser: "synthetic", extraction: "fixture", persistence: "memory", imagery: "snapshots"
    },
    coordinator: new ScoutCoordinator({
      store: new InMemoryActivityStore(),
      publisher: events,
      driver: new ResilientScoutDriver(new MockScoutDriver(200)),
      snapshots: new InMemorySnapshotStore(),
      liveView: new LocalUnavailableLiveViewProvider(),
      maxConcurrentItems: 5
    })
  };
}
