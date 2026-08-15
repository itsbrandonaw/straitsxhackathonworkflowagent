import type { BrowserPage, SearchSource } from "@happy/runtime";
import type { ItemSearchRequest, ScoutStrategy } from "@happy/contracts";
import { assertSafePublicUrl, canonicalizeListingUrl } from "@happy/core";

const engines = [
  (query: string) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  (query: string) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  (query: string) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
];

const engineHosts = ["google.", "gstatic.com", "bing.com", "microsoft.com", "duckduckgo.com"];
const nonMerchantHosts = [
  "apps.apple.com",
  "play.google.com",
  "duck.ai",
  "wikipedia.org",
  "reddit.com",
  "substack.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "tiktok.com"
];
const challengePatterns = ["captcha", "unusual traffic", "access denied", "verify you are human", "robot check"];
const directMerchants = [
  {
    host: "shopee.sg",
    search: (query: string) => `https://shopee.sg/search?keyword=${encodeURIComponent(query)}`,
    productPath: (path: string) => /(?:\/product\/\d+\/\d+|-i\.\d+\.\d+)/i.test(path)
  },
  {
    host: "lazada.sg",
    search: (query: string) => `https://www.lazada.sg/catalog/?q=${encodeURIComponent(query)}`,
    productPath: (path: string) => /\/products\/.+\.html$/i.test(path)
  },
  {
    host: "amazon.sg",
    search: (query: string) => `https://www.amazon.sg/s?k=${encodeURIComponent(query)}`,
    productPath: (path: string) => /\/(?:dp|gp\/product)\/[A-Z0-9]{8,}/i.test(path)
  }
];

export class PublicSearchPageSource implements SearchSource {
  async discover(input: {
    item: ItemSearchRequest;
    strategy: ScoutStrategy;
    attempt: number;
    page: BrowserPage;
  }): Promise<string[]> {
    const query = this.query(input.item, input.strategy);
    const start = input.strategy === "broad_mainstream" ? 0 : 2;
    const offset = (start + Math.max(1, input.attempt) - 1) % engines.length;
    const failures: string[] = [];

    for (let index = 0; index < engines.length; index += 1) {
      const endpoint = engines[(offset + index) % engines.length]!;
      try {
        await input.page.goto(endpoint(query), 30_000);
        const visibleText = (await input.page.text(4_000)).toLowerCase();
        if (challengePatterns.some((pattern) => visibleText.includes(pattern))) {
          throw new Error("CAPTCHA or access challenge");
        }
        const discovered = this.externalLinks(await input.page.links());
        if (discovered.length > 0) return discovered;
        failures.push(`${new URL(endpoint(query)).hostname}: no merchant links`);
      } catch (error) {
        failures.push(`${new URL(endpoint(query)).hostname}: ${this.safeError(error)}`);
      }
    }

    const merchantOffset = input.strategy === "broad_mainstream" ? 0 : 1;
    for (let index = 0; index < directMerchants.length; index += 1) {
      const merchant = directMerchants[(merchantOffset + index) % directMerchants.length]!;
      try {
        await input.page.goto(merchant.search(query), 30_000);
        const visibleText = (await input.page.text(4_000)).toLowerCase();
        if (challengePatterns.some((pattern) => visibleText.includes(pattern))) {
          throw new Error("CAPTCHA or access challenge");
        }
        const discovered = this.externalLinks(await input.page.links(), (url) =>
          (url.hostname === merchant.host || url.hostname.endsWith(`.${merchant.host}`)) &&
          merchant.productPath(url.pathname));
        if (discovered.length > 0) return discovered;
        failures.push(`${merchant.host}: no product links`);
      } catch (error) {
        failures.push(`${merchant.host}: ${this.safeError(error)}`);
      }
    }
    throw new Error(`Search recovery exhausted (${failures.join("; ")})`);
  }

  private query(item: ItemSearchRequest, strategy: ScoutStrategy): string {
    const specification = Object.values(item.specs).join(" ");
    const strategyTerms = strategy === "broad_mainstream"
      ? "buy price retailer marketplace"
      : "specialist independent seller reviews";
    return `${item.name} ${specification} ${strategyTerms}`.trim();
  }

  private unwrap(value: string): string {
    const url = new URL(value);
    for (const key of ["q", "url", "uddg", "u"]) {
      const nested = url.searchParams.get(key);
      if (nested?.startsWith("http://") || nested?.startsWith("https://")) return nested;
    }
    return value;
  }

  private externalLinks(values: string[], predicate?: (url: URL) => boolean): string[] {
    return [...new Set(values.flatMap((value) => {
      try {
        const url = assertSafePublicUrl(this.unwrap(value));
        if (engineHosts.some((host) => url.hostname.includes(host))) return [];
        if (nonMerchantHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return [];
        if (url.pathname === "/" && url.search.length === 0) return [];
        if (predicate && !predicate(url)) return [];
        return [canonicalizeListingUrl(url.toString())];
      } catch {
        return [];
      }
    }))].slice(0, 12);
  }

  private safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, " ").slice(0, 80);
  }
}

export class FixtureSearchSource implements SearchSource {
  constructor(private readonly urls: string[]) {}

  async discover(): Promise<string[]> {
    return this.urls.map((url) => canonicalizeListingUrl(url));
  }
}
