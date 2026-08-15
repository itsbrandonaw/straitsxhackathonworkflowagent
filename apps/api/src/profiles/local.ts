import { resolve } from "node:path";
import {
  FileSnapshotStore,
  FixtureCandidateExtractor,
  LocalDiskActivityStore,
  LocalLiveViewProvider,
  LocalPlaywrightBrowserSessions,
  OllamaCandidateExtractor,
  PublicSearchPageSource
} from "@happy/local";
import {
  BrowserScoutDriver,
  EventHub,
  ResilientScoutDriver,
  ScoutCoordinator,
  type CandidateExtractor
} from "@happy/runtime";
import type { AppDependencies } from "../dependencies.js";

const integer = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
};

export async function createLocalAgentDependencies(environment: NodeJS.ProcessEnv): Promise<AppDependencies> {
  const maxConcurrentItems = integer(environment.MAX_CONCURRENT_ITEMS, 2, "MAX_CONCURRENT_ITEMS");
  if (maxConcurrentItems < 1 || maxConcurrentItems > 5) {
    throw new Error("MAX_CONCURRENT_ITEMS must be between 1 and 5");
  }
  const extractionMode = environment.LOCAL_EXTRACTION_MODE ?? "ollama";
  let extractor: CandidateExtractor;
  if (extractionMode === "fixture") {
    if (environment.NODE_ENV === "production") throw new Error("Fixture extraction is disabled in production");
    extractor = new FixtureCandidateExtractor();
  } else if (extractionMode === "ollama") {
    const ollama = new OllamaCandidateExtractor({
      baseUrl: environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
      model: environment.OLLAMA_MODEL ?? "replace-with-installed-local-model"
    });
    await ollama.checkHealth();
    extractor = ollama;
  } else {
    throw new Error(`Unsupported LOCAL_EXTRACTION_MODE: ${extractionMode}`);
  }

  const dataDir = resolve(environment.LOCAL_DATA_DIR ?? ".happy-data");
  const snapshots = new FileSnapshotStore(dataDir);
  await snapshots.cleanup();
  const sessions = new LocalPlaywrightBrowserSessions({
    headless: environment.LOCAL_BROWSER_HEADLESS !== "false"
  });
  const events = new EventHub();
  const driver = new BrowserScoutDriver({
    sessions,
    search: new PublicSearchPageSource(),
    extractor,
    candidatesPerScout: 2
  });
  return {
    events,
    info: {
      mode: "local",
      browser: "playwright",
      extraction: extractionMode,
      persistence: "local_disk"
    },
    coordinator: new ScoutCoordinator({
      store: new LocalDiskActivityStore(dataDir),
      publisher: events,
      driver: new ResilientScoutDriver(driver, { backupAttempts: 2, timeoutMs: 360_000 }),
      snapshots,
      liveView: new LocalLiveViewProvider(environment.PUBLIC_API_URL ?? "http://localhost:3001"),
      maxConcurrentItems
    }),
    shutdown: () => sessions.close()
  };
}
