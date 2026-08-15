import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { assertSafePublicUrl } from "@happy/core";
import type { BrowserPage, BrowserSessionHandle, BrowserSessionProvider } from "@happy/runtime";

type LocalHandle = BrowserSessionHandle & { context: BrowserContext };

class PlaywrightPageAdapter implements BrowserPage {
  constructor(
    private readonly page: Page,
    private readonly safety: NetworkSafety,
    private readonly jpegQuality: number
  ) {}

  async goto(value: string, timeoutMs = 30_000): Promise<void> {
    const url = await this.safety.assert(value);
    await this.page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }

  async links(): Promise<string[]> {
    return this.page.locator("a[href]").evaluateAll((anchors) => anchors
      .slice(0, 500)
      .map((anchor) => (anchor as HTMLAnchorElement).href)
      .filter(Boolean));
  }

  async text(maxCharacters: number): Promise<string> {
    const text = await this.page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
    return text.slice(0, maxCharacters);
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ type: "jpeg", quality: this.jpegQuality });
  }

  async url(): Promise<string> {
    return this.page.url();
  }
}

class NetworkSafety {
  private readonly cache = new Map<string, Promise<URL>>();

  assert(value: string): Promise<URL> {
    const parsed = assertSafePublicUrl(value);
    const key = `${parsed.protocol}//${parsed.hostname}`;
    const existing = this.cache.get(key);
    if (existing) return existing.then(() => parsed);
    const verification = this.verifyHost(parsed);
    this.cache.set(key, verification);
    return verification.then(() => parsed);
  }

  private async verifyHost(url: URL): Promise<URL> {
    const records = await lookup(url.hostname, { all: true, verbatim: true });
    if (records.length === 0) throw new Error(`Hostname did not resolve: ${url.hostname}`);
    for (const record of records) {
      const host = record.family === 6 ? `[${record.address}]` : record.address;
      assertSafePublicUrl(`${url.protocol}//${host}/`);
    }
    return url;
  }
}

export class LocalPlaywrightBrowserSessions implements BrowserSessionProvider {
  private browser: Browser | undefined;
  private readonly sessions = new Map<string, LocalHandle>();
  private readonly safety = new NetworkSafety();

  constructor(private readonly options: { headless?: boolean; jpegQuality?: number } = {}) {
    const quality = options.jpegQuality ?? 60;
    if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
      throw new Error("jpegQuality must be an integer between 1 and 100");
    }
  }

  async start(input: {
    activityId: string;
    itemId: string;
    scoutId: string;
    locale: string;
  }): Promise<BrowserSessionHandle> {
    const browser = await this.requireBrowser();
    const context = await browser.newContext({
      acceptDownloads: false,
      locale: input.locale,
      viewport: { width: 1280, height: 720 }
    });
    await context.route("**/*", async (route) => {
      try {
        await this.safety.assert(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    const id = `local-${input.scoutId}-${randomUUID()}`;
    const handle: LocalHandle = {
      id,
      context,
      page: new PlaywrightPageAdapter(page, this.safety, this.options.jpegQuality ?? 60)
    };
    this.sessions.set(id, handle);
    return handle;
  }

  async stop(session: BrowserSessionHandle): Promise<void> {
    const local = this.sessions.get(session.id);
    if (!local) return;
    this.sessions.delete(session.id);
    await local.context.close();
  }

  async close(): Promise<void> {
    const active = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(active.map((session) => session.context.close().catch(() => undefined)));
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
  }

  private async requireBrowser(): Promise<Browser> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch({ headless: this.options.headless ?? true });
    }
    return this.browser;
  }
}
