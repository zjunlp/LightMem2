import type {
  DeltaInputMode,
  DeltaView,
  SessionTaskRegistry,
  TaskLifecycle,
} from "@tokenpilot/history";

export type EvictionPolicy = "noop" | "lru" | "lfu" | "gdsf" | "model_scored" | (string & {});

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

export type EvictionInstruction = {
  blockId: string;
  confidence: number;
  priority: number;
  rationale: string;
  estimatedSavedChars: number;
  parameters?: Record<string, unknown>;
};

export type EvictionDecision = {
  enabled: boolean;
  policy: EvictionPolicy;
  blocks: EvictionBlock[];
  instructions: EvictionInstruction[];
  estimatedSavedChars: number;
  notes?: string[];
};

export type TaskStateTransition = {
  taskId: string;
  from?: TaskLifecycle;
  to: TaskLifecycle;
  rationale: string;
};

export type TaskStateEstimatorInput = { registry: SessionTaskRegistry; delta: DeltaView };

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
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd?: number };
};

export type TaskStateEstimator = {
  estimate(input: TaskStateEstimatorInput): Promise<TaskStateEstimatorOutput> | TaskStateEstimatorOutput;
};
