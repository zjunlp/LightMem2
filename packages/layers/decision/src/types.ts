import type { ApiFamily, RuntimeTurnContext } from "@ecoclaw/kernel";

export const ROUTING_TIERS = ["simple", "standard", "complex", "reasoning"] as const;
export type RoutingTier = (typeof ROUTING_TIERS)[number];

export type RoutingFeatures = {
  apiFamily: ApiFamily;
  promptChars: number;
  promptWords: number;
  hasCodeIntent: boolean;
  hasReasoningIntent: boolean;
  hasToolIntent: boolean;
  segmentCount: number;
  stableSegmentCount: number;
};

export type RoutingDecision = {
  tier: RoutingTier;
  reason: string;
  score?: number;
  confidence?: number;
  provider?: string;
  model?: string;
  fallbackModels?: string[];
  metadata?: Record<string, unknown>;
};

export type TierRouteConfig = {
  provider?: string;
  model?: string;
  fallbackModels?: string[];
};

export type LlmRouter = {
  resolve(ctx: RuntimeTurnContext, features: RoutingFeatures): Promise<RoutingDecision> | RoutingDecision;
};

export type TaskRouterConfig = {
  enabled?: boolean;
  defaultTier?: RoutingTier;
  smallTaskTokenBudget?: number;
  router?: LlmRouter | ((ctx: RuntimeTurnContext, features: RoutingFeatures) => Promise<RoutingDecision> | RoutingDecision);
  tierRoutes?: Partial<Record<RoutingTier, TierRouteConfig>>;
};
