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
  InMemoryLiveFrameHub,
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

const positiveNumber = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be greater than zero`);
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
  const jpegQuality = integer(environment.LIVE_FRAME_JPEG_QUALITY, 60, "LIVE_FRAME_JPEG_QUALITY");
  if (jpegQuality < 1 || jpegQuality > 100) throw new Error("LIVE_FRAME_JPEG_QUALITY must be between 1 and 100");
  const sessions = new LocalPlaywrightBrowserSessions({
    headless: environment.LOCAL_BROWSER_HEADLESS !== "false",
    jpegQuality
  });
  const frames = new InMemoryLiveFrameHub({
    collapsedFps: positiveNumber(environment.LIVE_FRAME_COLLAPSED_FPS, 0.5, "LIVE_FRAME_COLLAPSED_FPS"),
    expandedFps: positiveNumber(environment.LIVE_FRAME_EXPANDED_FPS, 3, "LIVE_FRAME_EXPANDED_FPS"),
    maxScoutFps: positiveNumber(environment.LIVE_FRAME_MAX_SCOUT_FPS, 3, "LIVE_FRAME_MAX_SCOUT_FPS"),
    globalFpsBudget: positiveNumber(environment.LIVE_FRAME_GLOBAL_FPS_BUDGET, 12, "LIVE_FRAME_GLOBAL_FPS_BUDGET")
  });
  const frameMaxBufferedBytes = integer(
    environment.LIVE_FRAME_MAX_BUFFERED_BYTES,
    1_048_576,
    "LIVE_FRAME_MAX_BUFFERED_BYTES"
  );
  if (frameMaxBufferedBytes < 65_536) throw new Error("LIVE_FRAME_MAX_BUFFERED_BYTES must be at least 65536");
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
      persistence: "local_disk",
      imagery: "binary_websocket"
    },
    frames,
    frameMaxBufferedBytes,
    coordinator: new ScoutCoordinator({
      store: new LocalDiskActivityStore(dataDir),
      publisher: events,
      driver: new ResilientScoutDriver(driver, { backupAttempts: 2, timeoutMs: 360_000 }),
      snapshots,
      liveView: new LocalLiveViewProvider(environment.PUBLIC_API_URL ?? "http://localhost:3001"),
      liveFrames: frames,
      maxConcurrentItems
    }),
    shutdown: async () => {
      frames.close();
      await sessions.close();
    }
  };
}
