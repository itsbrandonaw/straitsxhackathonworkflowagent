import type {
  Candidate,
  CandidateScores,
  ItemSearchRequest,
  RankedCandidate,
  RankingPreset
} from "@happy/contracts";

const weights: Record<RankingPreset, { price: number; authenticity: number; reviews: number }> = {
  best_overall: { price: 0.4, authenticity: 0.35, reviews: 0.25 },
  lowest_price: { price: 0.6, authenticity: 0.25, reviews: 0.15 },
  trusted_seller: { price: 0.2, authenticity: 0.55, reviews: 0.25 },
  best_reviewed: { price: 0.2, authenticity: 0.25, reviews: 0.55 }
};

const clamp = (value: number, minimum = 0, maximum = 100): number =>
  Math.min(maximum, Math.max(minimum, value));

export function calculateAuthenticity(candidate: Candidate): number {
  const base = candidate.sellerReputation * 0.5 +
    candidate.listingConsistency * 0.3 + candidate.externalCorroboration * 0.2;
  const penalty = candidate.redFlags.reduce((total, flag) => total + flag.penalty, 0);
  return clamp(base - penalty);
}

export function calculateReviewScore(candidate: Candidate, peerAverageStars: number): number {
  if (candidate.ratingAvg === undefined || candidate.reviewCount === undefined) return 40;
  const prior = 50;
  const adjustedStars = (candidate.reviewCount / (candidate.reviewCount + prior)) * candidate.ratingAvg +
    (prior / (candidate.reviewCount + prior)) * peerAverageStars;
  return clamp((adjustedStars / 5) * 100 + candidate.reviewSentiment * 10);
}

function ineligibilityReasons(candidate: Candidate, item: ItemSearchRequest, authenticity: number): string[] {
  const reasons: string[] = [];
  if (!candidate.specMatch || candidate.specMismatches.length > 0) reasons.push("specification_mismatch");
  if (item.priceCapSGD !== undefined && candidate.totalPriceSGD > item.priceCapSGD) reasons.push("over_budget");
  if (candidate.quantity !== item.quantity) reasons.push("incorrect_quantity");
  if (!candidate.inStock) reasons.push("out_of_stock");
  if (!candidate.shipsToCountry) reasons.push("cannot_ship");
  if (!candidate.merchantPaymentEligible) reasons.push("merchant_payment_ineligible");
  if (candidate.redFlags.some((flag) => flag.severity === "critical")) reasons.push("critical_red_flag");
  if (authenticity < 50) reasons.push("authenticity_below_threshold");
  return reasons;
}

export type ComparisonResult = {
  ranked: RankedCandidate[];
  selected: RankedCandidate | undefined;
  lowCoverage: boolean;
};

export function compareCandidates(item: ItemSearchRequest, candidates: Candidate[]): ComparisonResult {
  const validTotals = candidates.map((candidate) => candidate.totalPriceSGD).filter((price) => price > 0);
  const lowestTotal = Math.min(...validTotals);
  const ratings = candidates.flatMap((candidate) => candidate.ratingAvg === undefined ? [] : [candidate.ratingAvg]);
  const peerAverageStars = ratings.length === 0 ? 3.5 : ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;
  const presetWeights = weights[item.rankingPreset];
  const sourceCount = new Set(candidates.map((candidate) => candidate.source)).size;

  const ranked = candidates.map<RankedCandidate>((candidate) => {
    const authenticity = calculateAuthenticity(candidate);
    const price = Number.isFinite(lowestTotal) && candidate.totalPriceSGD > 0
      ? clamp(100 * lowestTotal / candidate.totalPriceSGD)
      : 0;
    const reviews = calculateReviewScore(candidate, peerAverageStars);
    const reasons = ineligibilityReasons(candidate, item, authenticity);
    const coverage = clamp(candidates.length / 3, 0, 1);
    const diversity = clamp(sourceCount / 2, 0, 1);
    const confidence = clamp(
      candidate.evidenceCompleteness * 0.6 + coverage * 0.25 + diversity * 0.15,
      0,
      1
    );
    const scores: CandidateScores = {
      price,
      authenticity,
      reviews,
      overall: clamp(price * presetWeights.price + authenticity * presetWeights.authenticity + reviews * presetWeights.reviews),
      confidence
    };
    return { ...candidate, eligible: reasons.length === 0, ineligibilityReasons: reasons, scores };
  }).sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
    if (right.scores.overall !== left.scores.overall) return right.scores.overall - left.scores.overall;
    if (right.scores.confidence !== left.scores.confidence) return right.scores.confidence - left.scores.confidence;
    if (left.totalPriceSGD !== right.totalPriceSGD) return left.totalPriceSGD - right.totalPriceSGD;
    return left.canonicalUrl.localeCompare(right.canonicalUrl);
  }).map((candidate, index) => ({ ...candidate, rank: index + 1 }));

  return {
    ranked,
    selected: ranked.find((candidate) => candidate.eligible),
    lowCoverage: candidates.length < 3 || sourceCount < 2
  };
}
