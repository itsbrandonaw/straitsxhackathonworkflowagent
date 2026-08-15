import type { ScoutDriver, ScoutRunContext } from "./ports.js";
import type { BrowserSessionProvider, CandidateExtractor, SearchSource } from "./ports.js";
import { assertSafePublicUrl, canonicalizeListingUrl } from "@happy/core";

export class BrowserScoutDriver implements ScoutDriver {
  constructor(private readonly options: {
    sessions: BrowserSessionProvider;
    search: SearchSource;
    extractor: CandidateExtractor;
    candidatesPerScout?: number;
    navigationTimeoutMs?: number;
    heartbeatMs?: number;
  }) {}

  async run(context: ScoutRunContext): Promise<void> {
    const target = Math.min(3, Math.max(1, this.options.candidatesPerScout ?? 2));
    const session = await this.options.sessions.start({
      activityId: context.activityId,
      itemId: context.item.itemId,
      scoutId: context.scout.id,
      locale: context.item.locale
    });
    await context.callbacks.onBrowserSession(session.id);
    const observability = new AbortController();
    const screenshot = this.serialScreenshot(() => session.page.screenshot());
    const heartbeat = this.runMilestoneHeartbeat(screenshot, context, observability.signal);
    const liveFrames = this.runLiveFrames(screenshot, context, observability.signal);

    try {
      await context.callbacks.onStage("discovering", `Searching with ${context.scout.strategy}`);
      const discovered = await this.options.search.discover({
        item: context.item,
        strategy: context.scout.strategy,
        attempt: context.itemAttempt,
        page: session.page
      });
      await this.captureMilestone(screenshot(), context);

      const urls = [...new Set(discovered)].flatMap((value) => {
        try {
          return [canonicalizeListingUrl(assertSafePublicUrl(value).toString())];
        } catch {
          return [];
        }
      });
      if (urls.length === 0) throw new Error("No safe merchant listing links were discovered");

      let gathered = 0;
      for (const [index, url] of urls.entries()) {
        if (gathered >= target) break;
        if (context.signal.aborted) throw new DOMException("Scout cancelled", "AbortError");
        if (index > 0) await context.callbacks.onStage("discovering", `Opening candidate ${index + 1}`);

        try {
          await session.page.goto(url, this.options.navigationTimeoutMs ?? 30_000);
          await this.captureMilestone(screenshot(), context);
          await context.callbacks.onStage("analyzing", `Checking ${new URL(url).hostname}`);
          const pageText = await session.page.text(20_000);
          const candidate = await this.options.extractor.extract({
            activityId: context.activityId,
            item: context.item,
            scout: context.scout,
            canonicalUrl: url,
            untrustedPageText: pageText
          });
          await context.callbacks.onStage("gathering", `Saving candidate ${gathered + 1}`);
          const accepted = await context.callbacks.onCandidate(candidate);
          if (accepted) gathered += 1;
          await this.captureMilestone(screenshot(), context);
        } catch (error) {
          if (context.signal.aborted) throw error;
          if (index < urls.length - 1) {
            await context.callbacks.onStage("discovering", `Candidate failed: ${this.safeError(error)}`);
          }
        }
      }

      if (gathered < 1) throw new Error("No candidate pages could be extracted");
    } finally {
      observability.abort();
      await Promise.allSettled([heartbeat, liveFrames]);
      await this.options.sessions.stop(session).catch(() => undefined);
    }
  }

  private async captureMilestone(
    screenshot: Promise<Uint8Array>,
    context: ScoutRunContext
  ): Promise<void> {
    try {
      const bytes = await screenshot;
      const operations: Array<Promise<unknown>> = [context.callbacks.onScreenshot(bytes, "image/jpeg")];
      if ((context.callbacks.requestedLiveFrameFps?.() ?? 0) > 0 && context.callbacks.onLiveFrame) {
        operations.push(context.callbacks.onLiveFrame(bytes, "image/jpeg"));
      }
      await Promise.allSettled(operations);
    } catch {
      // Browser imagery is independent from Scout success.
    }
  }

  private async runMilestoneHeartbeat(
    screenshot: () => Promise<Uint8Array>,
    context: ScoutRunContext,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      if (!await this.wait(this.options.heartbeatMs ?? 5_000, signal)) return;
      await this.captureMilestone(screenshot(), context);
    }
  }

  private async runLiveFrames(
    screenshot: () => Promise<Uint8Array>,
    context: ScoutRunContext,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      const fps = Math.max(0, context.callbacks.requestedLiveFrameFps?.() ?? 0);
      if (fps === 0 || !context.callbacks.onLiveFrame) {
        if (!await this.wait(500, signal)) return;
        continue;
      }
      try {
        await context.callbacks.onLiveFrame(await screenshot(), "image/jpeg");
      } catch {
        // Ephemeral imagery is independent from Scout success.
      }
      if (!await this.wait(Math.max(100, 1_000 / fps), signal)) return;
    }
  }

  private serialScreenshot(capture: () => Promise<Uint8Array>): () => Promise<Uint8Array> {
    let previous: Promise<unknown> = Promise.resolve();
    return () => {
      const next = previous.catch(() => undefined).then(capture);
      previous = next;
      return next;
    };
  }

  private wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve(true);
      }, milliseconds);
      const abort = () => {
        clearTimeout(timeout);
        resolve(false);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n\t]+/g, " ").slice(0, 160);
  }
}
