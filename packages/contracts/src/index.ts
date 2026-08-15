import { z } from "zod";

export const RankingPresetSchema = z.enum([
  "best_overall",
  "lowest_price",
  "trusted_seller",
  "best_reviewed"
]);
export type RankingPreset = z.infer<typeof RankingPresetSchema>;

export const ItemSearchRequestSchema = z.object({
  itemId: z.string().min(1),
  name: z.string().min(1),
  specs: z.record(z.string(), z.string()),
  quantity: z.number().int().positive().default(1),
  priceCapSGD: z.number().positive().optional(),
  rankingPreset: RankingPresetSchema.default("best_overall"),
  shipToCountry: z.string().length(2).default("SG"),
  locale: z.string().min(2).default("en-SG")
});
export type ItemSearchRequest = z.infer<typeof ItemSearchRequestSchema>;

export const StartScoutRunRequestSchema = z.object({
  activityId: z.string().min(1),
  items: z.array(ItemSearchRequestSchema).min(1).max(50)
}).superRefine(({ items }, context) => {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.itemId)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate itemId: ${item.itemId}`,
        path: ["items"]
      });
    }
    ids.add(item.itemId);
  }
});
export type StartScoutRunRequest = z.infer<typeof StartScoutRunRequestSchema>;

export const ScoutStageSchema = z.enum([
  "queued",
  "pending",
  "discovering",
  "analyzing",
  "gathering",
  "comparing",
  "selected",
  "failed",
  "cancelled"
]);
export type ScoutStage = z.infer<typeof ScoutStageSchema>;

export const ScoutStrategySchema = z.enum(["broad_mainstream", "specialist_independent"]);
export type ScoutStrategy = z.infer<typeof ScoutStrategySchema>;

export const ItemStatusSchema = z.enum([
  "queued",
  "searching",
  "comparing",
  "selected",
  "confirmed",
  "failed",
  "cancelled"
]);
export type ItemStatus = z.infer<typeof ItemStatusSchema>;

export const ActivityStatusSchema = z.enum([
  "searching",
  "paused",
  "awaiting_confirmation",
  "ready_for_closer",
  "failed",
  "cancelled"
]);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const RedFlagSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  description: z.string().min(1),
  penalty: z.number().min(0).max(100)
});
export type RedFlag = z.infer<typeof RedFlagSchema>;

export const CandidateSchema = z.object({
  id: z.string().min(1),
  activityId: z.string().min(1),
  itemId: z.string().min(1),
  scoutId: z.string().min(1),
  url: z.url(),
  canonicalUrl: z.url(),
  merchant: z.string().min(1),
  seller: z.string().min(1),
  title: z.string().min(1),
  variant: z.string().min(1),
  quantity: z.number().int().positive(),
  priceSGD: z.number().nonnegative(),
  shippingSGD: z.number().nonnegative().optional(),
  totalPriceSGD: z.number().nonnegative(),
  currency: z.literal("SGD"),
  inStock: z.boolean(),
  shipsToCountry: z.boolean(),
  specMatch: z.boolean(),
  specMismatches: z.array(z.string()),
  ratingAvg: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  reviewSentiment: z.number().min(-1).max(1).default(0),
  sellerReputation: z.number().min(0).max(100),
  listingConsistency: z.number().min(0).max(100),
  externalCorroboration: z.number().min(0).max(100),
  redFlags: z.array(RedFlagSchema),
  evidenceCompleteness: z.number().min(0).max(1),
  source: z.string().min(1),
  discoveredAt: z.iso.datetime(),
  merchantPaymentEligible: z.boolean().default(true)
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const CandidateScoresSchema = z.object({
  price: z.number().min(0).max(100),
  authenticity: z.number().min(0).max(100),
  reviews: z.number().min(0).max(100),
  overall: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1)
});
export type CandidateScores = z.infer<typeof CandidateScoresSchema>;

export type RankedCandidate = Candidate & {
  eligible: boolean;
  ineligibilityReasons: string[];
  scores: CandidateScores;
  rank?: number;
};

export type ScoutRecord = {
  id: string;
  itemId: string;
  strategy: ScoutStrategy;
  stage: ScoutStage;
  attempt: number;
  listingsGathered: number;
  browserSessionId?: string;
  snapshotKey?: string;
  detail?: string;
  error?: string;
};

export type ItemRecord = {
  request: ItemSearchRequest;
  status: ItemStatus;
  attempt: number;
  scouts: [ScoutRecord, ScoutRecord];
  candidates: Candidate[];
  rankedCandidates: RankedCandidate[];
  selectedCandidateId?: string;
  rejectedCandidateIds: string[];
  lowCoverage: boolean;
  error?: string;
};

export type ActivityRecord = {
  id: string;
  idempotencyKey: string;
  status: ActivityStatus;
  version: number;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  items: ItemRecord[];
};

export const ActivityEventTypeSchema = z.enum([
  "activity.started",
  "activity.paused",
  "activity.resumed",
  "activity.cancelled",
  "activity.awaiting_confirmation",
  "activity.ready_for_closer",
  "activity.failed",
  "item.queued",
  "item.search_started",
  "item.selected",
  "item.confirmed",
  "item.rejected",
  "item.failed",
  "scout.started",
  "scout.stage_changed",
  "scout.snapshot_ready",
  "scout.failed",
  "candidate.accepted",
  "candidate.rejected",
  "comparison.started",
  "comparison.completed"
]);
export type ActivityEventType = z.infer<typeof ActivityEventTypeSchema>;

export type ActivityEvent<T = unknown> = {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  type: ActivityEventType;
  activityId: string;
  itemId?: string;
  scoutId?: string;
  attempt: number;
  timestamp: string;
  payload: T;
};

export const ConfirmScoutRunRequestSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1)
});

export const RejectItemRequestSchema = z.object({
  reason: z.string().max(1000).optional()
});

export type CloserHandoff = {
  activityId: string;
  selections: Array<{ itemId: string; url: string }>;
};

export const LIVE_FRAME_PROTOCOL = "happy.scout-jpeg.v1" as const;
export const LiveFrameViewSchema = z.enum(["collapsed", "expanded"]);
export type LiveFrameView = z.infer<typeof LiveFrameViewSchema>;

const LiveFrameStatusBaseSchema = z.object({
  schemaVersion: z.literal(1),
  scoutId: z.string().min(1),
  view: LiveFrameViewSchema
});

export const LiveFrameStatusMessageSchema = z.discriminatedUnion("type", [
  LiveFrameStatusBaseSchema.extend({
    type: z.literal("ready"),
    framesPerSecond: z.number().nonnegative()
  }),
  LiveFrameStatusBaseSchema.extend({
    type: z.literal("rate_changed"),
    framesPerSecond: z.number().nonnegative()
  }),
  LiveFrameStatusBaseSchema.extend({
    type: z.literal("completed"),
    framesPerSecond: z.literal(0)
  }),
  z.object({
    schemaVersion: z.literal(1),
    type: z.literal("error"),
    scoutId: z.string().min(1),
    view: z.string().optional(),
    error: z.string().min(1)
  })
]);
export type LiveFrameStatusMessage = z.infer<typeof LiveFrameStatusMessageSchema>;
