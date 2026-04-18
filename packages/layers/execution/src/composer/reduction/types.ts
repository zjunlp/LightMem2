import type { ContextSegment, RuntimeTurnContext, RuntimeTurnResult, RuntimeStateStore } from "@ecoclaw/kernel";

export type BuiltinReductionPassId =
  | "tool_payload_trim"
  | "html_slimming"
  | "format_slimming"
  | "semantic_llmlingua2"
  | "exec_output_truncation"
  | "repeated_read_dedup"
  | "format_cleaning"
  | "path_truncation"
  | "image_downsample"
  | "line_number_strip"
  | "agents_startup_optimization";

export type ReductionPassId = BuiltinReductionPassId | (string & {});
export type ReductionPhase = "before_call" | "after_call";

export type ReductionTarget =
  | "result_content"
  | "tool_payload"
  | "structured_payload"
  | "context_segment"
  | (string & {});

export type ReductionPassSpec = {
  id: ReductionPassId;
  enabled?: boolean;
  phase?: ReductionPhase;
  target?: ReductionTarget;
  options?: Record<string, unknown>;
};

export type ReductionBeforeCallContext = {
  turnCtx: RuntimeTurnContext;
  spec: ReductionPassSpec;
  stateStore?: RuntimeStateStore;
};

export type ReductionBeforeCallOutcome = {
  changed: boolean;
  turnCtx?: RuntimeTurnContext;
  note?: string;
  skippedReason?: string;
  metadata?: Record<string, unknown>;
  touchedSegmentIds?: string[];
};

export type ReductionAfterCallContext = {
  turnCtx: RuntimeTurnContext;
  originalResult: RuntimeTurnResult;
  currentResult: RuntimeTurnResult;
  spec: ReductionPassSpec;
};

export type ReductionAfterCallOutcome = {
  changed: boolean;
  result?: RuntimeTurnResult;
  note?: string;
  skippedReason?: string;
  metadata?: Record<string, unknown>;
};

export type ReductionPassHandler = {
  beforeCall?(
    ctx: ReductionBeforeCallContext,
  ): Promise<ReductionBeforeCallOutcome> | ReductionBeforeCallOutcome;
  afterCall?(
    ctx: ReductionAfterCallContext,
  ): Promise<ReductionAfterCallOutcome> | ReductionAfterCallOutcome;
};

export type ReductionPassRegistry = Partial<Record<ReductionPassId, ReductionPassHandler>>;

export type ReductionReportEntry = {
  id: ReductionPassId;
  phase: ReductionPhase;
  target: ReductionTarget;
  changed: boolean;
  note?: string;
  skippedReason?: string;
  beforeChars: number;
  afterChars: number;
  touchedSegmentIds?: string[];
};

export type ReductionPassBreakdownEntry = {
  id: ReductionPassId;
  phase: ReductionPhase;
  target: ReductionTarget;
  order: number;
  changed: boolean;
  skippedReason?: string;
  note?: string;
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  savingsRatio: number;
  cumulativeSavedChars: number;
  touchedSegmentIds?: string[];
};

export type ReductionSummary = {
  beforeChars: number;
  afterChars: number;
  savedChars: number;
  savingsRatio: number;
  changedPassCount: number;
  skippedPassCount: number;
  passCount: number;
  topContributor: ReductionPassBreakdownEntry | null;
  passBreakdown: ReductionPassBreakdownEntry[];
  report: ReductionReportEntry[];
};

export type ReductionMetadata = {
  beforeCall?: ReductionReportEntry[];
  afterCall?: ReductionReportEntry[];
  beforeCallSummary?: ReductionSummary;
  afterCallSummary?: ReductionSummary;
};

export type ReductionModuleConfig = {
  passes?: ReductionPassSpec[];
  registry?: ReductionPassRegistry;
  stateStore?: RuntimeStateStore;
  maxToolChars?: number;
  strategy?: "rule" | "llmlingua2";
  passOptions?: Record<string, Record<string, unknown>>;
  semanticLlmlingua2?: SemanticLlmlingua2Config;
};

export type SemanticEmbeddingProviderKind = "local" | "api" | "none";

export type SemanticLlmlingua2EmbeddingConfig = {
  provider?: SemanticEmbeddingProviderKind;
  modelPath?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  apiModel?: string;
  requestTimeoutMs?: number;
};

export type SemanticLlmlingua2Config = {
  enabled?: boolean;
  pythonBin?: string;
  timeoutMs?: number;
  modelPath?: string;
  targetRatio?: number;
  minInputChars?: number;
  minSavedChars?: number;
  preselectRatio?: number;
  maxChunkChars?: number;
  embedding?: SemanticLlmlingua2EmbeddingConfig;
};
