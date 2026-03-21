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

export type PersistedSessionMeta = {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  apiFamily?: ApiFamily;
  lastStatus?: "ok" | "error";
  turnCount: number;
};

export type DecisionConfidenceLevel = "low" | "medium" | "high";

export type DecisionEvidence = {
  source: string;
  key: string;
  value: string | number | boolean;
};

export type DecisionRecord = {
  module: string;
  decision: string;
  reason: string;
  confidence: number;
  confidenceLevel: DecisionConfidenceLevel;
  apiFamily: ApiFamily;
  evidence: DecisionEvidence[];
  at: string;
  metadata?: Record<string, unknown>;
};
