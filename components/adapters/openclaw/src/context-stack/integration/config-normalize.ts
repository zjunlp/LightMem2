import { defaultPluginStateDir, pluginStateSubdir } from "@lightmem2/artifact-store";
import type {
  NormalizedPluginHostConfig,
  NormalizedPluginRuntimeConfig,
  NormalizedTokenPilotMethodConfig,
  PluginHostConfig,
  PluginRuntimeConfig,
  TokenPilotMethodConfig,
} from "./config-types.js";

function isTruthyEnv(value: string): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envValue(lightmem2Key: string, tokenpilotKey?: string): string {
  const next = String(process.env[lightmem2Key] ?? "").trim();
  if (next) return next;
  return tokenpilotKey ? String(process.env[tokenpilotKey] ?? "").trim() : "";
}

function normalizeHostConfig(raw: PluginHostConfig): NormalizedPluginHostConfig {
  const defaultStateDir = defaultPluginStateDir();
  const stateDir = raw.stateDir ?? defaultStateDir;
  const hooks = raw.hooks ?? {};
  const contextEngine = raw.contextEngine ?? {};
  const proxyMode = raw.proxyMode ?? {};
  const ux = raw.ux ?? {};

  return {
    enabled: raw.enabled ?? true,
    logLevel: raw.logLevel ?? "info",
    proxyBaseUrl: raw.proxyBaseUrl,
    proxyApiKey: raw.proxyApiKey,
    stateDir,
    debugTapProviderTraffic: raw.debugTapProviderTraffic ?? false,
    debugTapPath: raw.debugTapPath ?? pluginStateSubdir(stateDir, "provider-traffic.jsonl"),
    proxyAutostart: raw.proxyAutostart ?? false,
    proxyPort: Math.max(1025, Math.min(65535, raw.proxyPort ?? 17667)),
    proxyMode: { pureForward: proxyMode.pureForward ?? false },
    hooks: {
      beforeToolCall: hooks.beforeToolCall ?? true,
      toolResultPersist: hooks.toolResultPersist ?? false,
      dynamicContextTarget: hooks.dynamicContextTarget === "user" ? "user" : "developer",
    },
    contextEngine: {
      enabled: contextEngine.enabled ?? true,
      pruneThresholdChars: Math.max(10_000, contextEngine.pruneThresholdChars ?? 100_000),
      keepRecentToolResults: Math.max(0, contextEngine.keepRecentToolResults ?? 5),
      placeholder: typeof contextEngine.placeholder === "string" && contextEngine.placeholder.trim().length > 0 ? contextEngine.placeholder : "[pruned]",
    },
    ux: {
      details: ux.details ?? false,
    },
  };
}

function normalizeMethodConfig(
  raw: TokenPilotMethodConfig,
): NormalizedTokenPilotMethodConfig & Pick<NormalizedPluginRuntimeConfig, "moduleEnablement"> {
  const modules = raw.modules ?? {};
  const eviction = raw.eviction ?? {};
  const taskStateEstimator = raw.taskStateEstimator ?? {};
  const reduction = raw.reduction ?? {};
  const memory = raw.memory ?? {};
  const memoryDistillProvider = memory.distillProvider ?? {};
  const memoryEmbedding = memory.embedding ?? {};
  const reductionPasses = reduction.passes ?? {};
  const reductionPassOptions = reduction.passOptions ?? {};

  const envMemoryEmbeddingEnabled = envValue("LIGHTMEM2_MEMORY_EMBEDDING_ENABLED", "TOKENPILOT_MEMORY_EMBEDDING_ENABLED").toLowerCase();
  const envMemoryEmbeddingBaseUrl = envValue("LIGHTMEM2_MEMORY_EMBEDDING_BASE_URL", "TOKENPILOT_MEMORY_EMBEDDING_BASE_URL");
  const envMemoryEmbeddingApiKey = envValue("LIGHTMEM2_MEMORY_EMBEDDING_API_KEY", "TOKENPILOT_MEMORY_EMBEDDING_API_KEY");
  const envMemoryEmbeddingModel = envValue("LIGHTMEM2_MEMORY_EMBEDDING_MODEL", "TOKENPILOT_MEMORY_EMBEDDING_MODEL");
  const envMemoryEmbeddingInstruction = envValue("LIGHTMEM2_MEMORY_EMBEDDING_QUERY_INSTRUCTION", "TOKENPILOT_MEMORY_EMBEDDING_QUERY_INSTRUCTION");

  const envTaskStateEstimatorEnabled = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_ENABLED", "TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED").toLowerCase();
  const envTaskStateEstimatorBaseUrl = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_BASE_URL", "TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL");
  const envTaskStateEstimatorApiKey = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_API_KEY", "TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY");
  const envTaskStateEstimatorModel = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_MODEL", "TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL");
  const envTaskStateEstimatorTimeoutMs = Number.parseInt(envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_TIMEOUT_MS", "TOKENPILOT_TASK_STATE_ESTIMATOR_TIMEOUT_MS"), 10);
  const envTaskStateEstimatorBatchTurns = Number.parseInt(envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_BATCH_TURNS", "TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS"), 10);
  const envTaskStateEstimatorEvictionLookaheadTurns = Number.parseInt(envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS", "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS"), 10);
  const envTaskStateEstimatorCompletedSummaryMaxRawTurns = Number.parseInt(
    envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_COMPLETED_SUMMARY_MAX_RAW_TURNS", "TOKENPILOT_TASK_STATE_ESTIMATOR_COMPLETED_SUMMARY_MAX_RAW_TURNS"),
    10,
  );
  const envTaskStateEstimatorInputMode = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_INPUT_MODE", "TOKENPILOT_TASK_STATE_ESTIMATOR_INPUT_MODE");
  const envTaskStateEstimatorLifecycleMode = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE", "TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE");
  const envTaskStateEstimatorEvidenceMode = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_EVIDENCE_MODE", "TOKENPILOT_TASK_STATE_ESTIMATOR_EVIDENCE_MODE");
  const envTaskStateEstimatorEvictionPromotionPolicy = envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY", "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY");
  const envTaskStateEstimatorEvictionPromotionHotTailSize = Number.parseInt(envValue("LIGHTMEM2_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE", "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE"), 10);

  const normalizedEvidenceMode =
    taskStateEstimator.evidenceMode === "two_state" || envTaskStateEstimatorEvidenceMode === "two_state"
      ? "two_state"
      : "three_state";
  const normalizedModules = {
    stabilizer: modules.stabilizer ?? true,
    policy: modules.policy ?? true,
    reduction: modules.reduction ?? true,
    eviction: modules.eviction ?? false,
  };
  const normalizedEvictionEnabled = eviction.enabled ?? false;

  return {
    modules: normalizedModules,
    moduleEnablement: {
      stabilizer: normalizedModules.stabilizer,
      reduction: normalizedModules.reduction,
      eviction: normalizedModules.eviction && normalizedEvictionEnabled,
    },
    eviction: {
      enabled: normalizedEvictionEnabled,
      policy: eviction.policy === "lru" || eviction.policy === "lfu" || eviction.policy === "gdsf" || eviction.policy === "model_scored" || eviction.policy === "noop" ? eviction.policy : "noop",
      maxCandidateBlocks: Math.max(1, eviction.maxCandidateBlocks ?? 128),
      minBlockChars: Math.max(0, eviction.minBlockChars ?? 256),
      replacementMode: normalizedEvidenceMode === "two_state" ? "drop" : eviction.replacementMode === "drop" ? "drop" : "pointer_stub",
    },
    taskStateEstimator: {
      enabled: taskStateEstimator.enabled ?? isTruthyEnv(envTaskStateEstimatorEnabled),
      baseUrl: typeof taskStateEstimator.baseUrl === "string" && taskStateEstimator.baseUrl.trim().length > 0 ? taskStateEstimator.baseUrl.replace(/\/+$/, "") : envTaskStateEstimatorBaseUrl ? envTaskStateEstimatorBaseUrl.replace(/\/+$/, "") : undefined,
      apiKey: typeof taskStateEstimator.apiKey === "string" && taskStateEstimator.apiKey.trim().length > 0 ? taskStateEstimator.apiKey.trim() : envTaskStateEstimatorApiKey || undefined,
      model: typeof taskStateEstimator.model === "string" && taskStateEstimator.model.trim().length > 0 ? taskStateEstimator.model.trim() : envTaskStateEstimatorModel || undefined,
      requestTimeoutMs: Math.max(1000, taskStateEstimator.requestTimeoutMs ?? (Number.isFinite(envTaskStateEstimatorTimeoutMs) ? envTaskStateEstimatorTimeoutMs : 60_000)),
      batchTurns: Math.max(1, taskStateEstimator.batchTurns ?? (Number.isFinite(envTaskStateEstimatorBatchTurns) ? envTaskStateEstimatorBatchTurns : 5)),
      evictionLookaheadTurns: Math.max(1, taskStateEstimator.evictionLookaheadTurns ?? (Number.isFinite(envTaskStateEstimatorEvictionLookaheadTurns) ? envTaskStateEstimatorEvictionLookaheadTurns : 3)),
      completedSummaryMaxRawTurns: Math.max(
        0,
        taskStateEstimator.completedSummaryMaxRawTurns
          ?? (Number.isFinite(envTaskStateEstimatorCompletedSummaryMaxRawTurns)
            ? envTaskStateEstimatorCompletedSummaryMaxRawTurns
            : 0),
      ),
      inputMode: taskStateEstimator.inputMode === "sliding_window"
        ? "sliding_window"
        : envTaskStateEstimatorInputMode === "sliding_window"
          ? "sliding_window"
          : "completed_summary_plus_active_turns",
      lifecycleMode: taskStateEstimator.lifecycleMode === "decoupled" ? "decoupled" : envTaskStateEstimatorLifecycleMode === "decoupled" ? "decoupled" : "coupled",
      evidenceMode: normalizedEvidenceMode,
      evictionPromotionPolicy: taskStateEstimator.evictionPromotionPolicy === "fifo" ? "fifo" : envTaskStateEstimatorEvictionPromotionPolicy === "fifo" ? "fifo" : "fifo",
      evictionPromotionHotTailSize:
        normalizedEvidenceMode === "two_state"
          ? 0
          : Math.max(0, taskStateEstimator.evictionPromotionHotTailSize ?? (Number.isFinite(envTaskStateEstimatorEvictionPromotionHotTailSize) ? envTaskStateEstimatorEvictionPromotionHotTailSize : 1)),
    },
    memory: {
      enabled: memory.enabled ?? false,
      autoDistill: memory.autoDistill ?? false,
      distillerType:
        memory.distillerType === "autoskill" || memory.distillerType === "ctx2skill"
          ? memory.distillerType
          : "prompting",
      batchSize: Math.max(1, memory.batchSize ?? 2),
      topK: Math.max(0, memory.topK ?? 0),
      injectAsSystemHint: memory.injectAsSystemHint ?? false,
      distillProvider: {
        baseUrl:
          typeof memoryDistillProvider.baseUrl === "string" && memoryDistillProvider.baseUrl.trim().length > 0
            ? memoryDistillProvider.baseUrl.replace(/\/+$/, "")
            : typeof taskStateEstimator.baseUrl === "string" && taskStateEstimator.baseUrl.trim().length > 0
              ? taskStateEstimator.baseUrl.replace(/\/+$/, "")
              : envTaskStateEstimatorBaseUrl
                ? envTaskStateEstimatorBaseUrl.replace(/\/+$/, "")
                : undefined,
        apiKey:
          typeof memoryDistillProvider.apiKey === "string" && memoryDistillProvider.apiKey.trim().length > 0
            ? memoryDistillProvider.apiKey.trim()
            : typeof taskStateEstimator.apiKey === "string" && taskStateEstimator.apiKey.trim().length > 0
              ? taskStateEstimator.apiKey.trim()
              : envTaskStateEstimatorApiKey || undefined,
        model:
          typeof memoryDistillProvider.model === "string" && memoryDistillProvider.model.trim().length > 0
            ? memoryDistillProvider.model.trim()
            : typeof taskStateEstimator.model === "string" && taskStateEstimator.model.trim().length > 0
              ? taskStateEstimator.model.trim()
              : envTaskStateEstimatorModel || undefined,
        requestTimeoutMs: Math.max(
          1000,
          memoryDistillProvider.requestTimeoutMs
            ?? taskStateEstimator.requestTimeoutMs
            ?? (Number.isFinite(envTaskStateEstimatorTimeoutMs) ? envTaskStateEstimatorTimeoutMs : 60_000),
        ),
      },
      embedding: {
        enabled:
          memoryEmbedding.enabled ??
          isTruthyEnv(envMemoryEmbeddingEnabled),
        baseUrl:
          typeof memoryEmbedding.baseUrl === "string" && memoryEmbedding.baseUrl.trim().length > 0
            ? memoryEmbedding.baseUrl.replace(/\/+$/, "")
            : envMemoryEmbeddingBaseUrl
              ? envMemoryEmbeddingBaseUrl.replace(/\/+$/, "")
              : undefined,
        apiKey:
          typeof memoryEmbedding.apiKey === "string" && memoryEmbedding.apiKey.trim().length > 0
            ? memoryEmbedding.apiKey.trim()
            : envMemoryEmbeddingApiKey || undefined,
        model:
          typeof memoryEmbedding.model === "string" && memoryEmbedding.model.trim().length > 0
            ? memoryEmbedding.model.trim()
            : envMemoryEmbeddingModel || undefined,
        queryInstruction:
          typeof memoryEmbedding.queryInstruction === "string" && memoryEmbedding.queryInstruction.trim().length > 0
            ? memoryEmbedding.queryInstruction.trim()
            : envMemoryEmbeddingInstruction || "Retrieve procedural skills relevant to the current coding task",
      },
    },
    reduction: {
      engine: "layered" as const,
      triggerMinChars: Math.max(256, reduction.triggerMinChars ?? 2200),
      maxToolChars: Math.max(256, reduction.maxToolChars ?? 1200),
      passes: {
        readStateCompaction: reductionPasses.readStateCompaction ?? true,
        toolPayloadTrim: reductionPasses.toolPayloadTrim ?? true,
        htmlSlimming: reductionPasses.htmlSlimming ?? true,
        execOutputTruncation: reductionPasses.execOutputTruncation ?? true,
        agentsStartupOptimization: reductionPasses.agentsStartupOptimization ?? true,
        formatSlimming: reductionPasses.formatSlimming ?? true,
        formatCleaning: reductionPasses.formatCleaning ?? true,
        pathTruncation: reductionPasses.pathTruncation ?? true,
        imageDownsample: reductionPasses.imageDownsample ?? true,
        lineNumberStrip: reductionPasses.lineNumberStrip ?? true,
      },
      passOptions: {
        readStateCompaction: reductionPassOptions.readStateCompaction && typeof reductionPassOptions.readStateCompaction === "object" ? { ...reductionPassOptions.readStateCompaction } : {},
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

export function normalizeConfig(raw: unknown): NormalizedPluginRuntimeConfig {
  const cfg = (raw ?? {}) as PluginRuntimeConfig;
  return {
    ...normalizeHostConfig(cfg),
    ...normalizeMethodConfig(cfg),
  };
}
