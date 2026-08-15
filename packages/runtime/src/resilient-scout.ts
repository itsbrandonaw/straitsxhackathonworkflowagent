import type { ScoutDriver, ScoutRunContext } from "./ports.js";

export class ResilientScoutDriver implements ScoutDriver {
  constructor(private readonly inner: ScoutDriver, private readonly options: {
    backupAttempts?: number;
    timeoutMs?: number;
  } = {}) {}

  async run(context: ScoutRunContext): Promise<void> {
    const attempts = 1 + (this.options.backupAttempts ?? 2);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 360_000);
      const signal = AbortSignal.any([context.signal, timeoutSignal]);
      try {
        if (attempt > 1) {
          await context.callbacks.onStage("discovering", `Trying backup source strategy ${attempt - 1}`);
        }
        await this.inner.run({ ...context, itemAttempt: context.itemAttempt + attempt - 1, signal });
        return;
      } catch (error) {
        if (context.signal.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
