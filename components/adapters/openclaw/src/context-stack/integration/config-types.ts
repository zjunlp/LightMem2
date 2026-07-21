export type PluginHostConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  stateDir?: string;
  debugTapProviderTraffic?: boolean;
  debugTapPath?: string;
  proxyAutostart?: boolean;
  proxyPort?: number;
  proxyMode?: { pureForward?: boolean };
  hooks?: {
    beforeToolCall?: boolean;
    toolResultPersist?: boolean;
    dynamicContextTarget?: "developer" | "user";
  };
  contextEngine?: {
    enabled?: boolean;
    pruneThresholdChars?: number;
    keepRecentToolResults?: number;
    placeholder?: string;
  };
  ux?: {
    details?: boolean;
  };
};

export type TokenPilotMethodConfig = {
  modules?: {
    stabilizer?: boolean;
    policy?: boolean;
    reduction?: boolean;
    eviction?: boolean;
  };
  eviction?: {
    enabled?: boolean;
    policy?: "noop" | "lru" | "lfu" | "gdsf" | "model_scored";
    maxCandidateBlocks?: number;
    minBlockChars?: number;
    replacementMode?: "pointer_stub" | "drop";
  };
  taskStateEstimator?: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    requestTimeoutMs?: number;
    batchTurns?: number;
    evictionLookaheadTurns?: number;
    completedSummaryMaxRawTurns?: number;
    inputMode?: "sliding_window" | "completed_summary_plus_active_turns";
    lifecycleMode?: "coupled" | "decoupled";
    evidenceMode?: "three_state" | "two_state";
    evictionPromotionPolicy?: "fifo";
    evictionPromotionHotTailSize?: number;
  };
  memory?: {
    enabled?: boolean;
    autoDistill?: boolean;
    distillerType?: "prompting" | "autoskill" | "ctx2skill";
    batchSize?: number;
    topK?: number;
    injectAsSystemHint?: boolean;
    distillProvider?: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      requestTimeoutMs?: number;
    };
    embedding?: {
      enabled?: boolean;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      queryInstruction?: string;
    };
  };
  reduction?: {
    engine?: "layered";
    triggerMinChars?: number;
    maxToolChars?: number;
    passes?: {
      readStateCompaction?: boolean;
      toolPayloadTrim?: boolean;
      htmlSlimming?: boolean;
      execOutputTruncation?: boolean;
      agentsStartupOptimization?: boolean;
      formatSlimming?: boolean;
      formatCleaning?: boolean;
      pathTruncation?: boolean;
      imageDownsample?: boolean;
      lineNumberStrip?: boolean;
    };
    passOptions?: Record<string, Record<string, unknown> | undefined>;
  };
};

export type PluginRuntimeConfig = PluginHostConfig & TokenPilotMethodConfig;

export type NormalizedModuleEnablement = {
  stabilizer: boolean;
  reduction: boolean;
  eviction: boolean;
};

export type NormalizedPluginHostConfig =
  Required<Omit<PluginHostConfig, "proxyBaseUrl" | "proxyApiKey">>
  & Pick<PluginHostConfig, "proxyBaseUrl" | "proxyApiKey">;

export type NormalizedTokenPilotMethodConfig = Required<TokenPilotMethodConfig>;

export type NormalizedPluginRuntimeConfig =
  NormalizedPluginHostConfig
  & NormalizedTokenPilotMethodConfig
  & { moduleEnablement: NormalizedModuleEnablement };

export type PluginLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export function safeId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const norm = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return norm || "main";
}

export function extractPathLike(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value.path ?? value.file_path ?? value.filePath;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
