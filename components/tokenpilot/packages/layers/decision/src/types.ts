import type { ApiFamily, RuntimeTurnContext } from "@tokenpilot/kernel";
import type {
  DeltaInputMode,
  DeltaView,
  SessionTaskRegistry,
  SessionTaskRegistryPatch,
  TaskLifecycle,
} from "@tokenpilot/history";

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

export type {
  ReductionDecision,
  ReductionInstruction,
  ReductionStrategy,
} from "@tokenpilot/reduction";

// ============================================================================
// Eviction Decision Types
// ============================================================================

/**
 * Eviction policy families. These are placeholders for future implementations.
 */
export type EvictionPolicy =
  | "noop"
  | "lru"
  | "lfu"
  | "gdsf"
  | "model_scored"
  | (string & {});

/**
 * Logical cache block used by eviction planning.
 */
export type EvictionBlock = {
  id: string;
  messageIds: string[];
  blockType: string;
  chars: number;
  approxTokens: number;
  recencyRank?: number;
  frequency?: number;
  regenerationCost?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Instruction for a single eviction operation.
 */
export type EvictionInstruction = {
  blockId: string;
  confidence: number;
  priority: number;
  rationale: string;
  estimatedSavedChars: number;
  parameters?: Record<string, unknown>;
};

/**
 * Decision output from Policy to Eviction module.
 */
export type EvictionDecision = {
  enabled: boolean;
  policy: EvictionPolicy;
  blocks: EvictionBlock[];
  instructions: EvictionInstruction[];
  estimatedSavedChars: number;
  notes?: string[];
};

// ============================================================================
// Task State Estimation Types
// ============================================================================

export type TaskStateTransition = {
  taskId: string;
  from?: TaskLifecycle;
  to: TaskLifecycle;
  rationale: string;
};

export type TaskStateEstimatorInput = {
  registry: SessionTaskRegistry;
  delta: DeltaView;
};

export type TaskStateEstimatorApiConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
  batchTurns?: number;
  evictionLookaheadTurns?: number;
  completedSummaryMaxRawTurns?: number;
  inputMode?: DeltaInputMode;
  lifecycleMode?: "coupled" | "decoupled";
  evidenceMode?: "three_state" | "two_state";
  evictionPromotionPolicy?: "fifo";
  evictionPromotionHotTailSize?: number;
};

export type SemanticTaskUpdate = {
  taskId: string;
  title?: string;
  objective: string;
  lifecycle: TaskLifecycle;
  coveredTurnAbsIds?: string[];
  completionEvidence?: string[];
  unresolvedQuestions?: string[];
  currentSubgoal?: string;
  evictableReason?: string;
};

export type TaskStateEstimatorOutput = {
  baseVersion: number;
  taskUpdates: SemanticTaskUpdate[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  };
};

export type TaskStateEstimator = {
  estimate(
    input: TaskStateEstimatorInput,
  ): Promise<TaskStateEstimatorOutput> | TaskStateEstimatorOutput;
};
