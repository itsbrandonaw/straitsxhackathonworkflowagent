import { createHash } from "node:crypto";
import type { CandidateExtractor } from "@happy/runtime";
import type { Candidate } from "@happy/contracts";
import { CandidateSchema } from "@happy/contracts";

const stableNumber = (seed: string, minimum: number, maximum: number): number => {
  const hash = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return minimum + (hash % (maximum - minimum + 1));
};

export class FixtureCandidateExtractor implements CandidateExtractor {
  async extract(input: Parameters<CandidateExtractor["extract"]>[0]): Promise<Candidate> {
    const seed = `${input.activityId}:${input.scout.id}:${input.canonicalUrl}`;
    const price = stableNumber(seed, 20, 150);
    const merchant = new URL(input.canonicalUrl).hostname;
    return CandidateSchema.parse({
      id: `fixture-${createHash("sha1").update(seed).digest("hex").slice(0, 20)}`,
      activityId: input.activityId,
      itemId: input.item.itemId,
      scoutId: input.scout.id,
      url: input.canonicalUrl,
      canonicalUrl: input.canonicalUrl,
      merchant,
      seller: merchant,
      title: `${input.item.name} browser fixture`,
      variant: Object.values(input.item.specs).join(", ") || "standard",
      quantity: input.item.quantity,
      priceSGD: price,
      shippingSGD: 0,
      totalPriceSGD: price,
      currency: "SGD",
      inStock: true,
      shipsToCountry: true,
      specMatch: true,
      specMismatches: [],
      ratingAvg: 4.2,
      reviewCount: 50,
      reviewSentiment: 0.3,
      sellerReputation: 75,
      listingConsistency: 75,
      externalCorroboration: 65,
      redFlags: [],
      evidenceCompleteness: 0.65,
      source: `${input.scout.strategy}:fixture`,
      discoveredAt: new Date().toISOString(),
      merchantPaymentEligible: true
    });
  }
}
