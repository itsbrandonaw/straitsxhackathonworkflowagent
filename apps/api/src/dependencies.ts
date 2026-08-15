import type { RuntimeInfo } from "@happy/runtime";
import type { EventHub, LiveFrameChannel, ScoutCoordinator } from "@happy/runtime";
import { createMockDependencies } from "./profiles/mock.js";
import { createLocalAgentDependencies } from "./profiles/local.js";

export type AppDependencies = {
  coordinator: ScoutCoordinator;
  events: EventHub;
  frames?: LiveFrameChannel;
  frameMaxBufferedBytes?: number;
  info: RuntimeInfo;
  shutdown?: () => Promise<void>;
};

export async function createDependenciesFromEnv(
  environment: NodeJS.ProcessEnv = process.env
): Promise<AppDependencies> {
  const mode = environment.SCOUT_MODE ?? "mock";
  if (mode === "mock") return createMockDependencies();
  if (mode === "local") return createLocalAgentDependencies(environment);
  if (mode === "aws") {
    throw new Error("SCOUT_MODE=aws runs through apps/agentcore; the local HTTP API supports mock or local");
  }
  throw new Error(`Unsupported SCOUT_MODE: ${mode}`);
}
