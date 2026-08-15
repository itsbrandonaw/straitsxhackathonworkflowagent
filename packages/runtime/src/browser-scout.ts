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
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    try {
      heartbeat = setInterval(() => {
        void session.page.screenshot()
          .then((bytes) => context.callbacks.onScreenshot(bytes, "image/jpeg"))
          .catch(() => undefined);
      }, this.options.heartbeatMs ?? 5_000);

      await context.callbacks.onStage("discovering", `Searching with ${context.scout.strategy}`);
      const discovered = await this.options.search.discover({
        item: context.item,
        strategy: context.scout.strategy,
        attempt: context.itemAttempt,
        page: session.page
      });
      await this.capture(session.page.screenshot(), context);

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
          await this.capture(session.page.screenshot(), context);
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
          await this.capture(session.page.screenshot(), context);
        } catch (error) {
          if (context.signal.aborted) throw error;
          if (index < urls.length - 1) {
            await context.callbacks.onStage("discovering", `Candidate failed: ${this.safeError(error)}`);
          }
        }
      }

      if (gathered < 1) throw new Error("No candidate pages could be extracted");
    } finally {
      clearInterval(heartbeat);
      await this.options.sessions.stop(session).catch(() => undefined);
    }
  }

  private async capture(
    screenshot: Promise<Uint8Array>,
    context: ScoutRunContext
  ): Promise<void> {
    try {
      await context.callbacks.onScreenshot(await screenshot, "image/jpeg");
    } catch {
      // Browser imagery is independent from Scout success.
    }
  }

  private safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n\t]+/g, " ").slice(0, 160);
  }
}
