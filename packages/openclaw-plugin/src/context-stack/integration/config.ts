/* eslint-disable @typescript-eslint/no-explicit-any */
import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeModule, RuntimeModuleRuntime } from "../../../../kernel/src/interfaces.js";
import type { RuntimeTurnContext } from "../../../../kernel/src/types.js";
import type { PolicyModuleConfig } from "../../../../layers/decision/src/policy.js";
import { applyPolicyMonitors } from "./runtime-register.js";

export type PluginRuntimeConfig = {
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
  hooks?: { beforeToolCall?: boolean; toolResultPersist?: boolean };
  contextEngine?: {
    enabled?: boolean;
    pruneThresholdChars?: number;
    keepRecentToolResults?: number;
    placeholder?: string;
  };
  modules?: {
    stabilizer?: boolean;
    policy?: boolean;
    reduction?: boolean;
    eviction?: boolean;
  };
  summary?: {
    summaryGenerationMode?: "llm_full_context" | "heuristic";
    summaryMaxOutputTokens?: number;
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
    inputMode?: "sliding_window" | "completed_summary_plus_active_turns";
    lifecycleMode?: "coupled" | "decoupled";
    evictionPromotionPolicy?: "fifo";
    evictionPromotionHotTailSize?: number;
  };
  reduction?: {
    engine?: "layered";
    triggerMinChars?: number;
    maxToolChars?: number;
    passes?: {
      repeatedReadDedup?: boolean;
      toolPayloadTrim?: boolean;
      htmlSlimming?: boolean;
      execOutputTruncation?: boolean;
      agentsStartupOptimization?: boolean;
    };
    passOptions?: Record<string, Record<string, unknown> | undefined>;
  };
};

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

const NULL_RUNTIME: RuntimeModuleRuntime = {
  async callModel() {
    throw new Error("callModel is unavailable during plugin-side before_call optimization");
  },
};

export function normalizeConfig(
  raw: unknown,
): Required<Omit<PluginRuntimeConfig, "proxyBaseUrl" | "proxyApiKey">> & Pick<PluginRuntimeConfig, "proxyBaseUrl" | "proxyApiKey"> {
  const cfg = (raw ?? {}) as PluginRuntimeConfig;
  const defaultStateDir = join(homedir(), ".openclaw", "ecoclaw-plugin-state");
  const stateDir = cfg.stateDir ?? defaultStateDir;
  const modules = cfg.modules ?? {};
  const summary = cfg.summary ?? {};
  const eviction = cfg.eviction ?? {};
  const taskStateEstimator = cfg.taskStateEstimator ?? {};
  const reduction = cfg.reduction ?? {};
  const reductionPasses = reduction.passes ?? {};
  const reductionPassOptions = reduction.passOptions ?? {};
  const hooks = cfg.hooks ?? {};
  const contextEngine = cfg.contextEngine ?? {};
  const proxyMode = cfg.proxyMode ?? {};
  const envTaskStateEstimatorEnabled = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_ENABLED ?? "").trim().toLowerCase();
  const envTaskStateEstimatorBaseUrl = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_BASE_URL ?? "").trim();
  const envTaskStateEstimatorApiKey = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_API_KEY ?? "").trim();
  const envTaskStateEstimatorModel = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_MODEL ?? "").trim();
  const envTaskStateEstimatorTimeoutMs = Number.parseInt(String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_TIMEOUT_MS ?? ""), 10);
  const envTaskStateEstimatorBatchTurns = Number.parseInt(String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_BATCH_TURNS ?? ""), 10);
  const envTaskStateEstimatorEvictionLookaheadTurns = Number.parseInt(String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS ?? ""), 10);
  const envTaskStateEstimatorInputMode = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_INPUT_MODE ?? "").trim();
  const envTaskStateEstimatorLifecycleMode = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE ?? "").trim();
  const envTaskStateEstimatorEvictionPromotionPolicy = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY ?? "").trim();
  const envTaskStateEstimatorEvictionPromotionHotTailSize = Number.parseInt(String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE ?? ""), 10);
  return {
    enabled: cfg.enabled ?? true,
    logLevel: cfg.logLevel ?? "info",
    proxyBaseUrl: cfg.proxyBaseUrl,
    proxyApiKey: cfg.proxyApiKey,
    stateDir,
    debugTapProviderTraffic: cfg.debugTapProviderTraffic ?? false,
    debugTapPath: cfg.debugTapPath ?? join(stateDir, "ecoclaw", "provider-traffic.jsonl"),
    proxyAutostart: cfg.proxyAutostart ?? true,
    proxyPort: Math.max(1025, Math.min(65535, cfg.proxyPort ?? 17667)),
    proxyMode: { pureForward: proxyMode.pureForward ?? false },
    hooks: { beforeToolCall: hooks.beforeToolCall ?? true, toolResultPersist: hooks.toolResultPersist ?? true },
    contextEngine: {
      enabled: contextEngine.enabled ?? true,
      pruneThresholdChars: Math.max(10_000, contextEngine.pruneThresholdChars ?? 100_000),
      keepRecentToolResults: Math.max(0, contextEngine.keepRecentToolResults ?? 5),
      placeholder: typeof contextEngine.placeholder === "string" && contextEngine.placeholder.trim().length > 0 ? contextEngine.placeholder : "[pruned]",
    },
    modules: {
      stabilizer: modules.stabilizer ?? true,
      policy: modules.policy ?? true,
      reduction: modules.reduction ?? true,
      eviction: modules.eviction ?? false,
    },
    summary: {
      summaryGenerationMode: summary.summaryGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      summaryMaxOutputTokens: Math.max(128, Math.min(8192, summary.summaryMaxOutputTokens ?? 1200)),
    },
    eviction: {
      enabled: eviction.enabled ?? false,
      policy: eviction.policy === "lru" || eviction.policy === "lfu" || eviction.policy === "gdsf" || eviction.policy === "model_scored" || eviction.policy === "noop" ? eviction.policy : "noop",
      maxCandidateBlocks: Math.max(1, eviction.maxCandidateBlocks ?? 128),
      minBlockChars: Math.max(0, eviction.minBlockChars ?? 256),
      replacementMode: eviction.replacementMode === "drop" ? "drop" : "pointer_stub",
    },
    taskStateEstimator: {
      enabled: taskStateEstimator.enabled ?? (envTaskStateEstimatorEnabled === "1" || envTaskStateEstimatorEnabled === "true" || envTaskStateEstimatorEnabled === "yes" || envTaskStateEstimatorEnabled === "on"),
      baseUrl: typeof taskStateEstimator.baseUrl === "string" && taskStateEstimator.baseUrl.trim().length > 0 ? taskStateEstimator.baseUrl.replace(/\/+$/, "") : envTaskStateEstimatorBaseUrl ? envTaskStateEstimatorBaseUrl.replace(/\/+$/, "") : undefined,
      apiKey: typeof taskStateEstimator.apiKey === "string" && taskStateEstimator.apiKey.trim().length > 0 ? taskStateEstimator.apiKey.trim() : envTaskStateEstimatorApiKey || undefined,
      model: typeof taskStateEstimator.model === "string" && taskStateEstimator.model.trim().length > 0 ? taskStateEstimator.model.trim() : envTaskStateEstimatorModel || undefined,
      requestTimeoutMs: Math.max(1000, taskStateEstimator.requestTimeoutMs ?? (Number.isFinite(envTaskStateEstimatorTimeoutMs) ? envTaskStateEstimatorTimeoutMs : 60_000)),
      batchTurns: Math.max(1, taskStateEstimator.batchTurns ?? (Number.isFinite(envTaskStateEstimatorBatchTurns) ? envTaskStateEstimatorBatchTurns : 5)),
      evictionLookaheadTurns: Math.max(1, taskStateEstimator.evictionLookaheadTurns ?? (Number.isFinite(envTaskStateEstimatorEvictionLookaheadTurns) ? envTaskStateEstimatorEvictionLookaheadTurns : 3)),
      inputMode: taskStateEstimator.inputMode === "completed_summary_plus_active_turns" ? "completed_summary_plus_active_turns" : envTaskStateEstimatorInputMode === "completed_summary_plus_active_turns" ? "completed_summary_plus_active_turns" : "sliding_window",
      lifecycleMode: taskStateEstimator.lifecycleMode === "decoupled" ? "decoupled" : envTaskStateEstimatorLifecycleMode === "decoupled" ? "decoupled" : "coupled",
      evictionPromotionPolicy: taskStateEstimator.evictionPromotionPolicy === "fifo" ? "fifo" : envTaskStateEstimatorEvictionPromotionPolicy === "fifo" ? "fifo" : "fifo",
      evictionPromotionHotTailSize: Math.max(0, taskStateEstimator.evictionPromotionHotTailSize ?? (Number.isFinite(envTaskStateEstimatorEvictionPromotionHotTailSize) ? envTaskStateEstimatorEvictionPromotionHotTailSize : 1)),
    },
    reduction: {
      engine: "layered" as const,
      triggerMinChars: Math.max(256, reduction.triggerMinChars ?? 2200),
      maxToolChars: Math.max(256, reduction.maxToolChars ?? 1200),
      passes: {
        repeatedReadDedup: reductionPasses.repeatedReadDedup ?? true,
        toolPayloadTrim: reductionPasses.toolPayloadTrim ?? true,
        htmlSlimming: reductionPasses.htmlSlimming ?? true,
        execOutputTruncation: reductionPasses.execOutputTruncation ?? true,
        agentsStartupOptimization: reductionPasses.agentsStartupOptimization ?? true,
      },
      passOptions: {
        repeatedReadDedup: reductionPassOptions.repeatedReadDedup && typeof reductionPassOptions.repeatedReadDedup === "object" ? { ...reductionPassOptions.repeatedReadDedup } : {},
        toolPayloadTrim: reductionPassOptions.toolPayloadTrim && typeof reductionPassOptions.toolPayloadTrim === "object" ? { ...reductionPassOptions.toolPayloadTrim } : {},
        htmlSlimming: reductionPassOptions.htmlSlimming && typeof reductionPassOptions.htmlSlimming === "object" ? { ...reductionPassOptions.htmlSlimming } : {},
        execOutputTruncation: reductionPassOptions.execOutputTruncation && typeof reductionPassOptions.execOutputTruncation === "object" ? { ...reductionPassOptions.execOutputTruncation } : {},
        agentsStartupOptimization: reductionPassOptions.agentsStartupOptimization && typeof reductionPassOptions.agentsStartupOptimization === "object" ? { ...reductionPassOptions.agentsStartupOptimization } : {},
        formatSlimming: reductionPassOptions.formatSlimming && typeof reductionPassOptions.formatSlimming === "object" ? { ...reductionPassOptions.formatSlimming } : {},
        formatCleaning: reductionPassOptions.formatCleaning && typeof reductionPassOptions.formatCleaning === "object" ? { ...reductionPassOptions.formatCleaning } : {},
        pathTruncation: reductionPassOptions.pathTruncation && typeof reductionPassOptions.pathTruncation === "object" ? { ...reductionPassOptions.pathTruncation } : {},
        imageDownsample: reductionPassOptions.imageDownsample && typeof reductionPassOptions.imageDownsample === "object" ? { ...reductionPassOptions.imageDownsample } : {},
        lineNumberStrip: reductionPassOptions.lineNumberStrip && typeof reductionPassOptions.lineNumberStrip === "object" ? { ...reductionPassOptions.lineNumberStrip } : {},
      },
    },
  };
}

export function buildPolicyModuleConfigFromPluginConfig(cfg: ReturnType<typeof normalizeConfig>): PolicyModuleConfig {
  return {
    localityEnabled: true,
    stateDir: cfg.stateDir,
    reductionEnabled: false,
    reductionFormatSlimmingEnabled: false,
    reductionSemanticEnabled: false,
    handoffEnabled: false,
    evictionEnabled: cfg.modules.eviction && cfg.eviction.enabled,
    evictionPolicy: cfg.eviction.policy,
    evictionMinBlockChars: cfg.eviction.minBlockChars,
    taskStateEstimator: cfg.taskStateEstimator.enabled
      ? {
          enabled: true,
          baseUrl: cfg.taskStateEstimator.baseUrl,
          apiKey: cfg.taskStateEstimator.apiKey,
          model: cfg.taskStateEstimator.model,
          requestTimeoutMs: cfg.taskStateEstimator.requestTimeoutMs,
          batchTurns: cfg.taskStateEstimator.batchTurns,
          evictionLookaheadTurns: cfg.taskStateEstimator.evictionLookaheadTurns,
          inputMode: cfg.taskStateEstimator.inputMode,
          lifecycleMode: cfg.taskStateEstimator.lifecycleMode,
          evictionPromotionPolicy: cfg.taskStateEstimator.evictionPromotionPolicy,
          evictionPromotionHotTailSize: cfg.taskStateEstimator.evictionPromotionHotTailSize,
        }
      : { enabled: false },
    summaryGenerationMode: cfg.summary.summaryGenerationMode,
    summaryMaxOutputTokens: cfg.summary.summaryMaxOutputTokens,
    cacheHealthEnabled: false,
  };
}

export async function applyPolicyBeforeCall(
  turnCtx: RuntimeTurnContext,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  modules: { policy?: RuntimeModule } | undefined,
): Promise<{ turnCtx: RuntimeTurnContext; policyChangedSegmentIds: string[] }> {
  let nextCtx = turnCtx;
  const bridgedReductionDecision = asRecord(asRecord(asRecord(nextCtx.metadata?.policy)?.decisions)?.reduction);

  if (cfg.modules.policy && modules?.policy?.beforeBuild) {
    nextCtx = await modules.policy.beforeBuild(nextCtx, NULL_RUNTIME);
    applyPolicyMonitors(nextCtx, logger, asRecord);
    if (bridgedReductionDecision) {
      const policy = asRecord(nextCtx.metadata?.policy) ?? {};
      const decisions = asRecord(policy.decisions) ?? {};
      nextCtx = {
        ...nextCtx,
        metadata: {
          ...(nextCtx.metadata ?? {}),
          policy: { ...policy, decisions: { ...decisions, reduction: bridgedReductionDecision } },
        },
      };
    }
  }

  return { turnCtx: nextCtx, policyChangedSegmentIds: [] };
}
