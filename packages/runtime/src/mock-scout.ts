import { createHash } from "node:crypto";
import type { Candidate, ScoutStrategy } from "@happy/contracts";
import { canonicalizeListingUrl } from "@happy/core";
import type { ScoutDriver, ScoutRunContext } from "./ports.js";

const merchants: Record<ScoutStrategy, string[]> = {
  broad_mainstream: ["Happy Market", "Everyday Electronics", "Big Retail"],
  specialist_independent: ["Specialist Supply", "Independent Tech", "Category Expert"]
};

const delay = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) throw new DOMException("Scout cancelled", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Scout cancelled", "AbortError"));
    }, { once: true });
  });
};

function stableNumber(seed: string, minimum: number, maximum: number): number {
  const hash = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return minimum + (hash % (maximum - minimum + 1));
}

function screenshotSvg(scoutId: string, item: string, stage: string, url?: string): Uint8Array {
  const escaped = [scoutId, item, stage, url ?? "Searching the web"]
    .map((value) => value.replace(/[&<>"']/g, ""));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520"><rect width="100%" height="100%" fill="#f7f8f6"/><rect x="0" y="0" width="900" height="48" fill="#edf0eb"/><circle cx="24" cy="24" r="7" fill="#27c98b"/><text x="45" y="30" font-family="monospace" font-size="16" fill="#20332c">${escaped[3]}</text><text x="42" y="145" font-family="sans-serif" font-size="30" fill="#10261e">${escaped[1]}</text><text x="42" y="195" font-family="monospace" font-size="20" fill="#377c64">${escaped[2]}</text><text x="42" y="440" font-family="monospace" font-size="16" fill="#718078">${escaped[0]}</text></svg>`;
  return new TextEncoder().encode(svg);
}

export class MockScoutDriver implements ScoutDriver {
  constructor(private readonly actionDelayMs = 20, private readonly candidatesPerScout = 2) {}

  async run(context: ScoutRunContext): Promise<void> {
    const count = Math.min(3, Math.max(1, this.candidatesPerScout));
    for (let index = 0; index < count; index += 1) {
      await context.callbacks.onStage("discovering", `Searching source ${index + 1}`);
      await delay(this.actionDelayMs, context.signal);
      const merchant = merchants[context.scout.strategy][index] ?? merchants[context.scout.strategy][0]!;
      const slug = `${context.item.name}-${context.scout.strategy}-${context.itemAttempt}-${index + 1}`
        .toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const url = canonicalizeListingUrl(`https://example.com/shop/${slug}?utm_source=mock`);
      await context.callbacks.onScreenshot(
        screenshotSvg(context.scout.id, context.item.name, "Discovering", url),
        "image/svg+xml"
      );
      await context.callbacks.onStage("analyzing", `Checking ${merchant}`);
      await delay(this.actionDelayMs, context.signal);
      const seed = `${context.activityId}:${context.scout.id}:${context.itemAttempt}:${index}`;
      const price = stableNumber(seed, 20, 95);
      const candidate: Candidate = {
        id: `candidate-${createHash("sha1").update(seed).digest("hex").slice(0, 16)}`,
        activityId: context.activityId,
        itemId: context.item.itemId,
        scoutId: context.scout.id,
        url,
        canonicalUrl: url,
        merchant,
        seller: merchant,
        title: `${context.item.name} option ${index + 1}`,
        variant: Object.values(context.item.specs).join(", ") || "standard",
        quantity: context.item.quantity,
        priceSGD: price,
        priceMinor: price * 100,
        shippingSGD: index % 2 === 0 ? 0 : 4,
        shippingMinor: index % 2 === 0 ? 0 : 400,
        totalPriceSGD: price + (index % 2 === 0 ? 0 : 4),
        amountMinor: (price + (index % 2 === 0 ? 0 : 4)) * 100,
        currency: "SGD",
        inStock: true,
        shipsToCountry: true,
        specMatch: true,
        specMismatches: [],
        ratingAvg: stableNumber(`${seed}:rating`, 38, 49) / 10,
        reviewCount: stableNumber(`${seed}:reviews`, 12, 900),
        reviewSentiment: stableNumber(`${seed}:sentiment`, 2, 9) / 10,
        sellerReputation: stableNumber(`${seed}:seller`, 65, 98),
        listingConsistency: stableNumber(`${seed}:listing`, 65, 98),
        externalCorroboration: stableNumber(`${seed}:external`, 55, 95),
        redFlags: [],
        evidenceCompleteness: stableNumber(`${seed}:evidence`, 75, 98) / 100,
        source: context.scout.strategy,
        discoveredAt: new Date().toISOString(),
        merchantPaymentEligible: true
      };
      await context.callbacks.onCandidate(candidate);
      await context.callbacks.onStage("gathering", `Saved candidate ${index + 1}`);
      await context.callbacks.onScreenshot(
        screenshotSvg(context.scout.id, context.item.name, "Gathering", url),
        "image/svg+xml"
      );
      await delay(this.actionDelayMs, context.signal);
    }
  }
}
