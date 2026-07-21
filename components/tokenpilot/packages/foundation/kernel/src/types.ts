export type SessionMode = "single" | "cross";

export const API_FAMILIES = [
  "openai-responses",
  "openai-completions",
  "anthropic-messages",
  "other",
] as const;

export type ApiFamily = (typeof API_FAMILIES)[number];

export type ContextSegment = {
  id: string;
  kind: "stable" | "semi_stable" | "volatile";
  text: string;
  priority: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type RuntimeBudget = {
  maxInputTokens: number;
  reserveOutputTokens: number;
};

export type UsageSnapshot = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cachedTokens?: number;
  cacheHitTokens?: number;
  cacheHitRate?: number;
  providerRaw?: unknown;
};

export type RuntimeTurnTraceStep = {
  stage: "beforeBuild" | "annotatePrompt" | "beforeCall" | "afterCall";
  module: string;
  promptChars: number;
  segmentCount: number;
  responseChars?: number;
  timestamp: string;
};

export type RuntimeTurnTrace = {
  initialContext: RuntimeTurnContext;
  finalContext: RuntimeTurnContext;
  moduleSteps: RuntimeTurnTraceStep[];
  requestDetail?: {
    renderedPromptText: string;
    segments: Array<{
      id: string;
      kind: "stable" | "semi_stable" | "volatile";
      priority: number;
      source?: string;
      text: string;
      metadata?: Record<string, unknown>;
    }>;
    metadata?: Record<string, unknown>;
  };
  scheduling?: {
    scheduler?: string;
    scheduleId: string;
    reason?: string;
    metadata?: Record<string, unknown>;
    availableModules: string[];
    activeModules: string[];
  };
  usageRaw?: unknown;
  usageNormalized?: UsageSnapshot;
  responsePreview: string;
};

export type RuntimeTurnContext = {
  sessionId: string;
  sessionMode: SessionMode;
  provider: string;
  model: string;
  apiFamily?: ApiFamily;
  prompt: string;
  segments: ContextSegment[];
  budget: RuntimeBudget;
  metadata?: Record<string, unknown>;
};

export type RuntimeTurnResult = {
  content: string;
  usage?: UsageSnapshot;
  metadata?: Record<string, unknown>;
};

export type PersistedTurnRecord = {
  turnId: string;
  sessionId: string;
  provider: string;
  model: string;
  apiFamily?: ApiFamily;
  prompt: string;
  segments: ContextSegment[];
  usage?: UsageSnapshot;
  responsePreview: string;
  response?: string;
  trace?: RuntimeTurnTrace;
  resultMetadata?: Record<string, unknown>;
  startedAt: string;
  endedAt: string;
  status: "ok" | "error";
  error?: string;
};

export type PersistedMessageRole = "system" | "user" | "assistant" | "tool" | "context";

export type PersistedMessageOrigin =
  | "provider_observed"
  | "synthetic_materialized"
  | "manual_edit"
  | "derived_artifact";

export type PersistedMessageKind =
  | "message"
  | "summary"
  | "checkpoint_seed"
  | "reduction"
  | "context_snapshot"
  | (string & {});

export type PersistedMessageRecord = {
  messageId: string;
  sessionId: string;
  branchId: string;
  parentMessageId?: string;
  turnId?: string;
  role: PersistedMessageRole;
  kind: PersistedMessageKind;
  origin: PersistedMessageOrigin;
  content: string;
  createdAt: string;
  source?: string;
  replacesMessageIds?: string[];
  derivedFromArtifactId?: string;
  metadata?: Record<string, unknown>;
};

export type PersistedBranchRecord = {
  branchId: string;
  sessionId: string;
  parentBranchId?: string;
  forkedFromMessageId?: string;
  headMessageId?: string;
  createdAt: string;
  source: string;
  metadata?: Record<string, unknown>;
};

export type PersistedSessionMeta = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  apiFamily?: ApiFamily;
  lastStatus?: "ok" | "error";
  turnCount: number;
  messageCount?: number;
  branchCount?: number;
};
