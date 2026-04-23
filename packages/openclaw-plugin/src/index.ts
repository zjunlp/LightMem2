/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import {
  resolveReductionPasses as resolveLayerReductionPasses,
  runReductionBeforeCall as runLayerReductionBeforeCall,
  runReductionAfterCall as runLayerReductionAfterCall,
} from "../../layers/execution/src/composer/reduction/pipeline.js";
import {
  archiveContent,
  buildRecoveryHint,
  readArchive,
  resolveArchivePathFromLookup,
  resolveRecoveryStateDir,
} from "../../layers/execution/src/atomic/archive-recovery/index.js";
import { createCompactionModule } from "../../layers/execution/src/composer/compaction/index.js";
import { createPolicyModule, type PolicyModuleConfig } from "../../layers/decision/src/policy.js";
import {
  buildTurnAbsId,
  createTurnAnchor,
  listRawSemanticTurnSeqs,
  loadRawSemanticTurnRecord,
  persistRawSemanticTurnRecord,
} from "../../layers/history/src/raw-semantic.js";
import type { RawSemanticTurnRecord } from "../../layers/history/src/types.js";
import { loadSessionTaskRegistry } from "../../layers/history/src/registry.js";
import type { ContextSegment, RuntimeTurnContext, RuntimeTurnResult } from "../../kernel/src/types.js";
import type { RuntimeModule, RuntimeModuleRuntime } from "../../kernel/src/interfaces.js";
import {
  prependTextToContent,
  type RootPromptRewrite,
  rewriteRootPromptForStablePrefix,
} from "./root-prompt-stabilizer.js";

type EcoClawPluginConfig = {
  enabled?: boolean;
  logLevel?: "info" | "debug";
  proxyBaseUrl?: string;
  proxyApiKey?: string;
  stateDir?: string;
  debugTapProviderTraffic?: boolean;
  debugTapPath?: string;
  proxyAutostart?: boolean;
  proxyPort?: number;
  proxyMode?: {
    pureForward?: boolean;
  };
  hooks?: {
    beforeToolCall?: boolean;
    toolResultPersist?: boolean;
  };
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
    compaction?: boolean;
    eviction?: boolean;
    decisionLedger?: boolean;
  };
  compaction?: {
    enabled?: boolean;
    autoForkOnPolicy?: boolean;
    summaryGenerationMode?: "llm_full_context" | "heuristic";
    summaryFallbackToHeuristic?: boolean;
    summaryMaxOutputTokens?: number;
    includeAssistantReply?: boolean;
    summaryPrompt?: string;
    summaryPromptPath?: string;
    resumePrefixPrompt?: string;
    resumePrefixPromptPath?: string;
    compactionCooldownTurns?: number;
    turnLocalCompaction?: {
      enabled?: boolean;
      archiveDir?: string;
    };
  };
  handoff?: {
    enabled?: boolean;
    handoffGenerationMode?: "llm_full_context" | "heuristic";
    handoffFallbackToHeuristic?: boolean;
    handoffMaxOutputTokens?: number;
    includeAssistantReply?: boolean;
    handoffPrompt?: string;
    handoffPromptPath?: string;
    handoffCooldownTurns?: number;
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
  semanticReduction?: {
    enabled?: boolean;
    pythonBin?: string;
    timeoutMs?: number;
    llmlinguaModelPath?: string;
    targetRatio?: number;
    minInputChars?: number;
    minSavedChars?: number;
    preselectRatio?: number;
    maxChunkChars?: number;
    embedding?: {
      provider?: "local" | "api" | "none";
      modelPath?: string;
      apiBaseUrl?: string;
      apiKey?: string;
      apiModel?: string;
      requestTimeoutMs?: number;
    };
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
    passOptions?: {
      repeatedReadDedup?: Record<string, unknown>;
      toolPayloadTrim?: Record<string, unknown>;
      htmlSlimming?: Record<string, unknown>;
      execOutputTruncation?: Record<string, unknown>;
      agentsStartupOptimization?: Record<string, unknown>;
      formatSlimming?: Record<string, unknown>;
      semanticLlmlingua2?: Record<string, unknown>;
      formatCleaning?: Record<string, unknown>;
      pathTruncation?: Record<string, unknown>;
      imageDownsample?: Record<string, unknown>;
      lineNumberStrip?: Record<string, unknown>;
    };
  };
};

type PluginLogger = {
  info?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type SessionTaskBinding = {
  taskId: string;
  sessionSeq: number;
};

type SessionTopologyManager = {
  getLogicalSessionId(sessionKey: string, upstreamSessionId?: string): string;
  getStatus(sessionKey: string): string;
  listTaskCaches(sessionKey: string): string;
  newTaskCache(sessionKey: string, taskId?: string): string;
  newSession(sessionKey: string): string;
  bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void;
  getUpstreamSessionId(sessionKey: string): string | null;
  deleteTaskCache(sessionKey: string, taskId?: string): {
    removedTaskId: string;
    removedBindings: number;
    switchedToLogical: string;
  } | null;
};

type RecentTurnBinding = {
  userMessage: string;
  matchKey: string;
  sessionKey: string;
  upstreamSessionId?: string;
  at: number;
};

function safeId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const norm = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return norm || "main";
}

function buildLogicalSessionId(taskId: string, sessionSeq: number): string {
  return `ecoclaw-task-${safeId(taskId)}-s${Math.max(1, sessionSeq)}`;
}

function createSessionTopologyManager(): SessionTopologyManager {
  const bindingBySessionKey = new Map<string, SessionTaskBinding>();
  const countersByTaskId = new Map<string, number>();
  const upstreamSessionIdBySessionKey = new Map<string, string>();
  let globalDefaultTaskId: string | null = null;

  function scopedFamilyPrefix(sessionKey: string): string | null {
    const key = (sessionKey || "").trim();
    if (!key.startsWith("scoped:")) return null;
    const parts = key.split(":");
    if (parts.length < 3) return null;
    return `${parts[0]}:${parts[1]}:${parts[2]}`;
  }

  function ensure(sessionKey: string, preferredTaskId?: string): SessionTaskBinding {
    const key = sessionKey || "unknown";
    const existing = bindingBySessionKey.get(key);
    if (existing) return existing;
    const defaultTaskId = safeId(preferredTaskId ?? globalDefaultTaskId ?? `default-${safeId(key)}`);
    const initialSeq = 1;
    const init: SessionTaskBinding = { taskId: defaultTaskId, sessionSeq: initialSeq };
    bindingBySessionKey.set(key, init);
    countersByTaskId.set(defaultTaskId, Math.max(countersByTaskId.get(defaultTaskId) ?? 0, initialSeq));
    return init;
  }

  return {
    getLogicalSessionId(sessionKey: string, upstreamSessionId?: string): string {
      const b = ensure(sessionKey);
      const base = buildLogicalSessionId(b.taskId, b.sessionSeq);
      const upstream = String(
        upstreamSessionId ?? upstreamSessionIdBySessionKey.get(sessionKey) ?? "",
      ).trim();
      if (!upstream) return base;
      return `${base}__oc_${safeId(upstream)}`;
    },
    getStatus(sessionKey: string): string {
      const b = ensure(sessionKey);
      const base = buildLogicalSessionId(b.taskId, b.sessionSeq);
      const upstream = upstreamSessionIdBySessionKey.get(sessionKey) ?? "-";
      return `sessionKey=${sessionKey} task=${b.taskId} logical=${base} seq=${b.sessionSeq} openclawSessionId=${upstream}`;
    },
    listTaskCaches(sessionKey: string): string {
      const current = ensure(sessionKey);
      const taskIds = new Set<string>();
      for (const binding of bindingBySessionKey.values()) taskIds.add(binding.taskId);
      for (const taskId of countersByTaskId.keys()) taskIds.add(taskId);
      const sorted = Array.from(taskIds).sort((a, b) => a.localeCompare(b));
      if (sorted.length === 0) {
        return `No task-cache found.\n${this.getStatus(sessionKey)}`;
      }
      const lines = ["Task-caches:"];
      for (const taskId of sorted) {
        const seqMax = Math.max(1, countersByTaskId.get(taskId) ?? 1);
        const activeBindings = Array.from(bindingBySessionKey.values()).filter((b) => b.taskId === taskId).length;
        const mark = taskId === current.taskId ? "*" : " ";
        lines.push(`${mark} ${taskId} (sessions<=${seqMax}, bindings=${activeBindings})`);
      }
      lines.push("", `current: ${current.taskId} -> ${buildLogicalSessionId(current.taskId, current.sessionSeq)}`);
      return lines.join("\n");
    },
    newTaskCache(sessionKey: string, taskId?: string): string {
      const chosenTaskId = safeId(taskId ?? `task-${Date.now()}`);
      const seq = 1;
      countersByTaskId.set(chosenTaskId, Math.max(countersByTaskId.get(chosenTaskId) ?? 0, seq));
      globalDefaultTaskId = chosenTaskId;
      bindingBySessionKey.set(sessionKey, { taskId: chosenTaskId, sessionSeq: seq });
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: chosenTaskId, sessionSeq: seq });
          }
        }
      }
      return buildLogicalSessionId(chosenTaskId, seq);
    },
    newSession(sessionKey: string): string {
      const current = ensure(sessionKey);
      const next = (countersByTaskId.get(current.taskId) ?? current.sessionSeq) + 1;
      countersByTaskId.set(current.taskId, next);
      const updated: SessionTaskBinding = { taskId: current.taskId, sessionSeq: next };
      bindingBySessionKey.set(sessionKey, updated);
      const family = scopedFamilyPrefix(sessionKey);
      if (family) {
        for (const [key, binding] of bindingBySessionKey.entries()) {
          if (key === sessionKey) continue;
          if (binding.taskId !== current.taskId) continue;
          if (key === family || key.startsWith(`${family}:`)) {
            bindingBySessionKey.set(key, { taskId: current.taskId, sessionSeq: next });
          }
        }
      }
      return buildLogicalSessionId(updated.taskId, updated.sessionSeq);
    },
    bindUpstreamSession(sessionKey: string, upstreamSessionId?: string): void {
      const upstream = String(upstreamSessionId ?? "").trim();
      if (!upstream) return;
      upstreamSessionIdBySessionKey.set(sessionKey, upstream);
    },
    getUpstreamSessionId(sessionKey: string): string | null {
      return upstreamSessionIdBySessionKey.get(sessionKey) ?? null;
    },
    deleteTaskCache(sessionKey: string, taskId?: string) {
      const current = ensure(sessionKey);
      const targetTaskId = safeId(taskId ?? current.taskId);
      let removedBindings = 0;
      for (const [key, binding] of bindingBySessionKey.entries()) {
        if (binding.taskId === targetTaskId) {
          bindingBySessionKey.delete(key);
          removedBindings += 1;
        }
      }
      countersByTaskId.delete(targetTaskId);
      if (globalDefaultTaskId === targetTaskId) {
        globalDefaultTaskId = null;
      }
      if (removedBindings === 0) return null;
      const baseDefaultTaskId = `default-${safeId(sessionKey || "unknown")}`;
      const fallbackTaskId =
        targetTaskId === baseDefaultTaskId
          ? `${baseDefaultTaskId}-r${Date.now().toString(36)}`
          : baseDefaultTaskId;
      const fallback = ensure(sessionKey, fallbackTaskId);
      return {
        removedTaskId: targetTaskId,
        removedBindings,
        switchedToLogical: buildLogicalSessionId(fallback.taskId, fallback.sessionSeq),
      };
    },
  };
}

type EcoClawCmd = {
  kind:
    | "none"
    | "status"
    | "cache_new"
    | "cache_delete"
    | "cache_list"
    | "session_new"
    | "openclaw_session_new"
    | "help";
  taskId?: string;
};

function parseEcoClawCommand(raw: string): EcoClawCmd {
  const text = raw.trim();
  if (!text) return { kind: "none" };
  const bareSlash = text.startsWith("/") ? text.slice(1).trim().toLowerCase() : "";
  if (bareSlash === "new") {
    return { kind: "openclaw_session_new" };
  }
  const normalized = text.startsWith("/") ? text.slice(1).trim() : text;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "none" };
  if (parts[0].toLowerCase() !== "ecoclaw") return { kind: "none" };
  if (parts.length === 1) return { kind: "help" };

  const scope = parts[1]?.toLowerCase();
  if (scope === "help" || scope === "h" || scope === "--help") return { kind: "help" };
  const action = parts[2]?.toLowerCase();
  if (scope === "status") return { kind: "status" };
  if (scope === "cache" && action === "new") {
    return { kind: "cache_new", taskId: parts[3] };
  }
  if (scope === "cache" && (action === "list" || action === "ls")) {
    return { kind: "cache_list" };
  }
  if (scope === "cache" && (action === "delete" || action === "del" || action === "rm")) {
    return { kind: "cache_delete", taskId: parts[3] };
  }
  if (scope === "session" && action === "new") {
    return { kind: "session_new" };
  }
  return { kind: "help" };
}

function commandHelpText(): string {
  return [
    "EcoClaw commands:",
    "  /ecoclaw help",
    "    作用: 显示这份帮助与示例。",
    "  /ecoclaw status",
    "    作用: 查看当前会话绑定到哪个 task-cache / logical session。",
    "  /ecoclaw cache new [task-id]",
    "    作用: 新建并切换到一个 task-cache（工作区）。",
    "  /ecoclaw cache list",
    "    作用: 列出当前所有 task-cache，并标记当前所在工作区。",
    "  /ecoclaw cache delete [task-id]",
    "    作用: 删除指定（或当前）task-cache，并回退到默认绑定。",
    "  /ecoclaw session new",
    "    作用: 在当前 task-cache 内开启下一条 logical session 分支。",
    "",
    "示例:",
    "  /ecoclaw cache new demo-task",
    "  /ecoclaw cache list",
    "  /ecoclaw session new",
    "  /ecoclaw status",
    "",
    "说明:",
    "  - 请在 TUI 里优先使用 slash 命令: /ecoclaw ...",
    "  - 1 个 task-cache 可以包含多个 session。",
  ].join("\n");
}

function normalizeConfig(raw: unknown): Required<Omit<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey">> &
  Pick<EcoClawPluginConfig, "proxyBaseUrl" | "proxyApiKey"> {
  const cfg = (raw ?? {}) as EcoClawPluginConfig;
  const defaultStateDir = join(homedir(), ".openclaw", "ecoclaw-plugin-state");
  const stateDir = cfg.stateDir ?? defaultStateDir;
  const modules = cfg.modules ?? {};
  const compaction = cfg.compaction ?? {};
  const handoff = cfg.handoff ?? {};
  const eviction = cfg.eviction ?? {};
  const taskStateEstimator = cfg.taskStateEstimator ?? {};
  const semantic = cfg.semanticReduction ?? {};
  const semanticEmbedding = semantic.embedding ?? {};
  const reduction = cfg.reduction ?? {};
  const reductionPasses = reduction.passes ?? {};
  const reductionPassOptions = reduction.passOptions ?? {};
  const hooks = cfg.hooks ?? {};
  const contextEngine = cfg.contextEngine ?? {};
  const proxyMode = cfg.proxyMode ?? {};
  const envTaskStateEstimatorEnabled =
    String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_ENABLED ?? "").trim().toLowerCase();
  const envTaskStateEstimatorBaseUrl = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_BASE_URL ?? "").trim();
  const envTaskStateEstimatorApiKey = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_API_KEY ?? "").trim();
  const envTaskStateEstimatorModel = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_MODEL ?? "").trim();
  const envTaskStateEstimatorTimeoutMs = Number.parseInt(
    String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_TIMEOUT_MS ?? ""),
    10,
  );
  const envTaskStateEstimatorBatchTurns = Number.parseInt(
    String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_BATCH_TURNS ?? ""),
    10,
  );
  const envTaskStateEstimatorEvictionLookaheadTurns = Number.parseInt(
    String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS ?? ""),
    10,
  );
  const envTaskStateEstimatorInputMode = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_INPUT_MODE ?? "").trim();
  const envTaskStateEstimatorLifecycleMode = String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE ?? "").trim();
  const envTaskStateEstimatorEvictionPromotionPolicy = String(
    process.env.ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY ?? "",
  ).trim();
  const envTaskStateEstimatorEvictionPromotionHotTailSize = Number.parseInt(
    String(process.env.ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE ?? ""),
    10,
  );
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
    proxyMode: {
      pureForward: proxyMode.pureForward ?? false,
    },
    hooks: {
      beforeToolCall: hooks.beforeToolCall ?? true,
      toolResultPersist: hooks.toolResultPersist ?? true,
    },
    contextEngine: {
      enabled: contextEngine.enabled ?? true,
      pruneThresholdChars: Math.max(10_000, contextEngine.pruneThresholdChars ?? 100_000),
      keepRecentToolResults: Math.max(0, contextEngine.keepRecentToolResults ?? 5),
      placeholder:
        typeof contextEngine.placeholder === "string" && contextEngine.placeholder.trim().length > 0
          ? contextEngine.placeholder
          : "[pruned]",
    },
    modules: {
      stabilizer: modules.stabilizer ?? true,
      policy: modules.policy ?? true,
      reduction: modules.reduction ?? true,
      compaction: modules.compaction ?? true,
      eviction: modules.eviction ?? false,
      decisionLedger: modules.decisionLedger ?? true,
    },
    compaction: {
      enabled: compaction.enabled ?? true,
      autoForkOnPolicy: compaction.autoForkOnPolicy ?? true,
      summaryGenerationMode:
        compaction.summaryGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      summaryFallbackToHeuristic: compaction.summaryFallbackToHeuristic ?? true,
      summaryMaxOutputTokens: Math.max(128, Math.min(8192, compaction.summaryMaxOutputTokens ?? 1200)),
      includeAssistantReply: compaction.includeAssistantReply ?? true,
      summaryPrompt: typeof compaction.summaryPrompt === "string" ? compaction.summaryPrompt : undefined,
      summaryPromptPath: typeof compaction.summaryPromptPath === "string" ? compaction.summaryPromptPath : undefined,
      resumePrefixPrompt:
        typeof compaction.resumePrefixPrompt === "string" ? compaction.resumePrefixPrompt : undefined,
      resumePrefixPromptPath:
        typeof compaction.resumePrefixPromptPath === "string" ? compaction.resumePrefixPromptPath : undefined,
      compactionCooldownTurns: Math.max(0, compaction.compactionCooldownTurns ?? 6),
      turnLocalCompaction: {
        enabled: compaction.turnLocalCompaction?.enabled ?? false,
        archiveDir: typeof compaction.turnLocalCompaction?.archiveDir === "string"
          ? compaction.turnLocalCompaction.archiveDir
          : undefined,
      },
    },
    handoff: {
      enabled: handoff.enabled ?? false,
      handoffGenerationMode:
        handoff.handoffGenerationMode === "llm_full_context" ? "llm_full_context" : "heuristic",
      handoffFallbackToHeuristic: handoff.handoffFallbackToHeuristic ?? true,
      handoffMaxOutputTokens: Math.max(128, Math.min(8192, handoff.handoffMaxOutputTokens ?? 900)),
      includeAssistantReply: handoff.includeAssistantReply ?? true,
      handoffPrompt: typeof handoff.handoffPrompt === "string" ? handoff.handoffPrompt : undefined,
      handoffPromptPath: typeof handoff.handoffPromptPath === "string" ? handoff.handoffPromptPath : undefined,
      handoffCooldownTurns: Math.max(0, handoff.handoffCooldownTurns ?? 4),
    },
    eviction: {
      enabled: eviction.enabled ?? false,
      policy:
        eviction.policy === "lru" ||
        eviction.policy === "lfu" ||
        eviction.policy === "gdsf" ||
        eviction.policy === "model_scored" ||
        eviction.policy === "noop"
          ? eviction.policy
          : "noop",
      maxCandidateBlocks: Math.max(1, eviction.maxCandidateBlocks ?? 128),
      minBlockChars: Math.max(0, eviction.minBlockChars ?? 256),
      replacementMode:
        eviction.replacementMode === "drop"
          ? "drop"
          : "pointer_stub",
    },
    taskStateEstimator: {
      enabled:
        taskStateEstimator.enabled
        ?? (envTaskStateEstimatorEnabled === "1"
          || envTaskStateEstimatorEnabled === "true"
          || envTaskStateEstimatorEnabled === "yes"
          || envTaskStateEstimatorEnabled === "on"),
      baseUrl:
        typeof taskStateEstimator.baseUrl === "string" && taskStateEstimator.baseUrl.trim().length > 0
          ? taskStateEstimator.baseUrl.replace(/\/+$/, "")
          : envTaskStateEstimatorBaseUrl
            ? envTaskStateEstimatorBaseUrl.replace(/\/+$/, "")
          : undefined,
      apiKey:
        typeof taskStateEstimator.apiKey === "string" && taskStateEstimator.apiKey.trim().length > 0
          ? taskStateEstimator.apiKey.trim()
          : envTaskStateEstimatorApiKey
            ? envTaskStateEstimatorApiKey
          : undefined,
      model:
        typeof taskStateEstimator.model === "string" && taskStateEstimator.model.trim().length > 0
          ? taskStateEstimator.model.trim()
          : envTaskStateEstimatorModel
            ? envTaskStateEstimatorModel
          : undefined,
      requestTimeoutMs: Math.max(
        1000,
        taskStateEstimator.requestTimeoutMs
        ?? (Number.isFinite(envTaskStateEstimatorTimeoutMs) ? envTaskStateEstimatorTimeoutMs : 60_000),
      ),
      batchTurns: Math.max(
        1,
        taskStateEstimator.batchTurns
        ?? (Number.isFinite(envTaskStateEstimatorBatchTurns) ? envTaskStateEstimatorBatchTurns : 5),
      ),
      evictionLookaheadTurns: Math.max(
        1,
        taskStateEstimator.evictionLookaheadTurns
        ?? (Number.isFinite(envTaskStateEstimatorEvictionLookaheadTurns)
          ? envTaskStateEstimatorEvictionLookaheadTurns
          : 3),
      ),
      inputMode:
        taskStateEstimator.inputMode === "completed_summary_plus_active_turns"
          ? "completed_summary_plus_active_turns"
          : envTaskStateEstimatorInputMode === "completed_summary_plus_active_turns"
            ? "completed_summary_plus_active_turns"
            : "sliding_window",
      lifecycleMode:
        taskStateEstimator.lifecycleMode === "decoupled"
          ? "decoupled"
          : envTaskStateEstimatorLifecycleMode === "decoupled"
            ? "decoupled"
            : "coupled",
      evictionPromotionPolicy:
        taskStateEstimator.evictionPromotionPolicy === "fifo"
          ? "fifo"
          : envTaskStateEstimatorEvictionPromotionPolicy === "fifo"
            ? "fifo"
            : "fifo",
      evictionPromotionHotTailSize: Math.max(
        0,
        taskStateEstimator.evictionPromotionHotTailSize
        ?? (Number.isFinite(envTaskStateEstimatorEvictionPromotionHotTailSize)
          ? envTaskStateEstimatorEvictionPromotionHotTailSize
          : 1),
      ),
    },
    semanticReduction: {
      enabled: semantic.enabled ?? false,
      pythonBin: semantic.pythonBin ?? "python",
      timeoutMs: Math.max(1000, Math.min(300000, semantic.timeoutMs ?? 120000)),
      llmlinguaModelPath: semantic.llmlinguaModelPath,
      targetRatio:
        typeof semantic.targetRatio === "number"
          ? Math.min(0.95, Math.max(0.05, semantic.targetRatio))
          : 0.55,
      minInputChars: Math.max(256, semantic.minInputChars ?? 4000),
      minSavedChars: Math.max(32, semantic.minSavedChars ?? 200),
      preselectRatio:
        typeof semantic.preselectRatio === "number"
          ? Math.min(1, Math.max(0.05, semantic.preselectRatio))
          : 0.8,
      maxChunkChars: Math.max(256, semantic.maxChunkChars ?? 1400),
      embedding: {
        provider:
          semanticEmbedding.provider === "local" ||
          semanticEmbedding.provider === "api" ||
          semanticEmbedding.provider === "none"
            ? semanticEmbedding.provider
            : "none",
        modelPath: semanticEmbedding.modelPath,
        apiBaseUrl: semanticEmbedding.apiBaseUrl,
        apiKey: semanticEmbedding.apiKey,
        apiModel: semanticEmbedding.apiModel,
        requestTimeoutMs: Math.max(1000, Math.min(120000, semanticEmbedding.requestTimeoutMs ?? 30000)),
      },
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
        repeatedReadDedup:
          reductionPassOptions.repeatedReadDedup && typeof reductionPassOptions.repeatedReadDedup === "object"
            ? { ...reductionPassOptions.repeatedReadDedup }
            : {},
        toolPayloadTrim:
          reductionPassOptions.toolPayloadTrim && typeof reductionPassOptions.toolPayloadTrim === "object"
            ? { ...reductionPassOptions.toolPayloadTrim }
            : {},
        htmlSlimming:
          reductionPassOptions.htmlSlimming && typeof reductionPassOptions.htmlSlimming === "object"
            ? { ...reductionPassOptions.htmlSlimming }
            : {},
        execOutputTruncation:
          reductionPassOptions.execOutputTruncation && typeof reductionPassOptions.execOutputTruncation === "object"
            ? { ...reductionPassOptions.execOutputTruncation }
            : {},
        agentsStartupOptimization:
          reductionPassOptions.agentsStartupOptimization && typeof reductionPassOptions.agentsStartupOptimization === "object"
            ? { ...reductionPassOptions.agentsStartupOptimization }
            : {},
        formatSlimming:
          reductionPassOptions.formatSlimming && typeof reductionPassOptions.formatSlimming === "object"
            ? { ...reductionPassOptions.formatSlimming }
            : {},
        semanticLlmlingua2:
          reductionPassOptions.semanticLlmlingua2 && typeof reductionPassOptions.semanticLlmlingua2 === "object"
            ? { ...reductionPassOptions.semanticLlmlingua2 }
            : {},
        formatCleaning:
          reductionPassOptions.formatCleaning && typeof reductionPassOptions.formatCleaning === "object"
            ? { ...reductionPassOptions.formatCleaning }
            : {},
        pathTruncation:
          reductionPassOptions.pathTruncation && typeof reductionPassOptions.pathTruncation === "object"
            ? { ...reductionPassOptions.pathTruncation }
            : {},
        imageDownsample:
          reductionPassOptions.imageDownsample && typeof reductionPassOptions.imageDownsample === "object"
            ? { ...reductionPassOptions.imageDownsample }
            : {},
        lineNumberStrip:
          reductionPassOptions.lineNumberStrip && typeof reductionPassOptions.lineNumberStrip === "object"
            ? { ...reductionPassOptions.lineNumberStrip }
            : {},
      },
    },
  };
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

const OPENCLAW_SENDER_METADATA_BLOCK_RE =
  /(?:^|\n{1,2})Sender\s+\(untrusted metadata\):\s*```json\s*[\s\S]*?```(?:\n{1,2}|$)/gi;
const OPENCLAW_SENDER_METADATA_DETECT_RE =
  /Sender\s+\(untrusted metadata\):\s*```json/gi;

function stripUntrustedSenderMetadata(text: string): string {
  const raw = String(text ?? "");
  const withoutMetadata = raw.replace(OPENCLAW_SENDER_METADATA_BLOCK_RE, "\n\n");
  return withoutMetadata.replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeUserMessageText(text: string): string {
  return stripUntrustedSenderMetadata(String(text ?? ""))
    .replace(/^\[[^\]\n]{6,}\]\s*/u, "")
    .replace(/^(?:-\s*[A-Z][A-Z0-9_]*\s*:\s*[^\n]*\n)+/u, "")
    .trim();
}

function normalizeTurnBindingMessage(text: string): string {
  return normalizeUserMessageText(String(text ?? "").trim()).trim();
}

function countSenderMetadataBlocks(value: any): number {
  const matches = String(extractInputText(value) ?? "").match(OPENCLAW_SENDER_METADATA_DETECT_RE);
  return matches ? matches.length : 0;
}

function normalizeContentNode(value: any): { value: any; changed: boolean } {
  if (typeof value === "string") {
    const next = normalizeUserMessageText(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const normalized = normalizeContentNode(item);
      if (normalized.changed) changed = true;
      return normalized.value;
    });
    return { value: next, changed };
  }
  if (!value || typeof value !== "object") {
    return { value, changed: false };
  }
  let changed = false;
  const next: Record<string, any> = Array.isArray(value) ? [] : { ...value };
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeContentNode(child);
    if (normalized.changed) {
      changed = true;
      next[key] = normalized.value;
    }
  }
  return { value: changed ? next : value, changed };
}

function normalizeContentValue(value: any): { value: any; changed: boolean } {
  return normalizeContentNode(value);
}

function summarizeToolsFingerprint(tools: any): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return "unknown";
    const name = String((tool as any).name ?? (tool as any).type ?? "unknown");
    const type = String((tool as any).type ?? "unknown");
    const params = JSON.stringify((tool as any).parameters ?? {});
    return `${type}:${name}:${params.length}`;
  });
}

function findDeveloperPromptText(input: any): string {
  if (!Array.isArray(input)) return "";
  const developer = input.find((item) => item && typeof item === "object" && String(item.role) === "developer");
  if (!developer) return "";
  return extractInputText([developer]);
}

function normalizeStableText(input: string): string {
  return input
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<UUID>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][0-9:.+\-Z]{6,}\b/g, "<TIMESTAMP>")
    .replace(/\b\d{10,}\b/g, "<LONGNUM>")
    .replace(/\s+/g, " ")
    .trim();
}

function computeStablePromptCacheKey(
  model: string,
  instructions: string,
  developerText: string,
  tools: any,
): string {
  const seed = JSON.stringify({
    v: 3,
    model: normalizeProxyModelId(model),
    instructions: normalizeStableText(instructions),
    developer: normalizeStableText(developerText),
    tools: summarizeToolsFingerprint(tools),
  });
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `ecoclaw-pfx-${digest}`;
}

function replaceContentWithText(content: any, nextText: string): any {
  if (typeof content === "string") return nextText;
  if (Array.isArray(content)) {
    const next = content.map((entry) => (entry && typeof entry === "object" ? { ...entry } : entry));
    for (let i = 0; i < next.length; i += 1) {
      const entry = next[i];
      if (!entry || typeof entry !== "object") continue;
      if (typeof (entry as any).text === "string") {
        (entry as any).text = nextText;
        return next;
      }
      if (typeof (entry as any).content === "string") {
        (entry as any).content = nextText;
        return next;
      }
    }
    next.unshift({ type: "input_text", text: nextText });
    return next;
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return { ...content, text: nextText };
    if (typeof content.content === "string") return { ...content, content: nextText };
  }
  return nextText;
}

function rewritePayloadForStablePrefix(payload: any, model: string): {
  promptCacheKey: string;
  userContentRewrites: number;
  senderMetadataBlocksBefore: number;
  senderMetadataBlocksAfter: number;
  developerTextForKey: string;
} {
  let userContentRewrites = 0;
  let senderMetadataBlocksBefore = 0;
  let senderMetadataBlocksAfter = 0;
  let dynamicContextText = "";
  if (Array.isArray(payload?.input)) {
    payload.input = payload.input.map((item: any) => {
      if (!item || typeof item !== "object") return item;
      const role = String(item.role ?? "");
      if (role !== "user" && role !== "system") return item;
      if (item.__ecoclaw_replay_raw === true) return item;

      if (role === "system") {
        // Normalize system content: workspace paths, agent IDs, timestamps
        const contentText =
          typeof item.content === "string"
            ? String(item.content)
            : extractInputText([item]);
        const rewrite = rewriteRootPromptForStablePrefix(contentText);
        if (!rewrite.changed) return item;
        if (!dynamicContextText && rewrite.dynamicContextText) {
          dynamicContextText = rewrite.dynamicContextText;
        }
        senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
        userContentRewrites += 1;
        // Replace content with normalized text (handles both string and array content)
        const newContent = replaceContentWithText(item.content, rewrite.forwardedPromptText);
        const nextItem = {
          ...item,
          content: newContent,
        };
        senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
        return nextItem;
      }

      // User content: normalize sender metadata blocks
      senderMetadataBlocksBefore += countSenderMetadataBlocks(item.content);
      const normalized = normalizeContentValue(item.content);
      if (!normalized.changed) {
        senderMetadataBlocksAfter += countSenderMetadataBlocks(item.content);
        return item;
      }
      userContentRewrites += 1;
      const nextItem = {
        ...item,
        content: normalized.value,
      };
      senderMetadataBlocksAfter += countSenderMetadataBlocks(nextItem.content);
      return nextItem;
    });

    if (dynamicContextText) {
      const userIndex = payload.input.findIndex((item: any) => item && typeof item === "object" && String(item.role) === "user");
      if (userIndex >= 0) {
        const userItem = payload.input[userIndex];
        const currentText = extractInputText([userItem]);
        if (!currentText.includes(dynamicContextText)) {
          payload.input[userIndex] = {
            ...userItem,
            role: "user",
            content: prependTextToContent(userItem?.content, dynamicContextText),
          };
          userContentRewrites += 1;
        }
      }
    }
  }

  const developerTextForKey = findDeveloperPromptText(payload?.input);
  const stablePromptCacheKey = computeStablePromptCacheKey(
    model,
    String(payload?.instructions ?? ""),
    developerTextForKey,
    payload?.tools,
  );
  payload.prompt_cache_key = stablePromptCacheKey;
  return {
    promptCacheKey: stablePromptCacheKey,
    userContentRewrites,
    senderMetadataBlocksBefore,
    senderMetadataBlocksAfter,
    developerTextForKey,
  };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyToolLikeInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const role = String(item.role ?? "").toLowerCase();
  const type = String(item.type ?? "").toLowerCase();
  if (role === "tool" || role === "observation" || role === "toolresult") return true;
  if (
    type === "function_call"
    || type === "function_call_output"
    || type === "tool_result"
    || type === "tool_call_output"
  ) return true;
  if (typeof item.name === "string" && item.name.trim().length > 0) return true;
  if (typeof item.tool_name === "string" && item.tool_name.trim().length > 0) return true;
  if (typeof item.toolName === "string" && item.toolName.trim().length > 0) return true;
  if (typeof item.tool_call_id === "string" && item.tool_call_id.trim().length > 0) return true;
  if (typeof item.toolCallId === "string" && item.toolCallId.trim().length > 0) return true;
  return false;
}

function isContextSafePersistedInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const details = item.details;
  if (details && typeof details === "object") {
    const contextSafe = (details as Record<string, unknown>).contextSafe;
    if (contextSafe && typeof contextSafe === "object") {
      const mode = String((contextSafe as Record<string, unknown>).resultMode ?? "").toLowerCase();
      if (mode === "artifact" || mode === "inline-fallback") return true;
      if ((contextSafe as Record<string, unknown>).excludedFromContext === true) return true;
    }
  }
  const marker = "[ecoclaw persisted tool_result]";
  if (typeof item.content === "string" && item.content.includes(marker)) return true;
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      if (!block || typeof block !== "object") continue;
      const text =
        typeof (block as Record<string, unknown>).text === "string"
          ? String((block as Record<string, unknown>).text)
          : typeof (block as Record<string, unknown>).content === "string"
            ? String((block as Record<string, unknown>).content)
            : "";
      if (text.includes(marker)) return true;
    }
  }
  return false;
}

type ProxyReductionBinding =
  | { segmentId: string; itemIndex: number; field: "arguments" | "output" | "result"; beforeLen: number }
  | {
    segmentId: string;
    itemIndex: number;
    field: "content";
    blockIndex?: number;
    blockKey?: "text" | "content";
    beforeLen: number;
  };

function detectToolPayloadKind(text: string): "stdout" | "stderr" | "json" | "blob" | undefined {
  return inferObservationPayloadKind(text);
}

function extractPathLike(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate =
    value.path ?? value.file_path ?? value.filePath;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function parseFunctionCallArgsMapFromInput(input: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    const callId = String(
      item.call_id
      ?? item.tool_call_id
      ?? item.toolCallId
      ?? item.id
      ?? "",
    ).trim();
    if (!callId) continue;

    let toolName =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : typeof item.tool_name === "string" && item.tool_name.trim().length > 0
          ? item.tool_name.trim()
          : typeof item.toolName === "string" && item.toolName.trim().length > 0
            ? item.toolName.trim()
            : undefined;

    let path = extractPathLike(item) ?? extractPathLike(item?.details);
    if (!path) {
      try {
        const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
        path = extractPathLike(args);
      } catch {
        // Ignore malformed tool arguments.
      }
    }

    // Historical assistant messages may carry nested toolCall items instead of flat function_call items.
    if ((type === "message" || !type) && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        const blockType = String(block.type ?? "").toLowerCase();
        if (blockType !== "toolcall" && blockType !== "tool_call") continue;
        const nestedCallId = String(block.id ?? block.call_id ?? "").trim();
        if (!nestedCallId) continue;
        const nestedToolName =
          typeof block.name === "string" && block.name.trim().length > 0 ? block.name.trim() : undefined;
        const nestedPath =
          extractPathLike(block)
          ?? (() => {
            try {
              const args = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments;
              return extractPathLike(args);
            } catch {
              return undefined;
            }
          })();
        map.set(nestedCallId, { toolName: nestedToolName, path: nestedPath });
      }
    }

    if (type !== "function_call" && type !== "tool_call" && type !== "toolcall" && type !== "message") {
      // Still keep direct call-id/path fallbacks for tool_result-like items.
      map.set(callId, { toolName, path });
      continue;
    }
    map.set(callId, { toolName, path });
  }
  return map;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

const NULL_RUNTIME: RuntimeModuleRuntime = {
  async callModel() {
    throw new Error("callModel is unavailable in plugin-side before_call optimization");
  },
};

function buildPolicyModuleConfigFromPluginConfig(
  cfg: ReturnType<typeof normalizeConfig>,
): PolicyModuleConfig {
  const turnLocalCompaction = cfg.compaction.turnLocalCompaction ?? { enabled: false, archiveDir: undefined };
  return {
    localityEnabled: true,
    stateDir: cfg.stateDir,
    turnLocalCompactionEnabled: cfg.modules.compaction && turnLocalCompaction.enabled,
    compactionEnabled: cfg.modules.compaction && cfg.compaction.enabled,
    compactionCooldownTurns: cfg.compaction.compactionCooldownTurns,
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
      : {
          enabled: false,
        },
    summaryGenerationMode: cfg.compaction.summaryGenerationMode,
    summaryMaxOutputTokens: cfg.compaction.summaryMaxOutputTokens,
    cacheHealthEnabled: false,
  };
}

async function applyPolicyAndCompactionBeforeCall(
  turnCtx: RuntimeTurnContext,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  modules?: {
    policy?: RuntimeModule;
    compaction?: RuntimeModule;
  },
): Promise<{
  turnCtx: RuntimeTurnContext;
  compactionChangedSegmentIds: string[];
}> {
  let nextCtx = turnCtx;
  const bridgedReductionDecision = asRecord(
    asRecord(asRecord(nextCtx.metadata?.policy)?.decisions)?.reduction,
  );

  if (cfg.modules.policy && modules?.policy?.beforeBuild) {
    nextCtx = await modules.policy.beforeBuild(nextCtx, NULL_RUNTIME);
    logTaskStateMonitor(nextCtx, logger);
    logEvictionPlanMonitor(nextCtx, logger);
    if (bridgedReductionDecision) {
      const policy = asRecord(nextCtx.metadata?.policy) ?? {};
      const decisions = asRecord(policy.decisions) ?? {};
      nextCtx = {
        ...nextCtx,
        metadata: {
          ...(nextCtx.metadata ?? {}),
          policy: {
            ...policy,
            decisions: {
              ...decisions,
              reduction: bridgedReductionDecision,
            },
          },
        },
      };
    }
  }

  const beforeCompaction = new Map(nextCtx.segments.map((segment) => [segment.id, segment.text]));
  if (cfg.modules.compaction && modules?.compaction?.beforeCall) {
    nextCtx = await modules.compaction.beforeCall(nextCtx, NULL_RUNTIME);
  }
  const compactionChangedSegmentIds: string[] = [];
  for (const segment of nextCtx.segments) {
    if (beforeCompaction.get(segment.id) !== segment.text) {
      compactionChangedSegmentIds.push(segment.id);
    }
  }

  return { turnCtx: nextCtx, compactionChangedSegmentIds };
}

function logTaskStateMonitor(
  ctx: RuntimeTurnContext,
  logger: Required<PluginLogger>,
): void {
  const taskState = asRecord(asRecord(asRecord(ctx.metadata?.policy)?.decisions)?.taskState);
  if (!taskState || taskState.enabled !== true || taskState.attempted !== true) return;

  const transitions = Array.isArray(taskState.transitions)
    ? taskState.transitions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const rejected = Array.isArray(taskState.rejectedUpdates)
    ? taskState.rejectedUpdates
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const touchedTaskIds = Array.isArray(taskState.touchedTaskIds)
    ? taskState.touchedTaskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const note = typeof taskState.note === "string" ? taskState.note.trim() : "";

  if (transitions.length === 0 && rejected.length === 0 && !note) return;

  const transitionText =
    transitions.length > 0
      ? transitions
          .slice(0, 8)
          .map((item) => {
            const taskId = typeof item.taskId === "string" ? item.taskId : "task";
            const from = typeof item.from === "string" && item.from.trim().length > 0 ? item.from : "new";
            const to = typeof item.to === "string" ? item.to : "unknown";
            return `${taskId}:${from}->${to}`;
          })
          .join(", ")
      : "none";
  const rejectedText =
    rejected.length > 0
      ? rejected
          .slice(0, 8)
          .map((item) => {
            const taskId = typeof item.taskId === "string" ? item.taskId : "task";
            const from = typeof item.from === "string" && item.from.trim().length > 0 ? item.from : "new";
            const to = typeof item.to === "string" ? item.to : "unknown";
            const reason = typeof item.reason === "string" ? item.reason : "rejected";
            return `${taskId}:${from}->${to}(${reason})`;
          })
          .join(", ")
      : "none";
  logger.info(
    `[ecoclaw/task-state] session=${ctx.sessionId} applied=${taskState.applied === true} touched=${touchedTaskIds.length} transitions=[${transitionText}] rejected=[${rejectedText}]${note ? ` note=${note}` : ""}`,
  );
}

function logEvictionPlanMonitor(
  ctx: RuntimeTurnContext,
  logger: Required<PluginLogger>,
): void {
  const eviction = asRecord(asRecord(asRecord(ctx.metadata?.policy)?.decisions)?.eviction);
  if (!eviction || eviction.enabled !== true) return;
  const instructions = Array.isArray(eviction.instructions)
    ? eviction.instructions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (instructions.length === 0) return;
  const taskIds = Array.from(
    new Set(
      instructions.flatMap((item) => {
        const params = asRecord(item.parameters);
        const taskId =
          typeof params?.taskId === "string" && params.taskId.trim().length > 0 ? [params.taskId.trim()] : [];
        return taskId;
      }),
    ),
  );
  logger.info(
    `[ecoclaw/eviction-plan] session=${ctx.sessionId} instructions=${instructions.length} tasks=${taskIds.length > 0 ? taskIds.join(", ") : "unknown"} policy=${typeof eviction.policy === "string" ? eviction.policy : "unknown"}`,
  );
}

function buildLayeredReductionContext(
  payload: any,
  triggerMinChars: number,
  sessionId: string,
  passToggles?: {
    repeatedReadDedup?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
    agentsStartupOptimization?: boolean;
  },
  passOptions?: Record<string, Record<string, unknown>>,
  segmentAnchorByCallId?: Map<string, { turnAbsIds: string[]; taskIds: string[] }>,
  orderedTurnAnchors?: Array<{ turnAbsId: string; taskIds: string[] }>,
): {
  turnCtx: RuntimeTurnContext;
  bindings: ProxyReductionBinding[];
  stats: {
    inputItems: number;
    toolLikeItems: number;
    persistedSkippedItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    instructionCount: number;
    enableToolPayloadTrim?: boolean;
    passToggles?: Record<string, boolean>;
  };
} {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const callArgsMap = parseFunctionCallArgsMapFromInput(input);
  const segments: ContextSegment[] = [];
  const bindings: ProxyReductionBinding[] = [];
  const reductionInstructions: Array<{
    strategy: string;
    segmentIds: string[];
    parameters?: Record<string, unknown>;
  }> = [];

  const addSegment = (
    segmentId: string,
    text: string,
    metadata: Record<string, unknown>,
    binding: ProxyReductionBinding,
  ): void => {
    segments.push({
      id: segmentId,
      kind: "volatile",
      text,
      priority: 100,
      source: "proxy.input",
      metadata,
    });
    bindings.push(binding);
  };

  const readByPath = new Map<string, string[]>();
  const enableRepeatedReadDedup = passToggles?.repeatedReadDedup ?? true;
  const enableToolPayloadTrim = passToggles?.toolPayloadTrim ?? true;
  const enableHtmlSlimming = passToggles?.htmlSlimming ?? true;
  const enableExecOutputTruncation = passToggles?.execOutputTruncation ?? true;
  const execOutputOptions = passOptions?.exec_output_truncation ?? {};
  const execOutputToolThresholds =
    execOutputOptions.toolThresholds && typeof execOutputOptions.toolThresholds === "object"
      ? execOutputOptions.toolThresholds as Record<string, number>
      : undefined;
  const EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS = 50_000;
  const EXEC_OUTPUT_TOOL_THRESHOLDS: Record<string, number> = {
    bash: 30_000,
    shell: 30_000,
    powershell: 30_000,
    grep: 20_000,
    rg: 20_000,
    read: Number.POSITIVE_INFINITY,
    file_read: Number.POSITIVE_INFINITY,
    mcp_auth: 10_000,
    glob: 100_000,
    write: 100_000,
    edit: 100_000,
    file_write: 100_000,
    file_edit: 100_000,
    web_fetch: 100_000,
    web_search: 100_000,
    agent: 100_000,
    task: 100_000,
  };
  const getExecOutputThreshold = (rawToolName: string): number => {
    const normalizedToolName = rawToolName.trim().toLowerCase();
    if (!normalizedToolName) return EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS;
    if (
      execOutputToolThresholds &&
      typeof execOutputToolThresholds[normalizedToolName] === "number" &&
      Number.isFinite(execOutputToolThresholds[normalizedToolName])
    ) {
      return execOutputToolThresholds[normalizedToolName] as number;
    }
    return EXEC_OUTPUT_TOOL_THRESHOLDS[normalizedToolName] ?? EXEC_OUTPUT_DEFAULT_THRESHOLD_CHARS;
  };
  let toolLikeItems = 0;
  let persistedSkippedItems = 0;
  let candidateBlocks = 0;
  let overThresholdBlocks = 0;
  let orderedTurnIndex = -1;
  let currentOrderedAnchor: { turnAbsIds: string[]; taskIds: string[] } | undefined;

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object") continue;
    if (String(item.role ?? "").toLowerCase() === "user" && orderedTurnAnchors) {
      const nextAnchor = orderedTurnAnchors[orderedTurnIndex + 1];
      if (nextAnchor) {
        orderedTurnIndex += 1;
        currentOrderedAnchor = {
          turnAbsIds: [nextAnchor.turnAbsId],
          taskIds: nextAnchor.taskIds,
        };
      }
    }
    if (!isLikelyToolLikeInputItem(item)) continue;
    if (isContextSafePersistedInputItem(item)) {
      persistedSkippedItems += 1;
      continue;
    }
    toolLikeItems += 1;

    const itemType = String(item.type ?? "").toLowerCase();
    const itemRole = String(item.role ?? "").toLowerCase();
    const callId = String(item.call_id ?? item.tool_call_id ?? item.id ?? "").trim();
    const callMeta = callId ? callArgsMap.get(callId) : undefined;
    const anchored = (callId ? segmentAnchorByCallId?.get(callId) : undefined) ?? currentOrderedAnchor;
    const toolName = String(
      item.name
      ?? item.tool_name
      ?? item.toolName
      ?? callMeta?.toolName
      ?? "",
    ).trim();
    const isMemoryFaultRecoveryTool =
      toolName.toLowerCase() === MEMORY_FAULT_RECOVER_TOOL_NAME
      || hasRecoveryMarker(item?.details);
    const directPath =
      extractPathLike(item)
      ?? extractPathLike(item?.details)
      ?? (() => {
        try {
          const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
          return extractPathLike(args);
        } catch {
          return undefined;
        }
      })();
    const dataPath = String(callMeta?.path ?? directPath ?? "").trim();

    const addReductionInstructions = (segmentId: string, text: string): void => {
      candidateBlocks += 1;
      const execOutputThreshold = getExecOutputThreshold(toolName);
      const overThreshold = text.length >= execOutputThreshold;
      if (overThreshold) {
        overThresholdBlocks += 1;
      }
      const payloadKind = detectToolPayloadKind(text) ?? "stdout";
      if (enableToolPayloadTrim) {
        reductionInstructions.push({
          strategy: "tool_payload_trim",
          segmentIds: [segmentId],
          parameters: { payloadKind },
        });
        if (enableHtmlSlimming) {
          reductionInstructions.push({
            strategy: "html_slimming",
            segmentIds: [segmentId],
          });
        }
      }
      if (overThreshold && enableExecOutputTruncation) {
        reductionInstructions.push({
          strategy: "exec_output_truncation",
          segmentIds: [segmentId],
          parameters: {
            toolName: toolName || undefined,
            thresholdChars: Number.isFinite(execOutputThreshold) ? execOutputThreshold : undefined,
          },
        });
      }
    };

    const pushBindingForField = (
      fieldName: "arguments" | "output" | "result",
      applyReduction: boolean,
    ): void => {
      const text = item[fieldName];
      if (typeof text !== "string" || text.length === 0) return;
      const segmentId = `proxy-${index}-${fieldName}`;
      addSegment(
        segmentId,
        text,
        {
          toolName,
          path: dataPath,
          turnAbsIds: anchored?.turnAbsIds,
          taskIds: anchored?.taskIds,
          itemType,
          itemRole,
          fieldName,
          recovery: isMemoryFaultRecoveryTool
            ? {
                source: MEMORY_FAULT_RECOVER_TOOL_NAME,
                skipReduction: true,
                skipCompaction: true,
              }
            : undefined,
          toolPayload: {
            toolName,
            path: dataPath,
            turnAbsIds: anchored?.turnAbsIds,
            taskIds: anchored?.taskIds,
            payloadKind: detectToolPayloadKind(text) ?? "stdout",
          },
        },
        { segmentId, itemIndex: index, field: fieldName, beforeLen: text.length },
      );
      if (applyReduction && !isMemoryFaultRecoveryTool) {
        addReductionInstructions(segmentId, text);
      }
      if (toolName === "read" && dataPath && fieldName !== "arguments") {
        const bucket = readByPath.get(dataPath) ?? [];
        bucket.push(segmentId);
        readByPath.set(dataPath, bucket);
      }
    };

    // Keep tool arguments untouched to avoid changing executable intent.
    pushBindingForField("arguments", false);
    pushBindingForField("output", true);
    pushBindingForField("result", true);

    if (typeof item.content === "string" && item.content.length > 0) {
      const segmentId = `proxy-${index}-content`;
      addSegment(
        segmentId,
        item.content,
        {
          toolName,
          path: dataPath,
          turnAbsIds: anchored?.turnAbsIds,
          taskIds: anchored?.taskIds,
          itemType,
          itemRole,
          fieldName: "content",
          recovery: isMemoryFaultRecoveryTool
            ? {
                source: MEMORY_FAULT_RECOVER_TOOL_NAME,
                skipReduction: true,
                skipCompaction: true,
              }
            : undefined,
          toolPayload: {
            toolName,
            path: dataPath,
            turnAbsIds: anchored?.turnAbsIds,
            taskIds: anchored?.taskIds,
            payloadKind: detectToolPayloadKind(item.content) ?? "stdout",
          },
        },
        { segmentId, itemIndex: index, field: "content", beforeLen: item.content.length },
      );
      if (!isMemoryFaultRecoveryTool) {
        addReductionInstructions(segmentId, item.content);
      }
      if (toolName === "read" && dataPath) {
        const bucket = readByPath.get(dataPath) ?? [];
        bucket.push(segmentId);
        readByPath.set(dataPath, bucket);
      }
    }
    if (Array.isArray(item.content)) {
      item.content.forEach((block: any, blockIndex: number) => {
        if (!block || typeof block !== "object") return;
        const blockKey: "text" | "content" | undefined =
          typeof block.text === "string"
            ? "text"
            : typeof block.content === "string"
              ? "content"
              : undefined;
        if (!blockKey) return;
        const text = String(block[blockKey] ?? "");
        if (!text) return;
        const segmentId = `proxy-${index}-content-${blockIndex}-${blockKey}`;
        addSegment(
          segmentId,
          text,
          {
            toolName,
            path: dataPath,
            turnAbsIds: anchored?.turnAbsIds,
            taskIds: anchored?.taskIds,
            itemType,
            itemRole,
            fieldName: "content",
            blockIndex,
            blockKey,
            recovery: isMemoryFaultRecoveryTool
              ? {
                  source: MEMORY_FAULT_RECOVER_TOOL_NAME,
                  skipReduction: true,
                  skipCompaction: true,
                }
              : undefined,
            toolPayload: {
              toolName,
              path: dataPath,
              turnAbsIds: anchored?.turnAbsIds,
              taskIds: anchored?.taskIds,
              payloadKind: detectToolPayloadKind(text) ?? "stdout",
            },
          },
          {
            segmentId,
            itemIndex: index,
            field: "content",
            blockIndex,
            blockKey,
            beforeLen: text.length,
          },
        );
        if (!isMemoryFaultRecoveryTool) {
          addReductionInstructions(segmentId, text);
        }
        if (toolName === "read" && dataPath) {
          const bucket = readByPath.get(dataPath) ?? [];
          bucket.push(segmentId);
          readByPath.set(dataPath, bucket);
        }
      });
    }
  }

  if (enableRepeatedReadDedup) {
    for (const segmentIds of readByPath.values()) {
      if (segmentIds.length < 2) continue;
      const [firstId, ...rest] = segmentIds;
      for (const segmentId of rest) {
        reductionInstructions.push({
          strategy: "repeated_read_dedup",
          segmentIds: [segmentId],
          parameters: { firstReadSegmentId: firstId },
        });
      }
    }
  }

  const turnCtx: RuntimeTurnContext = {
    sessionId: sessionId.trim() || "proxy-session",
    sessionMode: "single",
    provider: "openai",
    model: String(payload?.model ?? "unknown"),
    apiFamily: "openai-responses",
    prompt: "",
    segments,
    budget: {
      maxInputTokens: 1_000_000,
      reserveOutputTokens: 16_384,
    },
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [
              enableRepeatedReadDedup ? "repeated_read_dedup" : null,
              enableToolPayloadTrim ? "tool_payload_trim" : null,
              enableHtmlSlimming ? "html_slimming" : null,
              enableExecOutputTruncation ? "exec_output_truncation" : null,
            ].filter(Boolean) as string[],
            instructions: reductionInstructions,
          },
        },
      },
    },
  };

  return {
    turnCtx,
    bindings,
    stats: {
      inputItems: input.length,
      toolLikeItems,
      persistedSkippedItems,
      candidateBlocks,
      overThresholdBlocks,
      instructionCount: reductionInstructions.length,
      enableToolPayloadTrim,
      passToggles: {
        repeatedReadDedup: enableRepeatedReadDedup,
        toolPayloadTrim: enableToolPayloadTrim,
        htmlSlimming: enableHtmlSlimming,
        execOutputTruncation: enableExecOutputTruncation,
      },
    },
  };
}

async function loadSegmentAnchorByCallId(
  stateDir: string,
  sessionId: string,
): Promise<Map<string, { turnAbsIds: string[]; taskIds: string[] }>> {
  const registry = await loadSessionTaskRegistry(stateDir, sessionId);
  await syncRawSemanticTurnsFromTranscript(stateDir, sessionId);
  const turnSeqs = await listRawSemanticTurnSeqs(stateDir, sessionId);
  const out = new Map<string, { turnAbsIds: string[]; taskIds: string[] }>();

  const put = (callId: string, turnAbsId: string, taskIds: string[]): void => {
    const normalizedCallId = String(callId ?? "").trim();
    const normalizedTurnAbsId = String(turnAbsId ?? "").trim();
    if (!normalizedCallId || !normalizedTurnAbsId) return;
    const prev = out.get(normalizedCallId);
    if (!prev) {
      out.set(normalizedCallId, {
        turnAbsIds: [normalizedTurnAbsId],
        taskIds: dedupeStrings(taskIds),
      });
      return;
    }
    prev.turnAbsIds = dedupeStrings([...prev.turnAbsIds, normalizedTurnAbsId]);
    prev.taskIds = dedupeStrings([...prev.taskIds, ...taskIds]);
  };

  for (const turnSeq of turnSeqs) {
    const rawTurn = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
    if (!rawTurn) continue;
    const turnAbsId = rawTurn.turnAbsId;
    const taskIds = registry.turnToTaskIds[turnAbsId] ?? [];
    for (const toolCall of rawTurn.toolCalls) {
      put(toolCall.toolCallId, turnAbsId, taskIds);
    }
    for (const toolResult of rawTurn.toolResults) {
      put(toolResult.toolCallId, turnAbsId, taskIds);
    }
  }

  return out;
}

async function loadOrderedTurnAnchors(
  stateDir: string,
  sessionId: string,
): Promise<Array<{ turnAbsId: string; taskIds: string[] }>> {
  const registry = await loadSessionTaskRegistry(stateDir, sessionId);
  return Object.entries(registry.turnToTaskIds)
    .map(([turnAbsId, taskIds]) => ({
      turnAbsId,
      taskIds: dedupeStrings(taskIds),
      turnSeq: Number(turnAbsId.split(":t").at(-1) ?? Number.NaN),
    }))
    .filter((item) => item.turnAbsId.trim().length > 0 && Number.isFinite(item.turnSeq))
    .sort((a, b) => a.turnSeq - b.turnSeq)
    .map(({ turnAbsId, taskIds }) => ({ turnAbsId, taskIds }));
}

function isReductionPassEnabled(
  passId: string,
  passToggles?: {
    repeatedReadDedup?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
    agentsStartupOptimization?: boolean;
  },
): boolean {
  if (!passToggles) return true;
  switch (passId) {
    case "repeated_read_dedup":
      return passToggles.repeatedReadDedup ?? true;
    case "tool_payload_trim":
      return passToggles.toolPayloadTrim ?? true;
    case "html_slimming":
      return passToggles.htmlSlimming ?? true;
    case "exec_output_truncation":
      return passToggles.execOutputTruncation ?? true;
    case "agents_startup_optimization":
      return passToggles.agentsStartupOptimization ?? true;
    default:
      return true;
  }
}

const MEMORY_FAULT_RECOVER_TOOL_NAME = "memory_fault_recover";

const MEMORY_FAULT_PROTOCOL_INSTRUCTIONS = [
  "[EcoClaw Recovery Protocol]",
  `If a prior tool result contains \`[Tool payload trimmed]\`, that notice gives you a dataKey for the internal tool \`${MEMORY_FAULT_RECOVER_TOOL_NAME}\`.`,
  `When you need omitted content, call \`${MEMORY_FAULT_RECOVER_TOOL_NAME}\` with that dataKey instead of replying with plain text.`,
  `\`${MEMORY_FAULT_RECOVER_TOOL_NAME}\` behaves like an internal read of archived content. Do not call the original tool again for the same content.`,
  `After the recovery tool returns, continue your analysis normally in the next assistant step.`,
].join("\n");

function injectMemoryFaultProtocolInstructions(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const current = typeof payload.instructions === "string" ? payload.instructions : "";
  if (current.includes("[EcoClaw Recovery Protocol]")) return false;
  payload.instructions = current
    ? `${current}\n\n${MEMORY_FAULT_PROTOCOL_INSTRUCTIONS}`
    : MEMORY_FAULT_PROTOCOL_INSTRUCTIONS;
  return true;
}

type ProxyReductionResult = {
  changedItems: number;
  changedBlocks: number;
  savedChars: number;
  report?: Array<{
    id: string;
    phase: string;
    target: string;
    changed: boolean;
    note?: string;
    skippedReason?: string;
    beforeChars: number;
    afterChars: number;
    touchedSegmentIds?: string[];
  }>;
  diagnostics?: {
    engine: "layered";
    inputItems: number;
    toolLikeItems: number;
    persistedSkippedItems?: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    triggerMinChars: number;
    maxToolChars: number;
    instructionCount: number;
    passCount: number;
    compactionChangedSegments?: number;
    skippedReason?: string;
  };
};

type ProxyAfterCallReductionResult = {
  changed: boolean;
  savedChars: number;
  passCount: number;
  skippedReason?: string;
  mode?: "json" | "sse";
  patchedEvents?: number;
  report?: Array<{
    id: string;
    phase: string;
    target: string;
    changed: boolean;
    note?: string;
    skippedReason?: string;
    beforeChars: number;
    afterChars: number;
    touchedSegmentIds?: string[];
  }>;
};

async function applyLayeredReductionToInput(
  payload: any,
  maxToolChars: number,
  triggerMinChars: number,
  sessionId: string,
  logger: Required<PluginLogger>,
  passToggles?: {
    repeatedReadDedup?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
    agentsStartupOptimization?: boolean;
  },
  passOptions?: Record<string, Record<string, unknown>>,
  beforeCallModules?: {
    policy?: RuntimeModule;
    compaction?: RuntimeModule;
    eviction?: RuntimeModule;
  },
  cfg?: ReturnType<typeof normalizeConfig>,
): Promise<ProxyReductionResult> {
  if (!Array.isArray(payload?.input)) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered" as const,
        inputItems: 0,
        toolLikeItems: 0,
        candidateBlocks: 0,
        overThresholdBlocks: 0,
        triggerMinChars,
        maxToolChars,
        instructionCount: 0,
        passCount: 0,
        skippedReason: "no_input_array",
      },
    };
  }
  const segmentAnchorByCallId =
    cfg?.stateDir && sessionId && sessionId !== "proxy-session"
      ? await loadSegmentAnchorByCallId(cfg.stateDir, sessionId).catch(() => new Map())
      : undefined;
  const orderedTurnAnchors =
    cfg?.stateDir && sessionId && sessionId !== "proxy-session"
      ? await loadOrderedTurnAnchors(cfg.stateDir, sessionId).catch(() => [])
      : undefined;
  const { turnCtx, bindings, stats } = buildLayeredReductionContext(
    payload,
    triggerMinChars,
    sessionId,
    passToggles,
    passOptions,
    segmentAnchorByCallId,
    orderedTurnAnchors,
  );
  if (turnCtx.segments.length === 0 || bindings.length === 0) {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered" as const,
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        persistedSkippedItems: stats.persistedSkippedItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: 0,
        skippedReason: stats.candidateBlocks === 0 ? "no_candidate_blocks" : "below_trigger_min_chars",
      },
    };
  }
  const beforeCallCtxPromise = beforeCallModules && cfg
    ? applyPolicyAndCompactionBeforeCall(turnCtx, cfg, logger, beforeCallModules)
    : Promise.resolve({ turnCtx, compactionChangedSegmentIds: [] as string[] });

  const passes = resolveLayerReductionPasses({ maxToolChars, passOptions }).filter(
    (p) => p.phase === "before_call" && isReductionPassEnabled(p.id, passToggles),
  );
  return beforeCallCtxPromise.then(({ turnCtx: preReductionCtx, compactionChangedSegmentIds }) =>
    runLayerReductionBeforeCall({
      turnCtx: preReductionCtx,
      passes,
    }).then(({ turnCtx: reducedCtx, report }) => {
    const changedIds = new Set<string>();
    for (const entry of report) {
      if (!entry.changed) continue;
      for (const id of entry.touchedSegmentIds ?? []) changedIds.add(id);
    }
    for (const id of compactionChangedSegmentIds) changedIds.add(id);
    if (changedIds.size === 0) {
      return {
        changedItems: 0,
        changedBlocks: 0,
        savedChars: 0,
        report,
        diagnostics: {
          engine: "layered" as const,
          inputItems: stats.inputItems,
          toolLikeItems: stats.toolLikeItems,
          persistedSkippedItems: stats.persistedSkippedItems,
          candidateBlocks: stats.candidateBlocks,
          overThresholdBlocks: stats.overThresholdBlocks,
          triggerMinChars,
          maxToolChars,
          instructionCount: stats.instructionCount,
          passCount: passes.length,
          skippedReason: "pipeline_no_effect",
        },
      };
    }
    const segmentMap = new Map<string, ContextSegment>();
    for (const segment of reducedCtx.segments) segmentMap.set(segment.id, segment);

    let changedBlocks = 0;
    let savedChars = 0;
    const changedItems = new Set<number>();

    for (const binding of bindings) {
      if (!changedIds.has(binding.segmentId)) continue;
      const reduced = segmentMap.get(binding.segmentId);
      if (!reduced) continue;
      const nextText = reduced.text;
      if (binding.field === "arguments" || binding.field === "output" || binding.field === "result") {
        const item = payload.input[binding.itemIndex];
        if (!item || typeof item !== "object") continue;
        if (typeof item[binding.field] !== "string") continue;
        if (item[binding.field] === nextText) continue;
        item[binding.field] = nextText;
      } else if (binding.field === "content") {
        const item = payload.input[binding.itemIndex];
        if (!item || typeof item !== "object") continue;
        if (binding.blockIndex === undefined) {
          if (typeof item.content !== "string") continue;
          if (item.content === nextText) continue;
          item.content = nextText;
        } else {
          if (!Array.isArray(item.content)) continue;
          const block = item.content[binding.blockIndex];
          if (!block || typeof block !== "object" || !binding.blockKey) continue;
          if (typeof block[binding.blockKey] !== "string") continue;
          if (block[binding.blockKey] === nextText) continue;
          block[binding.blockKey] = nextText;
        }
      }
      changedItems.add(binding.itemIndex);
      changedBlocks += 1;
      savedChars += Math.max(0, binding.beforeLen - nextText.length);
    }
    return {
      changedItems: changedItems.size,
      changedBlocks,
      savedChars,
      report,
      diagnostics: {
        engine: "layered" as const,
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        persistedSkippedItems: stats.persistedSkippedItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: passes.length,
        compactionChangedSegments: compactionChangedSegmentIds.length,
      },
    };
  })).catch(() => {
    return {
      changedItems: 0,
      changedBlocks: 0,
      savedChars: 0,
      diagnostics: {
        engine: "layered" as const,
        inputItems: stats.inputItems,
        toolLikeItems: stats.toolLikeItems,
        persistedSkippedItems: stats.persistedSkippedItems,
        candidateBlocks: stats.candidateBlocks,
        overThresholdBlocks: stats.overThresholdBlocks,
        triggerMinChars,
        maxToolChars,
        instructionCount: stats.instructionCount,
        passCount: passes.length,
        skippedReason: "pipeline_error",
      },
    };
  });
}

function applyProxyReductionToInput(
  payload: any,
  options?: {
    sessionId?: string;
    engine?: "layered";
    logger?: Required<PluginLogger>;
    triggerMinChars?: number;
    maxToolChars?: number;
    passToggles?: {
      repeatedReadDedup?: boolean;
      toolPayloadTrim?: boolean;
      htmlSlimming?: boolean;
      execOutputTruncation?: boolean;
      agentsStartupOptimization?: boolean;
    };
    passOptions?: Record<string, Record<string, unknown>>;
    beforeCallModules?: {
      policy?: RuntimeModule;
      compaction?: RuntimeModule;
      eviction?: RuntimeModule;
    };
    cfg?: ReturnType<typeof normalizeConfig>;
  },
): Promise<ProxyReductionResult> {
  const triggerMinChars = Math.max(256, options?.triggerMinChars ?? 2200);
  const maxToolChars = Math.max(256, options?.maxToolChars ?? 1200);
  return applyLayeredReductionToInput(
    payload,
    maxToolChars,
    triggerMinChars,
    String(options?.sessionId ?? "proxy-session"),
    options?.logger ?? makeLogger(),
    options?.passToggles,
    options?.passOptions,
    options?.beforeCallModules,
    options?.cfg,
  );
}

function extractProxyResponseText(parsedResponse: any): string {
  if (!parsedResponse || typeof parsedResponse !== "object") return "";
  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text.trim().length > 0) {
    return parsedResponse.output_text;
  }
  return extractProviderResponseText("", parsedResponse);
}

function patchProxyResponseText(parsedResponse: any, nextText: string): boolean {
  if (!parsedResponse || typeof parsedResponse !== "object") return false;
  let changed = false;

  if (typeof parsedResponse.output_text === "string" && parsedResponse.output_text !== nextText) {
    parsedResponse.output_text = nextText;
    changed = true;
  }

  const output = Array.isArray(parsedResponse.output) ? parsedResponse.output : [];
  let replacedNested = false;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = String((item as any).type ?? "").toLowerCase();
    if (type === "output_text" && typeof (item as any).text === "string") {
      if ((item as any).text !== nextText) {
        (item as any).text = nextText;
        changed = true;
      }
      replacedNested = true;
      break;
    }
    if (type === "message" && Array.isArray((item as any).content)) {
      for (const block of (item as any).content) {
        if (!block || typeof block !== "object") continue;
        if (String((block as any).type ?? "").toLowerCase() !== "output_text") continue;
        if (typeof (block as any).text !== "string") continue;
        if ((block as any).text !== nextText) {
          (block as any).text = nextText;
          changed = true;
        }
        replacedNested = true;
        break;
      }
      if (replacedNested) break;
    }
  }

  return changed;
}

function isSseContentType(contentType: string | null | undefined): boolean {
  return String(contentType ?? "").toLowerCase().includes("text/event-stream");
}

function rewriteSseJsonEvents(
  rawSse: string,
  mutator: (event: any) => boolean,
): { text: string; parsedEvents: number; changedEvents: number } {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return { text: normalized, parsedEvents: 0, changedEvents: 0 };
  const blocks = normalized.split(/\r?\n\r?\n/u);
  let parsedEvents = 0;
  let changedEvents = 0;
  const rewrittenBlocks = blocks.map((block) => {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return block;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") return block;
    let parsed: any = null;
    try {
      parsed = JSON.parse(payloadText);
      parsedEvents += 1;
    } catch {
      return block;
    }
    if (!mutator(parsed)) return block;
    changedEvents += 1;
    const nonData = lines.filter((line) => !line.startsWith("data:"));
    return [...nonData, `data: ${JSON.stringify(parsed)}`].join("\n");
  });
  const text = rewrittenBlocks.join("\n\n");
  return { text, parsedEvents, changedEvents };
}

function collectSseOutputText(rawSse: string): string {
  const normalized = String(rawSse ?? "");
  if (!normalized.trim()) return "";
  const blocks = normalized.split(/\r?\n\r?\n/u);
  const doneTexts: string[] = [];
  let deltaText = "";
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const payloadText = dataLines
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const event = JSON.parse(payloadText) as any;
      const type = String(event?.type ?? "").toLowerCase();
      if (type === "response.output_text.done" && typeof event?.text === "string" && event.text.trim().length > 0) {
        doneTexts.push(event.text);
        continue;
      }
      if (type === "response.content_part.done") {
        const partType = String(event?.part?.type ?? "").toLowerCase();
        if (partType === "output_text" && typeof event?.part?.text === "string" && event.part.text.trim().length > 0) {
          doneTexts.push(event.part.text);
          continue;
        }
      }
      if (type === "response.output_text.delta" && typeof event?.delta === "string") {
        deltaText += event.delta;
      }
    } catch {
      // ignore malformed stream fragments
    }
  }
  if (doneTexts.length > 0) return doneTexts.join("\n").trim();
  return deltaText.trim();
}

function extractCompletedResponseFromSse(rawSse: string): any | null {
  let completedResponse: any = null;
  rewriteSseJsonEvents(rawSse, (event) => {
    if (!event || typeof event !== "object") return false;
    const type = String(event.type ?? "").toLowerCase();
    if (type !== "response.completed" || !event.response || typeof event.response !== "object") return false;
    completedResponse = event.response;
    return false;
  });
  return completedResponse;
}

function responseContainsToolCalls(value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some((item) => responseContainsToolCalls(item));
  if (typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const type = String(obj.type ?? "").toLowerCase();
  if (type === "function_call" || type === "tool_call" || type === "toolcall") return true;
  if (String(obj.role ?? "").toLowerCase() === "assistant") {
    return responseContainsToolCalls(obj.content ?? obj.output ?? obj.message);
  }
  return responseContainsToolCalls(obj.response ?? obj.output ?? obj.item ?? obj.content);
}

function patchSseEventForReducedText(event: any, nextText: string): boolean {
  if (!event || typeof event !== "object") return false;
  const type = String(event.type ?? "").toLowerCase();
  let changed = false;
  if (type === "response.output_text.done" && typeof event.text === "string" && event.text !== nextText) {
    event.text = nextText;
    changed = true;
  }
  if (type === "response.content_part.done" && event.part && typeof event.part === "object") {
    const partType = String(event.part.type ?? "").toLowerCase();
    if (partType === "output_text" && typeof event.part.text === "string" && event.part.text !== nextText) {
      event.part.text = nextText;
      changed = true;
    }
  }
  if (type === "response.output_item.done" && event.item && typeof event.item === "object") {
    changed = patchProxyResponseText(event.item, nextText) || changed;
  }
  if (type === "response.completed" && event.response && typeof event.response === "object") {
    changed = patchProxyResponseText(event.response, nextText) || changed;
  }
  return changed;
}

// ============================================================================
// Memory Fault Detection & Persistence
// ============================================================================

async function applyLayeredReductionAfterCallToSse(
  requestPayload: any,
  rawSse: string,
  maxToolChars: number,
  triggerMinChars: number,
  passToggles?: {
    repeatedReadDedup?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
    agentsStartupOptimization?: boolean;
  },
  passOptions?: Record<string, Record<string, unknown>>,
): Promise<{ text: string; reduction: ProxyAfterCallReductionResult }> {
  let completedResponse: any = null;
  const probe = rewriteSseJsonEvents(rawSse, (event) => {
    if (!event || typeof event !== "object") return false;
    const type = String(event.type ?? "").toLowerCase();
    if (type !== "response.completed" || !event.response || typeof event.response !== "object") return false;
    completedResponse = event.response;
    return false;
  });
  if (!completedResponse) {
    return {
      text: rawSse,
      reduction: {
        changed: false,
        savedChars: 0,
        passCount: 0,
        skippedReason: "sse_missing_response_completed",
        mode: "sse",
        patchedEvents: probe.changedEvents,
      },
    };
  }

  const reconstructedText = collectSseOutputText(rawSse);
  if (!extractProxyResponseText(completedResponse) && reconstructedText) {
    if (typeof completedResponse.output_text === "string" || completedResponse.output_text === undefined) {
      completedResponse.output_text = reconstructedText;
    }
  }

  const afterCallReduction = await applyLayeredReductionAfterCall(
    requestPayload,
    completedResponse,
    maxToolChars,
    triggerMinChars,
    passToggles,
    passOptions,
  );
  if (!afterCallReduction.changed) {
    return { text: rawSse, reduction: { ...afterCallReduction, mode: "sse" } };
  }
  const nextText = extractProxyResponseText(completedResponse);
  if (!nextText) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_reduced_text_empty",
        mode: "sse",
      },
    };
  }

  const rewritten = rewriteSseJsonEvents(rawSse, (event) => patchSseEventForReducedText(event, nextText));
  if (rewritten.changedEvents <= 0) {
    return {
      text: rawSse,
      reduction: {
        ...afterCallReduction,
        changed: false,
        skippedReason: "sse_patch_no_effect",
        mode: "sse",
        patchedEvents: 0,
      },
    };
  }
  return {
    text: rewritten.text,
    reduction: { ...afterCallReduction, mode: "sse", patchedEvents: rewritten.changedEvents },
  };
}

async function applyLayeredReductionAfterCall(
  requestPayload: any,
  parsedResponse: any,
  maxToolChars: number,
  triggerMinChars: number,
  passToggles?: {
    repeatedReadDedup?: boolean;
    toolPayloadTrim?: boolean;
    htmlSlimming?: boolean;
    execOutputTruncation?: boolean;
    agentsStartupOptimization?: boolean;
  },
  passOptions?: Record<string, Record<string, unknown>>,
): Promise<ProxyAfterCallReductionResult> {
  const responseText = extractProxyResponseText(parsedResponse);
  if (!responseText) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "empty_response_text" };
  }

  const { turnCtx } = buildLayeredReductionContext(
    requestPayload,
    triggerMinChars,
    "proxy-session",
    passToggles,
    passOptions,
  );
  const passes = resolveLayerReductionPasses({ maxToolChars, passOptions }).filter(
    (p) => p.phase === "after_call" && isReductionPassEnabled(p.id, passToggles),
  );
  if (passes.length === 0) {
    return { changed: false, savedChars: 0, passCount: 0, skippedReason: "no_after_call_passes" };
  }

  const result: RuntimeTurnResult = {
    content: responseText,
    metadata: {},
  };
  const { result: reducedResult, report: afterReport } = await runLayerReductionAfterCall({
    turnCtx,
    result,
    passes,
  });

  const nextText = String(reducedResult?.content ?? "");
  if (!nextText || nextText === responseText) {
    return {
      changed: false,
      savedChars: 0,
      passCount: passes.length,
      skippedReason: "pipeline_no_effect",
      report: afterReport,
    };
  }

  const patched = patchProxyResponseText(parsedResponse, nextText);
  if (!patched) {
    return {
      changed: false,
      savedChars: 0,
      passCount: passes.length,
      skippedReason: "response_patch_no_effect",
      report: afterReport,
    };
  }
  return {
    changed: true,
    savedChars: Math.max(0, responseText.length - nextText.length),
    passCount: passes.length,
    report: afterReport,
  };
}

function stripInternalPayloadMarkers(payload: any): void {
  if (!payload || typeof payload !== "object") return;
  if (Object.prototype.hasOwnProperty.call(payload, "__ecoclaw_reduction_applied")) {
    delete payload.__ecoclaw_reduction_applied;
  }
  if (!Array.isArray(payload.input)) return;
  payload.input = payload.input.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    let changed = false;
    const clone: Record<string, unknown> = { ...item };
    if (Object.prototype.hasOwnProperty.call(clone, "__ecoclaw_replay_raw")) {
      delete clone.__ecoclaw_replay_raw;
      changed = true;
    }
    return changed ? clone : item;
  });
}

function extractInputText(input: any): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input
      .map((entry) => {
        if (!entry || typeof entry !== "object") return "";
        const content = (entry as any).content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return content
            .map((c: any) => {
              if (!c || typeof c !== "object") return "";
              if (typeof c.text === "string") return c.text;
              if (typeof c.content === "string") return c.content;
              return "";
            })
            .join("\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function estimatePayloadInputChars(input: any): number {
  try {
    return normalizeText(extractInputText(input)).length;
  } catch {
    return 0;
  }
}

function findDeveloperAndPrimaryUser(input: any): {
  developerText: string;
  developerIndex: number;
  developerItem: any;
  userIndex: number;
  userItem: any | null;
} | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  let developerIndex = -1;
  let developerItem: any = null;
  let developerText = "";
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object" || String((item as any).role) !== "developer") continue;
    const text =
      typeof (item as any).content === "string"
        ? String((item as any).content)
        : extractInputText([item]);
    if (!text.trim()) continue;
    developerIndex = i;
    developerItem = item;
    developerText = text;
    break;
  }
  if (developerIndex < 0 || !developerItem) return null;

  let userIndex = -1;
  for (let i = developerIndex + 1; i < input.length; i += 1) {
    const item = input[i];
    if (item && typeof item === "object" && String((item as any).role) === "user") {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) {
    userIndex = input.findIndex((item) => item && typeof item === "object" && String((item as any).role) === "user");
  }
  const userItem = userIndex >= 0 ? input[userIndex] : null;
  return { developerText, developerIndex, developerItem, userIndex, userItem };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function extractItemText(item: any): string {
  if (!item || typeof item !== "object") return "";
  return extractInputText([item]).trim();
}

function findLastUserItem(input: any): { userIndex: number; userItem: any | null } | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role) === "user") {
      return { userIndex: i, userItem: item };
    }
  }
  return null;
}

function stripReplyTag(text: string): string {
  return String(text ?? "").replace(/^\s*\[\[[^\]]+\]\]\s*/u, "").trim();
}

function recentTurnBindingsPath(stateDir: string): string {
  return join(stateDir, "ecoclaw", "controls", "recent-turn-bindings.json");
}

function loadRecentTurnBindingsFromState(stateDir: string): RecentTurnBinding[] {
  try {
    const parsed = JSON.parse(readFileSync(recentTurnBindingsPath(stateDir), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const out: RecentTurnBinding[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const userMessage = String((entry as any).userMessage ?? "").trim();
      const matchKey =
        String((entry as any).matchKey ?? "").trim() || normalizeTurnBindingMessage(userMessage);
      const sessionKey = String((entry as any).sessionKey ?? "").trim();
      const upstreamSessionId = String((entry as any).upstreamSessionId ?? "").trim() || undefined;
      const atRaw = Number((entry as any).at ?? 0);
      const at = Number.isFinite(atRaw) ? atRaw : 0;
      if (!userMessage || !matchKey || !sessionKey || !at) continue;
      out.push({ userMessage, matchKey, sessionKey, upstreamSessionId, at });
    }
    return out;
  } catch {
    return [];
  }
}

function persistRecentTurnBindingsToState(stateDir: string, bindings: RecentTurnBinding[]): void {
  try {
    mkdirSync(dirname(recentTurnBindingsPath(stateDir)), { recursive: true });
    writeFileSync(recentTurnBindingsPath(stateDir), JSON.stringify(bindings.slice(-128), null, 2), "utf8");
  } catch {
    // Best-effort only: provider-side lookup can still rely on in-memory bindings if persistence fails.
  }
}

function normalizeProxyModelId(model: string): string {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("ecoclaw/")) {
    return trimmed.slice("ecoclaw/".length).trim();
  }
  return trimmed;
}

type UpstreamModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

type UpstreamConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  models: UpstreamModelDef[];
};

type UpstreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  transport: "fetch" | "curl";
};

function runExecFile(
  file: string,
  args: string[],
  options?: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: options?.env,
        timeout: options?.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${file} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options?.input != null) {
      child.stdin?.end(options.input);
    }
  });
}

function parseCurlHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("HTTP/")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    headers[trimmed.slice(0, idx).trim().toLowerCase()] = trimmed.slice(idx + 1).trim();
  }
  return headers;
}

function buildUpstreamCurlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SHELL",
  ]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  const { httpProxy, httpsProxy, allProxy, noProxy } = resolveUpstreamProxySettings();

  if (httpProxy) {
    env.http_proxy = httpProxy;
    env.HTTP_PROXY = httpProxy;
  }
  if (httpsProxy) {
    env.https_proxy = httpsProxy;
    env.HTTPS_PROXY = httpsProxy;
  }
  if (allProxy) {
    env.all_proxy = allProxy;
    env.ALL_PROXY = allProxy;
  }
  if (noProxy) {
    env.no_proxy = noProxy;
    env.NO_PROXY = noProxy;
  }
  return env;
}

function resolveUpstreamProxySettings(): {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
} {
  const httpProxy =
    process.env.ECOCLAW_UPSTREAM_HTTP_PROXY
    || process.env.ecoclaw_upstream_http_proxy
    || process.env.http_proxy
    || process.env.HTTP_PROXY;
  const httpsProxy =
    process.env.ECOCLAW_UPSTREAM_HTTPS_PROXY
    || process.env.ecoclaw_upstream_https_proxy
    || process.env.https_proxy
    || process.env.HTTPS_PROXY
    || httpProxy;
  const allProxy =
    process.env.ECOCLAW_UPSTREAM_ALL_PROXY
    || process.env.ecoclaw_upstream_all_proxy
    || process.env.all_proxy
    || process.env.ALL_PROXY;
  const noProxy =
    process.env.ECOCLAW_UPSTREAM_NO_PROXY
    || process.env.ecoclaw_upstream_no_proxy
    || process.env.no_proxy
    || process.env.NO_PROXY
    || "127.0.0.1,localhost";
  return {
    httpProxy: httpProxy?.trim() || undefined,
    httpsProxy: httpsProxy?.trim() || undefined,
    allProxy: allProxy?.trim() || undefined,
    noProxy: noProxy?.trim() || undefined,
  };
}

function hasExplicitUpstreamProxyEnv(): boolean {
  const settings = resolveUpstreamProxySettings();
  return Boolean(settings.httpProxy || settings.httpsProxy || settings.allProxy);
}

async function appendUpstreamTransportTrace(
  logger: Required<PluginLogger>,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    const cfg = normalizeConfig({});
    const tracePath = join(cfg.stateDir, "ecoclaw", "upstream-transport-trace.jsonl");
    await mkdir(dirname(tracePath), { recursive: true });
    await appendFile(
      tracePath,
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`,
      "utf8",
    );
  } catch {
    // best-effort trace only
  }
}

async function requestUpstreamWithCurl(
  upstream: UpstreamConfig,
  payload: any,
  logger?: Required<PluginLogger>,
): Promise<UpstreamHttpResponse> {
  const tempDir = await mkdtemp(join(tmpdir(), "ecoclaw-curl-"));
  const bodyPath = join(tempDir, "request.json");
  const headersPath = join(tempDir, "headers.txt");
  const curlEnv = buildUpstreamCurlEnv();
  const proxySettings = resolveUpstreamProxySettings();
  try {
    await writeFile(bodyPath, JSON.stringify(payload), "utf8");
    await appendUpstreamTransportTrace(logger ?? makeLogger(), {
      stage: "curl_start",
      upstreamBaseUrl: upstream.baseUrl,
      httpProxy: curlEnv.http_proxy ?? curlEnv.HTTP_PROXY ?? "",
      httpsProxy: curlEnv.https_proxy ?? curlEnv.HTTPS_PROXY ?? "",
      noProxy: curlEnv.no_proxy ?? curlEnv.NO_PROXY ?? "",
    });
    const { stdout } = await runExecFile(
      "curl",
      (() => {
        const args = [
        "-sS",
        "-X",
        "POST",
        `${upstream.baseUrl}/responses`,
        "-H",
        "content-type: application/json",
        "-H",
        `authorization: Bearer ${upstream.apiKey}`,
        "--data-binary",
        `@${bodyPath}`,
        "--dump-header",
        headersPath,
        "--output",
        "-",
        "--write-out",
        "\n__ECOCLAW_CURL_STATUS__:%{http_code}",
        ];
        const targetUrl = new URL(`${upstream.baseUrl}/responses`);
        const chosenProxy = targetUrl.protocol === "https:"
          ? (proxySettings.httpsProxy || proxySettings.allProxy || proxySettings.httpProxy)
          : (proxySettings.httpProxy || proxySettings.allProxy || proxySettings.httpsProxy);
        if (chosenProxy) {
          args.push("--proxy", chosenProxy);
        }
        if (proxySettings.noProxy) {
          args.push("--noproxy", proxySettings.noProxy);
        }
        return args;
      })(),
      {
        env: curlEnv,
        timeoutMs: 180000,
      },
    );
    const marker = "\n__ECOCLAW_CURL_STATUS__:";
    const idx = stdout.lastIndexOf(marker);
    if (idx < 0) {
      throw new Error("curl missing status marker");
    }
    const text = stdout.slice(0, idx);
    const status = Number.parseInt(stdout.slice(idx + marker.length).trim(), 10);
    const rawHeaders = await readFile(headersPath, "utf8");
    await appendUpstreamTransportTrace(logger ?? makeLogger(), {
      stage: "curl_ok",
      upstreamBaseUrl: upstream.baseUrl,
      status: Number.isFinite(status) ? status : 502,
    });
    return {
      status: Number.isFinite(status) ? status : 502,
      headers: parseCurlHeaders(rawHeaders),
      text,
      transport: "curl",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendUpstreamTransportTrace(logger ?? makeLogger(), {
      stage: "curl_error",
      upstreamBaseUrl: upstream.baseUrl,
      error: detail,
      httpProxy: curlEnv.http_proxy ?? curlEnv.HTTP_PROXY ?? "",
      httpsProxy: curlEnv.https_proxy ?? curlEnv.HTTPS_PROXY ?? "",
      noProxy: curlEnv.no_proxy ?? curlEnv.NO_PROXY ?? "",
    });
    throw err;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function requestUpstreamResponses(
  upstream: UpstreamConfig,
  payload: any,
  logger: Required<PluginLogger>,
): Promise<UpstreamHttpResponse> {
  if (hasExplicitUpstreamProxyEnv()) {
    await appendUpstreamTransportTrace(logger, {
      stage: "transport_policy",
      upstreamBaseUrl: upstream.baseUrl,
      policy: "prefer_curl_due_to_proxy_env",
    });
    return requestUpstreamWithCurl(upstream, payload, logger);
  }
  try {
    const resp = await fetch(`${upstream.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      text: await resp.text(),
      transport: "fetch",
    };
  } catch (err) {
    const fetchDetail = err instanceof Error ? err.message : String(err);
    await appendUpstreamTransportTrace(logger, {
      stage: "fetch_error",
      upstreamBaseUrl: upstream.baseUrl,
      error: fetchDetail,
    });
    logger.warn(`[ecoclaw] upstream fetch failed, fallback to curl: ${fetchDetail}`);
    try {
      return await requestUpstreamWithCurl(upstream, payload, logger);
    } catch (curlErr) {
      const curlDetail = curlErr instanceof Error ? curlErr.message : String(curlErr);
      await appendUpstreamTransportTrace(logger, {
        stage: "fetch_then_curl_error",
        upstreamBaseUrl: upstream.baseUrl,
        fetchError: fetchDetail,
        curlError: curlDetail,
      });
      logger.error(`[ecoclaw] upstream curl fallback failed: ${curlDetail}`);
      throw new Error(`upstream fetch failed (${fetchDetail}); curl fallback failed (${curlDetail})`);
    }
  }
}

async function detectUpstreamConfig(logger: Required<PluginLogger>): Promise<UpstreamConfig | null> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const providers = parsed?.models?.providers ?? {};
    // tuzi/dica before gmn: gmn is openclaw's internal provider and may not support all model IDs
    const preferred = ["tuzi", "dica", "openai", "qwen-portal", "bailian", "gmn"];
    const selectedProvider = preferred.find((id) => providers?.[id]?.baseUrl && providers?.[id]?.apiKey)
      ?? Object.keys(providers).find((id) => id !== "ecoclaw" && providers[id]?.baseUrl && providers[id]?.apiKey)
      ?? Object.keys(providers)[0];
    if (!selectedProvider) return null;
    const p = providers[selectedProvider];
    const models = Array.isArray(p?.models) ? p.models : [];
    const normalized: UpstreamModelDef[] = models
      .filter((m: any) => typeof m?.id === "string" && m.id.trim())
      .map((m: any) => ({
        id: String(m.id),
        name: String(m.name ?? m.id),
        reasoning: Boolean(m.reasoning ?? false),
        input: Array.isArray(m.input) ? m.input.filter((x: any) => x === "text" || x === "image") : ["text"],
        contextWindow: Number(m.contextWindow ?? 128000),
        maxTokens: Number(m.maxTokens ?? 8192),
      }));
    if (!p?.baseUrl || !p?.apiKey) return null;
    return {
      providerId: selectedProvider,
      baseUrl: String(p.baseUrl).replace(/\/+$/, ""),
      apiKey: String(p.apiKey),
      models: normalized.length > 0 ? normalized : [{
        id: "gpt-5.4",
        name: "gpt-5.4",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 8192,
      }],
    };
  } catch (err) {
    logger.warn(`[ecoclaw] detect upstream config failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function ensureExplicitProxyModelsInConfig(
  proxyBaseUrl: string,
  upstream: UpstreamConfig,
  logger: Required<PluginLogger>,
): Promise<void> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const doc = JSON.parse(raw) as any;
    doc.models = doc.models ?? {};
    doc.models.providers = doc.models.providers ?? {};
    doc.agents = doc.agents ?? {};
    doc.agents.defaults = doc.agents.defaults ?? {};
    doc.agents.defaults.models = doc.agents.defaults.models ?? {};

    const existingProvider = doc.models.providers.ecoclaw ?? {};
    const desiredModels = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    const nextProvider = {
      ...existingProvider,
      baseUrl: proxyBaseUrl,
      apiKey: "ecoclaw-local",
      api: "openai-responses",
      authHeader: false,
      models: desiredModels,
    };
    doc.models.providers.ecoclaw = nextProvider;

    for (const model of upstream.models) {
      const key = `ecoclaw/${model.id}`;
      if (!doc.agents.defaults.models[key]) {
        doc.agents.defaults.models[key] = {};
      }
    }

    const nextRaw = JSON.stringify(doc, null, 2);
    if (nextRaw !== raw) {
      await writeFile(cfgPath, nextRaw, "utf8");
      logger.info(
        `[ecoclaw] synced explicit model keys into openclaw.json (${upstream.models.length} models).`,
      );
    }
  } catch (err) {
    logger.warn(
      `[ecoclaw] sync explicit proxy models failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function startEmbeddedResponsesProxy(
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  resolveSessionIdForPayload?: (payload: any) => string | undefined,
): Promise<{ baseUrl: string; upstream: UpstreamConfig; close: () => Promise<void> } | null> {
  if (!cfg.proxyAutostart) return null;
  let upstream: UpstreamConfig | null = null;
  if (cfg.proxyBaseUrl && cfg.proxyApiKey) {
    // Explicit config takes precedence over auto-detection
    const detected = await detectUpstreamConfig(logger);
    upstream = {
      providerId: detected?.providerId ?? "configured",
      baseUrl: cfg.proxyBaseUrl.replace(/\/+$/, ""),
      apiKey: cfg.proxyApiKey,
      models: detected?.models ?? [],
    };
    logger.info(`[ecoclaw] proxy using configured upstream: ${upstream.baseUrl}`);
  } else {
    upstream = await detectUpstreamConfig(logger);
  }
  if (!upstream) {
    logger.warn("[ecoclaw] no upstream provider discovered; proxy disabled.");
    return null;
  }

  const policyModule = createPolicyModule(buildPolicyModuleConfigFromPluginConfig(cfg));
  const turnLocalCompaction = cfg.compaction.turnLocalCompaction ?? { enabled: false, archiveDir: undefined };
  const reductionPassOptions = cfg.reduction.passOptions ?? {};
  const compactionModule = createCompactionModule({
    turnLocalCompaction: {
      enabled: turnLocalCompaction.enabled,
      archiveDir: turnLocalCompaction.archiveDir,
    },
  });

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      const model = String(payload?.model ?? "");
      const upstreamModel = normalizeProxyModelId(model);
      if (upstreamModel && upstreamModel !== model) {
        payload.model = upstreamModel;
      }
      const proxyPureForward = cfg.proxyMode.pureForward;
      const reductionTriggerMinChars = Math.max(256, cfg.reduction.triggerMinChars ?? 2200);
      const reductionMaxToolChars = Math.max(256, cfg.reduction.maxToolChars ?? 1200);
      const resolvedSessionId =
        String(resolveSessionIdForPayload?.(payload) ?? "proxy-session").trim() || "proxy-session";
      if (!proxyPureForward && cfg.modules.reduction) {
        injectMemoryFaultProtocolInstructions(payload);
      }
      const instructions = normalizeText(String(payload?.instructions ?? ""));
      const devAndUser = !proxyPureForward ? findDeveloperAndPrimaryUser(payload?.input) : null;
      const firstTurnCandidate = Boolean(devAndUser);
      const rootPromptRewrite = devAndUser && !proxyPureForward
        ? rewriteRootPromptForStablePrefix(devAndUser.developerText)
        : null;
      const developerCanonicalText = normalizeText(
        rootPromptRewrite?.canonicalPromptText ?? devAndUser?.developerText ?? "",
      );
      const developerForwardedText = normalizeText(
        rootPromptRewrite?.forwardedPromptText ?? devAndUser?.developerText ?? "",
      );
      const originalPromptCacheKey =
        typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
          ? String(payload.prompt_cache_key)
          : "";
      if (!proxyPureForward && devAndUser && rootPromptRewrite && Array.isArray(payload?.input) && devAndUser.developerIndex >= 0) {
        payload.input[devAndUser.developerIndex] = {
          ...(devAndUser.developerItem ?? payload.input[devAndUser.developerIndex]),
          role: "developer",
          content: rootPromptRewrite.forwardedPromptText,
        };
        if (rootPromptRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
          payload.input[devAndUser.userIndex] = {
            ...(devAndUser.userItem ?? payload.input[devAndUser.userIndex]),
            role: "user",
            content: prependTextToContent(
              (devAndUser.userItem ?? payload.input[devAndUser.userIndex])?.content,
              rootPromptRewrite.dynamicContextText,
            ),
          };
        }
      }
      const stableRewrite = !proxyPureForward
        ? rewritePayloadForStablePrefix(payload, model)
        : {
          promptCacheKey:
            typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
              ? String(payload.prompt_cache_key)
              : "",
          userContentRewrites: 0,
          senderMetadataBlocksBefore: 0,
          senderMetadataBlocksAfter: 0,
        };
      if (!proxyPureForward && cfg.stateDir) {
        await appendTaskStateTrace(cfg.stateDir, {
          stage: "stable_prefix_rewrite",
          sessionId: resolvedSessionId,
          model,
          promptCacheKey: stableRewrite.promptCacheKey,
          inputItemCount: Array.isArray(payload?.input) ? payload.input.length : 0,
          inputChars: estimatePayloadInputChars(payload?.input),
          userContentRewrites: stableRewrite.userContentRewrites,
          senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
          senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
        });
      }
      const beforeReductionInputCount = Array.isArray(payload?.input) ? payload.input.length : 0;
      const beforeReductionInputChars = estimatePayloadInputChars(payload?.input);
      const reductionApplied: ProxyReductionResult = !proxyPureForward && cfg.modules.reduction
        ? await (() => {
          if (cfg.stateDir) {
            void appendTaskStateTrace(cfg.stateDir, {
              stage: "proxy_reduction_session_resolved",
              resolvedSessionId,
              promptPreview: String(payload?.prompt ?? "").slice(0, 160),
            });
          }
          return applyProxyReductionToInput(payload, {
            sessionId: resolvedSessionId,
            logger,
            engine: cfg.reduction.engine,
            triggerMinChars: cfg.reduction.triggerMinChars,
            maxToolChars: cfg.reduction.maxToolChars,
            passToggles: cfg.reduction.passes,
            passOptions: {
              repeated_read_dedup: reductionPassOptions.repeatedReadDedup ?? {},
              tool_payload_trim: reductionPassOptions.toolPayloadTrim ?? {},
              html_slimming: reductionPassOptions.htmlSlimming ?? {},
              exec_output_truncation: reductionPassOptions.execOutputTruncation ?? {},
              agents_startup_optimization: reductionPassOptions.agentsStartupOptimization ?? {},
              format_slimming: reductionPassOptions.formatSlimming ?? {},
              semantic_llmlingua2: reductionPassOptions.semanticLlmlingua2 ?? {},
              format_cleaning: reductionPassOptions.formatCleaning ?? {},
              path_truncation: reductionPassOptions.pathTruncation ?? {},
              image_downsample: reductionPassOptions.imageDownsample ?? {},
              line_number_strip: reductionPassOptions.lineNumberStrip ?? {},
            },
            beforeCallModules: {
              policy: policyModule,
              compaction: compactionModule,
            },
            cfg,
          });
        })()
        : {
          changedItems: 0,
          changedBlocks: 0,
          savedChars: 0,
          diagnostics: {
            engine: "layered",
            inputItems: Array.isArray(payload?.input) ? payload.input.length : 0,
            toolLikeItems: 0,
            candidateBlocks: 0,
            overThresholdBlocks: 0,
            triggerMinChars: reductionTriggerMinChars,
            maxToolChars: reductionMaxToolChars,
            instructionCount: 0,
            passCount: 0,
            skippedReason: proxyPureForward ? "proxy_pure_forward" : "module_disabled",
          },
        };
      if (cfg.stateDir) {
        await appendTaskStateTrace(cfg.stateDir, {
          stage: "proxy_before_call_rewrite",
          sessionId: resolvedSessionId,
          model,
          proxyPureForward,
          inputItemCountBefore: beforeReductionInputCount,
          inputItemCountAfter: Array.isArray(payload?.input) ? payload.input.length : 0,
          inputCharsBefore: beforeReductionInputChars,
          inputCharsAfter: estimatePayloadInputChars(payload?.input),
          reductionChangedItems: reductionApplied.changedItems,
          reductionChangedBlocks: reductionApplied.changedBlocks,
          reductionSavedChars: reductionApplied.savedChars,
          reductionSkippedReason: reductionApplied.diagnostics?.skippedReason ?? null,
          reductionCandidates: reductionApplied.diagnostics?.candidateBlocks ?? 0,
          reductionOverThreshold: reductionApplied.diagnostics?.overThresholdBlocks ?? 0,
        });
      }
      if (!proxyPureForward && cfg.modules.reduction) {
        payload.__ecoclaw_reduction_applied = true;
      }
      stripInternalPayloadMarkers(payload);
      logger.info(
        `[ecoclaw] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} instrChars=${instructions.length} cacheKey=${stableRewrite.promptCacheKey} userContentRewrites=${stableRewrite.userContentRewrites} senderBlocks=${stableRewrite.senderMetadataBlocksBefore}->${stableRewrite.senderMetadataBlocksAfter} reductionEngine=${proxyPureForward ? "proxy_pure_forward" : cfg.reduction.engine} reductionItems=${reductionApplied.changedItems} reductionBlocks=${reductionApplied.changedBlocks} reductionSavedChars=${reductionApplied.savedChars} reductionCandidates=${reductionApplied.diagnostics?.candidateBlocks ?? 0} reductionOverThreshold=${reductionApplied.diagnostics?.overThresholdBlocks ?? 0} reductionPersistedSkipped=${reductionApplied.diagnostics?.persistedSkippedItems ?? 0} reductionSkipped=${reductionApplied.diagnostics?.skippedReason ?? "none"}`,
      );
      // Always log all proxy requests to a dedicated file for debugging
      {
        const requestAt = new Date().toISOString();
        const requestId = createHash("sha1")
          .update(JSON.stringify([
            requestAt,
            model,
            upstreamModel,
            stableRewrite.promptCacheKey,
            payload?.previous_response_id ?? "",
            Array.isArray(payload?.input) ? payload.input.length : -1,
          ]))
          .digest("hex")
          .slice(0, 16);
        const proxyLogPath = join(cfg.stateDir, "ecoclaw", "proxy-requests.jsonl");
        const logRecord = {
          at: requestAt,
          requestId,
          stage: "proxy_inbound",
          sessionId: resolvedSessionId,
          model,
          upstreamModel,
          upstreamBaseUrl: upstream.baseUrl,
          instructionsLength: instructions.length,
          instructions: String(payload?.instructions ?? ""),
          inputItemCount: Array.isArray(payload?.input) ? payload.input.length : -1,
          input: payload?.input,
          tools: payload?.tools,
          promptCacheKey: stableRewrite.promptCacheKey,
          developerRewritten: Boolean(rootPromptRewrite?.changed),
          developerRewriteWorkdir: rootPromptRewrite?.workdir ?? "",
          developerRewriteAgentId: rootPromptRewrite?.agentId ?? "",
          reductionChangedItems: reductionApplied.changedItems,
          reductionChangedBlocks: reductionApplied.changedBlocks,
          reductionSavedChars: reductionApplied.savedChars,
          reductionReport: reductionApplied.report ?? null,
          reductionDiagnostics: reductionApplied.diagnostics,
          reductionEngine: cfg.reduction.engine,
        };
        await mkdir(dirname(proxyLogPath), { recursive: true });
        await appendFile(proxyLogPath, `${JSON.stringify(logRecord)}\n`, "utf8");
        await appendReductionPassTrace(cfg.stateDir, {
          at: requestAt,
          stage: "proxy_inbound",
          model,
          upstreamModel,
          promptCacheKey: stableRewrite.promptCacheKey,
          requestId,
          report: reductionApplied.report ?? [],
          extra: {
            reductionSavedChars: reductionApplied.savedChars,
            reductionChangedItems: reductionApplied.changedItems,
            reductionChangedBlocks: reductionApplied.changedBlocks,
          },
        });
      }
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_inbound",
          sessionId: resolvedSessionId,
          model,
          upstreamModel,
          instructionsChars: instructions.length,
          inputChars: normalizeText(extractInputText(payload?.input)).length,
          devUserDetected: Boolean(devAndUser),
          firstTurnCandidate,
          developerChars: developerForwardedText.length,
          developerCanonicalChars: developerCanonicalText.length,
          developerRewritten: Boolean(rootPromptRewrite?.changed),
          developerRewriteWorkdir: rootPromptRewrite?.workdir ?? "",
          developerRewriteAgentId: rootPromptRewrite?.agentId ?? "",
          originalPromptCacheKey,
          rewrittenPromptCacheKey: stableRewrite.promptCacheKey,
          userContentRewrites: stableRewrite.userContentRewrites,
          senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
          senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
          reductionChangedItems: reductionApplied.changedItems,
          reductionChangedBlocks: reductionApplied.changedBlocks,
          reductionSavedChars: reductionApplied.savedChars,
          reductionReport: reductionApplied.report ?? null,
          reductionDiagnostics: reductionApplied.diagnostics,
          payload,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      payload.prompt_cache_retention = "24h";
      let activePayload = payload;
      let upstreamResp: UpstreamHttpResponse | null = null;
      let txt = "";
      let parsedResponseForMirror: any = null;
      let responseContentType = "";
      let memoryFaultAutoReplayCount = 0;
      upstreamResp = await requestUpstreamResponses(upstream, activePayload, logger);
      txt = upstreamResp.text;
      const beforeAfterCallTextChars = txt.length;
      responseContentType = upstreamResp.headers["content-type"] ?? "";
      try {
        parsedResponseForMirror = JSON.parse(txt);
      } catch {
        parsedResponseForMirror = null;
      }
      // Legacy plain-text memory_fault detection is intentionally disabled while
      // recovery flows through the internal memory_fault_recover tool. Keep the
      // old helper code in-tree for one validation cycle before deleting it.
      // NOTE: proxy-side auto replay is intentionally disabled while migrating recovery
      // to the internal memory_fault_recover tool. Keep the plumbing visible for now so
      // we can re-enable or delete it after the tool path is fully validated.
      const upstreamRespFinal = upstreamResp!;
      let afterCallReduction: ProxyAfterCallReductionResult | null = null;
      if (!proxyPureForward && cfg.modules.reduction && cfg.reduction.engine === "layered") {
        if (parsedResponseForMirror) {
          try {
            afterCallReduction = await applyLayeredReductionAfterCall(
              activePayload,
              parsedResponseForMirror,
              reductionMaxToolChars,
              reductionTriggerMinChars,
              cfg.reduction.passes,
              {
                repeated_read_dedup: reductionPassOptions.repeatedReadDedup ?? {},
                tool_payload_trim: reductionPassOptions.toolPayloadTrim ?? {},
                html_slimming: reductionPassOptions.htmlSlimming ?? {},
                exec_output_truncation: reductionPassOptions.execOutputTruncation ?? {},
                agents_startup_optimization: reductionPassOptions.agentsStartupOptimization ?? {},
                format_slimming: reductionPassOptions.formatSlimming ?? {},
                semantic_llmlingua2: reductionPassOptions.semanticLlmlingua2 ?? {},
                format_cleaning: reductionPassOptions.formatCleaning ?? {},
                path_truncation: reductionPassOptions.pathTruncation ?? {},
                image_downsample: reductionPassOptions.imageDownsample ?? {},
                line_number_strip: reductionPassOptions.lineNumberStrip ?? {},
              },
            );
            if (afterCallReduction.changed) {
              txt = JSON.stringify(parsedResponseForMirror);
            }
            afterCallReduction = { ...afterCallReduction, mode: "json" };
          } catch {
            afterCallReduction = {
              changed: false,
              savedChars: 0,
              passCount: 0,
              skippedReason: "after_call_error",
              mode: "json",
            };
          }
        } else if (isSseContentType(responseContentType)) {
          try {
            const sseResult = await applyLayeredReductionAfterCallToSse(
              activePayload,
              txt,
              reductionMaxToolChars,
              reductionTriggerMinChars,
              cfg.reduction.passes,
              {
                repeated_read_dedup: reductionPassOptions.repeatedReadDedup ?? {},
                tool_payload_trim: reductionPassOptions.toolPayloadTrim ?? {},
                html_slimming: reductionPassOptions.htmlSlimming ?? {},
                exec_output_truncation: reductionPassOptions.execOutputTruncation ?? {},
                agents_startup_optimization: reductionPassOptions.agentsStartupOptimization ?? {},
                format_slimming: reductionPassOptions.formatSlimming ?? {},
                semantic_llmlingua2: reductionPassOptions.semanticLlmlingua2 ?? {},
                format_cleaning: reductionPassOptions.formatCleaning ?? {},
                path_truncation: reductionPassOptions.pathTruncation ?? {},
                image_downsample: reductionPassOptions.imageDownsample ?? {},
                line_number_strip: reductionPassOptions.lineNumberStrip ?? {},
              },
            );
            txt = sseResult.text;
            afterCallReduction = sseResult.reduction;
          } catch {
            afterCallReduction = {
              changed: false,
              savedChars: 0,
              passCount: 0,
              skippedReason: "after_call_sse_error",
              mode: "sse",
            };
          }
        } else {
          afterCallReduction = {
            changed: false,
            savedChars: 0,
            passCount: 0,
            skippedReason: "unsupported_response_shape",
          };
        }
      } else if (proxyPureForward) {
          afterCallReduction = {
            changed: false,
            savedChars: 0,
            passCount: 0,
            skippedReason: "proxy_pure_forward",
          };
      }
      if (cfg.stateDir) {
        await appendTaskStateTrace(cfg.stateDir, {
          stage: "proxy_after_call_rewrite",
          sessionId: resolvedSessionId,
          model,
          proxyPureForward,
          responseContentType,
          parsedResponse: Boolean(parsedResponseForMirror),
          beforeTextChars: beforeAfterCallTextChars,
          afterTextChars: txt.length,
          changed: Boolean(afterCallReduction?.changed),
          savedChars: Number(afterCallReduction?.savedChars ?? 0),
          passCount: Number(afterCallReduction?.passCount ?? 0),
          skippedReason: afterCallReduction?.skippedReason ?? null,
          mode: afterCallReduction?.mode ?? null,
        });
      }
      {
        const parsedResponse = parsedResponseForMirror;
        const responseAt = new Date().toISOString();
        const responseRequestId = createHash("sha1")
          .update(JSON.stringify([
            responseAt,
            model,
            upstreamModel,
            activePayload?.prompt_cache_key ?? "",
            parsedResponse?.id ?? "",
            upstreamRespFinal.status,
          ]))
          .digest("hex")
          .slice(0, 16);
        const proxyRespLogPath = join(cfg.stateDir, "ecoclaw", "proxy-responses.jsonl");
        const respRecord = {
          at: responseAt,
          requestId: responseRequestId,
          stage: "proxy_response",
          model,
          upstreamModel,
          status: upstreamRespFinal.status,
          transport: upstreamRespFinal.transport,
          promptCacheKey: activePayload?.prompt_cache_key,
          promptCacheRetention: activePayload?.prompt_cache_retention,
          responseId: parsedResponse?.id ?? null,
          previousResponseId: parsedResponse?.previous_response_id ?? null,
          responsePromptCacheKey: parsedResponse?.prompt_cache_key ?? null,
          responsePromptCacheRetention: parsedResponse?.prompt_cache_retention ?? null,
          usage: parsedResponse?.usage ?? null,
          afterCallReduction: afterCallReduction ?? null,
          memoryFaultAutoReplayCount,
        };
        await mkdir(dirname(proxyRespLogPath), { recursive: true });
        await appendFile(proxyRespLogPath, `${JSON.stringify(respRecord)}\n`, "utf8");
        await appendReductionPassTrace(cfg.stateDir, {
          at: responseAt,
          stage: "proxy_response",
          model,
          upstreamModel,
          promptCacheKey: String(activePayload?.prompt_cache_key ?? ""),
          requestId: responseRequestId,
          report: afterCallReduction?.report ?? [],
          extra: {
            status: upstreamRespFinal.status,
            transport: upstreamRespFinal.transport,
            responseId: parsedResponse?.id ?? "",
            responseReductionChanged: Boolean(afterCallReduction?.changed),
            responseReductionSavedChars: Number(afterCallReduction?.savedChars ?? 0),
            memoryFaultAutoReplayCount,
          },
        });
      }
      {
        const forwardedRecord = {
          at: new Date().toISOString(),
          stage: "proxy_forwarded",
          sessionId: resolvedSessionId,
          model,
          upstreamModel,
          upstreamTransport: upstreamRespFinal.transport,
          forwardedHasPrev: typeof activePayload?.previous_response_id === "string" && activePayload.previous_response_id.length > 0,
          forwardedPromptCacheKey:
            typeof activePayload?.prompt_cache_key === "string" ? activePayload.prompt_cache_key : null,
          forwardedPromptCacheRetention:
            typeof activePayload?.prompt_cache_retention === "string" ? activePayload.prompt_cache_retention : null,
          forwardedInputCount: Array.isArray(activePayload?.input) ? activePayload.input.length : -1,
          forwardedInputRoles: Array.isArray(activePayload?.input)
            ? activePayload.input.map((x: any) => String(x?.role ?? ""))
            : [],
          forwardedReductionChangedItems: reductionApplied.changedItems,
          forwardedReductionChangedBlocks: reductionApplied.changedBlocks,
          forwardedReductionSavedChars: reductionApplied.savedChars,
          forwardedReductionReport: reductionApplied.report ?? null,
          afterCallReduction: afterCallReduction ?? null,
          memoryFaultAutoReplayCount,
          forwardedDeveloperChars:
            Array.isArray(activePayload?.input) &&
            activePayload.input.length > 0 &&
            String(activePayload.input[0]?.role) === "developer" &&
            typeof activePayload.input[0]?.content === "string"
              ? String(activePayload.input[0].content).length
              : 0,
          payload: activePayload,
        };
        await appendJsonl(cfg.debugTapPath, forwardedRecord);
        await appendForwardedInputDump(cfg.stateDir, resolvedSessionId, forwardedRecord);
      }
      if (cfg.debugTapProviderTraffic) {
        let parsedResponse: any = null;
        try {
          parsedResponse = JSON.parse(txt);
        } catch {}
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_outbound",
          model,
          upstreamModel,
          status: upstreamRespFinal.status,
          transport: upstreamRespFinal.transport,
          responseId:
            typeof parsedResponse?.id === "string"
              ? parsedResponse.id
              : typeof parsedResponse?.response?.id === "string"
                ? parsedResponse.response.id
                : null,
          previousResponseId:
            typeof parsedResponse?.previous_response_id === "string"
              ? parsedResponse.previous_response_id
              : typeof parsedResponse?.response?.previous_response_id === "string"
                ? parsedResponse.response.previous_response_id
                : null,
          promptCacheKey:
            typeof parsedResponse?.prompt_cache_key === "string"
              ? parsedResponse.prompt_cache_key
              : typeof parsedResponse?.response?.prompt_cache_key === "string"
                ? parsedResponse.response.prompt_cache_key
                : null,
          promptCacheRetention:
            typeof parsedResponse?.prompt_cache_retention === "string"
              ? parsedResponse.prompt_cache_retention
              : typeof parsedResponse?.response?.prompt_cache_retention === "string"
                ? parsedResponse.response.prompt_cache_retention
                : null,
          usage:
            parsedResponse?.usage ??
            parsedResponse?.response?.usage ??
            null,
          afterCallReduction,
          responseText: txt,
          memoryFaultAutoReplayCount,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      res.statusCode = upstreamRespFinal.status;
      res.setHeader("content-type", upstreamRespFinal.headers["content-type"] ?? "application/json");
      res.end(txt);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.proxyPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${cfg.proxyPort}/v1`;
  logger.info(`[ecoclaw] embedded responses proxy listening at ${baseUrl}`);
  return {
    baseUrl,
    upstream,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[Function]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = toJsonSafe(v, seen);
    }
    seen.delete(obj);
    return out;
  }
  return String(value);
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(toJsonSafe(payload))}\n`, "utf8");
}

async function appendTaskStateTrace(stateDir: string, payload: Record<string, unknown>): Promise<void> {
  await appendJsonl(join(stateDir, "task-state", "trace.jsonl"), {
    at: new Date().toISOString(),
    ...payload,
  });
}

async function appendForwardedInputDump(
  stateDir: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "_");
  await appendJsonl(join(stateDir, "ecoclaw", "forwarded-inputs", `${safeSessionId}.jsonl`), payload);
}

async function appendReductionPassTrace(
  stateDir: string,
  payload: {
    at: string;
    stage: "proxy_inbound" | "proxy_response";
    model: string;
    upstreamModel: string;
    promptCacheKey: string;
    requestId: string;
    report: Array<{
      id: string;
      phase: string;
      target: string;
      changed: boolean;
      note?: string;
      skippedReason?: string;
      beforeChars?: number;
      afterChars?: number;
      touchedSegmentIds?: string[];
    }>;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  if (!Array.isArray(payload.report) || payload.report.length === 0) return;
  const tracePath = join(stateDir, "ecoclaw", "reduction-pass-trace.jsonl");
  for (const entry of payload.report) {
    const beforeChars = Number(entry.beforeChars ?? 0);
    const afterChars = Number(entry.afterChars ?? beforeChars);
    await appendJsonl(tracePath, {
      at: payload.at,
      stage: payload.stage,
      requestId: payload.requestId,
      model: payload.model,
      upstreamModel: payload.upstreamModel,
      promptCacheKey: payload.promptCacheKey,
      passId: entry.id,
      phase: entry.phase,
      target: entry.target,
      changed: entry.changed,
      savedChars: Math.max(0, beforeChars - afterChars),
      beforeChars,
      afterChars,
      touchedSegmentIds: entry.touchedSegmentIds ?? [],
      note: entry.note ?? "",
      skippedReason: entry.skippedReason ?? "",
      ...(payload.extra ?? {}),
    });
  }
}

function resolveLlmHookTapPath(debugTapPath: string): string {
  if (debugTapPath.endsWith(".jsonl")) {
    return debugTapPath.slice(0, -".jsonl".length) + ".llm-hooks.jsonl";
  }
  return `${debugTapPath}.llm-hooks.jsonl`;
}

function installLlmHookTap(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): void {
  if (!cfg.debugTapProviderTraffic) return;
  const llmHookTapPath = resolveLlmHookTapPath(cfg.debugTapPath);
  const hookNames = [
    "before_prompt_build",
    "before_agent_start",
    "llm_input",
    "llm_output",
    "session_start",
    "session_end",
    "before_reset",
    "agent_end",
  ];
  for (const hookName of hookNames) {
    hookOn(api, hookName, async (event: any) => {
      try {
        const turnObservations = extractTurnObservations(event);
        const rec = {
          at: new Date().toISOString(),
          hook: hookName,
          sessionKey: extractSessionKey(event),
          derived: {
            lastUserMessage: extractLastUserMessage(event),
            turnObservationCount: turnObservations.length,
            turnObservations,
          },
          event,
        };
        await appendJsonl(llmHookTapPath, rec);
      } catch (err) {
        logger.warn(
          `[ecoclaw] llm-hook tap write failed(${hookName}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
  logger.info(`[ecoclaw] LLM hook tap enabled. path=${llmHookTapPath}`);
}

async function purgeTaskCacheWorkspace(stateDir: string, taskId: string): Promise<{ purged: string[] }> {
  const sessionsDir = join(stateDir, "ecoclaw", "sessions");
  const targetPrefix = `ecoclaw-task-${safeId(taskId)}-s`;
  let entries: Array<{ isDirectory: () => boolean; name: string }>;
  try {
    entries = (await readdir(sessionsDir, { withFileTypes: true, encoding: "utf8" })) as Array<{
      isDirectory: () => boolean;
      name: string;
    }>;
  } catch {
    return { purged: [] };
  }

  const purged: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(targetPrefix)) continue;
    const fullPath = join(sessionsDir, entry.name);
    await rm(fullPath, { recursive: true, force: true });
    purged.push(fullPath);
  }
  return { purged };
}

function makeLogger(input?: PluginLogger): Required<PluginLogger> {
  return {
    info: input?.info ?? ((...args) => console.log(...args)),
    debug: input?.debug ?? (() => {}),
    warn: input?.warn ?? ((...args) => console.warn(...args)),
    error: input?.error ?? ((...args) => console.error(...args)),
  };
}

function hookOn(api: any, event: string, handler: (...args: any[]) => any): void {
  if (typeof api.on === "function") {
    api.on(event, handler);
    return;
  }
  if (typeof api.registerHook === "function") {
    api.registerHook(event, handler);
  }
}

type EcoCanonicalState = {
  version: 1;
  sessionId: string;
  messages: any[];
  seenMessageIds: string[];
  updatedAt: string;
};

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function applyBeforeToolCallDefaults(event: any): Record<string, unknown> {
  const toolName = String(event?.toolName ?? event?.tool_name ?? "").trim().toLowerCase();
  const params = event?.params && typeof event.params === "object"
    ? { ...(event.params as Record<string, unknown>) }
    : {};
  if (toolName === "read") {
    if (!isPositiveNumber(params.limit)) params.limit = 200;
    if (!isPositiveNumber(params.offset)) params.offset = 1;
    return params;
  }
  if (toolName === "web_fetch") {
    if (!isPositiveNumber(params.maxChars)) params.maxChars = 12_000;
  }
  return params;
}

function isToolResultLikeMessage(message: Record<string, unknown>): boolean {
  const role = String(message.role ?? "").toLowerCase();
  const type = String(message.type ?? "").toLowerCase();
  return (
    role === "toolresult" ||
    role === "tool" ||
    type === "toolresult" ||
    type === "tool_result" ||
    type === "function_call_output"
  );
}

function resolveToolNameFromPersistEvent(event: any): string {
  return String(
    event?.toolName ??
      event?.tool_name ??
      event?.message?.toolName ??
      event?.message?.tool_name ??
      "",
  ).trim().toLowerCase();
}

function extractToolMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") return b.text;
      if (typeof b.content === "string") return b.content;
      return "";
    })
    .filter((v) => v.length > 0)
    .join("\n");
}

function ensureContextSafeDetails(
  details: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = details && typeof details === "object" ? { ...(details as Record<string, unknown>) } : {};
  const contextSafe =
    base.contextSafe && typeof base.contextSafe === "object"
      ? { ...(base.contextSafe as Record<string, unknown>) }
      : {};
  base.contextSafe = { ...contextSafe, ...patch };
  return base;
}

function contextSafeRecovery(details: unknown): Record<string, unknown> | undefined {
  const contextSafe = asRecord(asRecord(details)?.contextSafe);
  return asRecord(contextSafe?.recovery);
}

function hasRecoveryMarker(details: unknown): boolean {
  return Boolean(contextSafeRecovery(details));
}

function buildRecoveryContextSafePatch(source: string): Record<string, unknown> {
  return {
    recovery: {
      source,
      skipReduction: true,
      skipCompaction: true,
    },
  };
}

function messageToolCallId(message: Record<string, unknown>): string | undefined {
  const direct =
    typeof message.tool_call_id === "string" && message.tool_call_id.trim().length > 0
      ? message.tool_call_id.trim()
      : typeof message.toolCallId === "string" && message.toolCallId.trim().length > 0
        ? message.toolCallId.trim()
        : undefined;
  return direct;
}

function canonicalMessageTaskIds(message: Record<string, unknown>): string[] {
  const details = asRecord(message.details);
  const contextSafe = asRecord(details?.contextSafe);
  return Array.isArray(contextSafe?.taskIds)
    ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function extractCanonicalProtocolRefs(message: Record<string, unknown>): Array<{ callId: string; kind: "call" | "result" }> {
  const refs: Array<{ callId: string; kind: "call" | "result" }> = [];
  const directCallId = messageToolCallId(message);
  if (directCallId && isToolResultLikeMessage(message)) {
    refs.push({ callId: directCallId, kind: "result" });
  }
  const content = Array.isArray(message.content) ? message.content : [];
  for (const rawBlock of content) {
    const block = asRecord(rawBlock);
    if (!block) continue;
    const type = String(block.type ?? "").toLowerCase();
    if (type === "toolcall" || type === "tool_call" || type === "function_call") {
      const callId = String(block.id ?? block.call_id ?? block.tool_call_id ?? "").trim();
      if (callId) refs.push({ callId, kind: "call" });
      continue;
    }
    if (type === "function_call_output" || type === "tool_call_output" || type === "tool_result") {
      const callId = String(block.call_id ?? block.tool_call_id ?? block.id ?? "").trim();
      if (callId) refs.push({ callId, kind: "result" });
    }
  }
  return refs;
}

function computeClosureDeferredTaskInfo(messages: any[], evictableTaskIds: Set<string>): {
  deferredTaskIds: Set<string>;
  deferredByTaskId: Record<string, Array<{ callId: string; reason: "missing_call" | "missing_result" | "outside_candidate_task" }>>;
} {
  const protocolByCallId = new Map<string, {
    hasCall: boolean;
    hasResult: boolean;
    taskIds: Set<string>;
    hasOutsideCandidateTask: boolean;
  }>();

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const taskIds = canonicalMessageTaskIds(message);
    const refs = extractCanonicalProtocolRefs(message);
    if (refs.length === 0) continue;
    for (const ref of refs) {
      const bucket = protocolByCallId.get(ref.callId) ?? {
        hasCall: false,
        hasResult: false,
        taskIds: new Set<string>(),
        hasOutsideCandidateTask: false,
      };
      if (ref.kind === "call") bucket.hasCall = true;
      if (ref.kind === "result") bucket.hasResult = true;
      if (taskIds.length === 0) {
        bucket.hasOutsideCandidateTask = true;
      } else {
        for (const taskId of taskIds) {
          bucket.taskIds.add(taskId);
          if (!evictableTaskIds.has(taskId)) bucket.hasOutsideCandidateTask = true;
        }
      }
      protocolByCallId.set(ref.callId, bucket);
    }
  }

  const deferred = new Set<string>();
  const deferredByTaskId: Record<string, Array<{ callId: string; reason: "missing_call" | "missing_result" | "outside_candidate_task" }>> = {};
  for (const [callId, protocol] of protocolByCallId.entries()) {
    const protocolTaskIds = [...protocol.taskIds];
    if (protocolTaskIds.length === 0) continue;
    const reasons: Array<"missing_call" | "missing_result" | "outside_candidate_task"> = [];
    if (!protocol.hasCall) reasons.push("missing_call");
    if (!protocol.hasResult) reasons.push("missing_result");
    if (protocol.hasOutsideCandidateTask) reasons.push("outside_candidate_task");
    if (reasons.length === 0) continue;
    for (const taskId of protocolTaskIds) {
      if (!evictableTaskIds.has(taskId)) continue;
      deferred.add(taskId);
      const bucket = deferredByTaskId[taskId] ?? [];
      for (const reason of reasons) {
        bucket.push({ callId, reason });
      }
      deferredByTaskId[taskId] = bucket;
    }
  }
  return { deferredTaskIds: deferred, deferredByTaskId };
}

function sortedRegistryTurnAnchors(
  registry: Awaited<ReturnType<typeof loadSessionTaskRegistry>>,
): Array<{ turnAbsId: string; taskIds: string[] }> {
  return Object.entries(registry.turnToTaskIds)
    .map(([turnAbsId, taskIds]) => ({
      turnAbsId,
      taskIds: dedupeStrings(taskIds),
      turnSeq: Number(turnAbsId.split(":t").at(-1) ?? Number.NaN),
    }))
    .filter((item) => item.turnAbsId.trim().length > 0 && Number.isFinite(item.turnSeq))
    .sort((a, b) => a.turnSeq - b.turnSeq)
    .map(({ turnAbsId, taskIds }) => ({ turnAbsId, taskIds }));
}

function annotateCanonicalMessagesWithTaskAnchors(
  messages: any[],
  registry: Awaited<ReturnType<typeof loadSessionTaskRegistry>>,
): { messages: any[]; changed: boolean } {
  const anchors = sortedRegistryTurnAnchors(registry);
  if (anchors.length === 0) return { messages, changed: false };
  const anchorIndexByTurnAbsId = new Map(anchors.map((anchor, index) => [anchor.turnAbsId, index] as const));
  let currentIndex = -1;
  let currentAnchor = anchors[0];
  let changed = false;
  const nextMessages = messages.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const message = raw as Record<string, unknown>;
    const details = asRecord(message.details);
    const contextSafe = asRecord(details?.contextSafe);
    const existingEviction = asRecord(contextSafe?.eviction);
    if (existingEviction?.archived === true || existingEviction?.kind === "cached_pointer_stub") {
      return raw;
    }
    const prevTurnAbsId = typeof contextSafe?.turnAbsId === "string" ? contextSafe.turnAbsId : "";
    const prevTaskIds = Array.isArray(contextSafe?.taskIds)
      ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const anchoredIndex = prevTurnAbsId ? anchorIndexByTurnAbsId.get(prevTurnAbsId) : undefined;
    if (anchoredIndex !== undefined) {
      currentIndex = anchoredIndex;
      currentAnchor = anchors[anchoredIndex]!;
      const expectedTaskIds = currentAnchor?.taskIds ?? [];
      if (JSON.stringify(prevTaskIds) === JSON.stringify(expectedTaskIds)) {
        return raw;
      }
    }
    const role = String(message.role ?? "").toLowerCase();
    if (role === "user" && currentIndex + 1 < anchors.length) {
      currentIndex += 1;
      currentAnchor = anchors[currentIndex]!;
    } else if (currentIndex < 0) {
      currentIndex = 0;
      currentAnchor = anchors[0]!;
    }
    const nextTaskIds = currentAnchor?.taskIds ?? [];
    if (prevTurnAbsId === currentAnchor.turnAbsId && JSON.stringify(prevTaskIds) === JSON.stringify(nextTaskIds)) {
      return raw;
    }
    changed = true;
    return {
      ...message,
      details: ensureContextSafeDetails(message.details, {
        turnAbsId: currentAnchor.turnAbsId,
        taskIds: nextTaskIds,
      }),
    };
  });
  return { messages: nextMessages, changed };
}

function parseEvictedTaskIdFromMessage(message: Record<string, unknown>): string | undefined {
  const text = contentToText(message.content);
  const match = text.match(/\[Evicted completed task `([^`]+)`\]/);
  return typeof match?.[1] === "string" && match[1].trim().length > 0 ? match[1].trim() : undefined;
}

type CanonicalTaskArchiveInfo = {
  taskId: string;
  archivePath: string;
  dataKey: string;
  originalSize: number;
};

const canonicalEvictionLocks = new Map<string, Promise<void>>();

async function withCanonicalEvictionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = canonicalEvictionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  canonicalEvictionLocks.set(sessionId, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (canonicalEvictionLocks.get(sessionId) === current) {
      canonicalEvictionLocks.delete(sessionId);
    }
  }
}

async function loadCanonicalTaskArchives(
  stateDir: string,
  sessionId: string,
): Promise<Map<string, CanonicalTaskArchiveInfo>> {
  const archiveDir = join(stateDir, "ecoclaw", "canonical-eviction", "task");
  const out = new Map<string, CanonicalTaskArchiveInfo>();
  let entries: string[] = [];
  try {
    entries = await readdir(archiveDir);
  } catch {
    return out;
  }

  for (const name of entries.filter((item) => item.endsWith(".json")).sort().reverse()) {
    const archivePath = join(archiveDir, name);
    const archive = await readArchive(archivePath);
    if (!archive || archive.sessionId !== sessionId) continue;
    const metadata = asRecord(archive.metadata);
    const taskIds = Array.isArray(metadata?.taskIds)
      ? metadata.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    for (const taskId of taskIds) {
      if (out.has(taskId)) continue;
      out.set(taskId, {
        taskId,
        archivePath,
        dataKey: archive.dataKey,
        originalSize: archive.originalSize,
      });
    }
  }
  return out;
}

function resolveCanonicalToolCallInfo(messages: any[]): Map<string, { toolName: string; dataKey?: string }> {
  const out = new Map<string, { toolName: string; dataKey?: string }>();
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = String(message.role ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      const block = asRecord(item);
      if (!block) continue;
      const type = String(block.type ?? "").toLowerCase();
      if (type !== "toolcall" && type !== "tool_call") continue;
      const callId = typeof block.id === "string" ? block.id.trim() : "";
      const toolName = typeof block.name === "string" ? block.name.trim().toLowerCase() : "tool";
      const args = asRecord(block.arguments);
      const dataKey = extractPathLike(args);
      if (callId) out.set(callId, { toolName, dataKey });
    }
  }
  return out;
}

function canonicalArchiveTextForMessage(message: Record<string, unknown>): string {
  const role = String(message.role ?? "unknown").trim().toLowerCase() || "unknown";
  const toolName = String(message.toolName ?? message.tool_name ?? "").trim().toLowerCase();
  const text = isToolResultLikeMessage(message) ? extractToolMessageText(message) : contentToText(message.content);
  const normalizedText = text.trim();
  if (!normalizedText) return "";
  const header = toolName ? `${role}:${toolName}` : role;
  return `[${header}]\n${normalizedText}`;
}

async function applyCanonicalEviction(params: {
  stateDir: string;
  sessionId: string;
  messages: any[];
  registry: Awaited<ReturnType<typeof loadSessionTaskRegistry>>;
  enabled: boolean;
  policy: string;
  minBlockChars: number;
  replacementMode: "pointer_stub" | "drop";
}): Promise<{ messages: any[]; changed: boolean; appliedCount: number; appliedTaskIds: string[] }> {
  if (!params.enabled) {
    return { messages: params.messages, changed: false, appliedCount: 0, appliedTaskIds: [] };
  }
  const evictableTaskIds = new Set(params.registry.evictableTaskIds);
  if (evictableTaskIds.size === 0) {
    return { messages: params.messages, changed: false, appliedCount: 0, appliedTaskIds: [] };
  }
  return withCanonicalEvictionLock(params.sessionId, async () => {
    const { deferredTaskIds, deferredByTaskId } = computeClosureDeferredTaskInfo(params.messages, evictableTaskIds);
    await appendTaskStateTrace(params.stateDir, {
      stage: "canonical_eviction_closure_checked",
      sessionId: params.sessionId,
      evictableTaskIds: [...evictableTaskIds].sort(),
      deferredTaskIds: [...deferredTaskIds].sort(),
      deferredByTaskId,
      replacementMode: params.replacementMode,
      messageCount: params.messages.length,
    });
    const persistedArchives = await loadCanonicalTaskArchives(params.stateDir, params.sessionId);
    const rolePriority = (message: Record<string, unknown>): number => {
      const role = String(message.role ?? "").trim().toLowerCase();
      if (role === "assistant") return 0;
      if (role === "tool" || role === "toolresult") return 1;
      if (role === "user") return 2;
      return 3;
    };
    const bundles = new Map<string, {
      firstIndex: number;
      representativeIndex: number;
      messageIndexes: number[];
      turnAbsIds: string[];
      taskIds: string[];
      archiveParts: string[];
      totalChars: number;
      alreadyArchived: boolean;
    }>();
    const archivedTaskIds = new Set<string>();
    for (const raw of params.messages) {
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Record<string, unknown>;
      const details = asRecord(message.details);
      const contextSafe = asRecord(details?.contextSafe);
      const skipEviction = asRecord(contextSafe?.eviction)?.skip === true;
      if (skipEviction) continue;
      const existingEviction = asRecord(contextSafe?.eviction);
      if (existingEviction?.archived !== true && existingEviction?.kind !== "cached_pointer_stub") continue;
      const taskIds = Array.isArray(contextSafe?.taskIds)
        ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      for (const taskId of taskIds) archivedTaskIds.add(taskId);
      const parsedTaskId = parseEvictedTaskIdFromMessage(message);
      if (parsedTaskId) archivedTaskIds.add(parsedTaskId);
    }
    for (let index = 0; index < params.messages.length; index += 1) {
      const raw = params.messages[index];
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Record<string, unknown>;
      const details = asRecord(message.details);
      const contextSafe = asRecord(details?.contextSafe);
      const skipEviction = asRecord(contextSafe?.eviction)?.skip === true;
      if (skipEviction) continue;
      const taskIds = Array.isArray(contextSafe?.taskIds)
        ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      const matchedTaskIds = taskIds.filter((taskId) => evictableTaskIds.has(taskId));
      if (matchedTaskIds.length !== 1) continue;
      const taskId = matchedTaskIds[0]!;
      if (deferredTaskIds.has(taskId)) continue;
      if (archivedTaskIds.has(taskId)) continue;
      const existingEviction = asRecord(contextSafe?.eviction);
      const bundle = bundles.get(taskId) ?? {
        firstIndex: index,
        representativeIndex: index,
        messageIndexes: [],
        turnAbsIds: [],
        taskIds: [taskId],
        archiveParts: [],
        totalChars: 0,
        alreadyArchived: false,
      };
      bundle.firstIndex = Math.min(bundle.firstIndex, index);
      if (rolePriority(message) < rolePriority((params.messages[bundle.representativeIndex] ?? {}) as Record<string, unknown>)) {
        bundle.representativeIndex = index;
      }
      bundle.messageIndexes.push(index);
      if (typeof contextSafe?.turnAbsId === "string" && contextSafe.turnAbsId.trim().length > 0) {
        bundle.turnAbsIds.push(contextSafe.turnAbsId);
      }
      if (existingEviction?.archived === true || existingEviction?.kind === "cached_pointer_stub") {
        bundle.alreadyArchived = true;
      } else {
        const archiveText = canonicalArchiveTextForMessage(message);
        if (archiveText) {
          bundle.archiveParts.push(archiveText);
          bundle.totalChars += archiveText.length;
        }
      }
      bundles.set(taskId, bundle);
    }

    let changed = false;
    let appliedCount = 0;
    const appliedTaskIds: string[] = [];
    const nextMessages: any[] = [];
    const skipIndexes = new Set<number>();
    const stubByIndex = new Map<number, Record<string, unknown>>();
    for (const [taskId, bundle] of bundles.entries()) {
      if (bundle.alreadyArchived) continue;
      if (bundle.totalChars < params.minBlockChars) continue;
      const normalizedTurns = dedupeStrings(bundle.turnAbsIds);
      const representative = (params.messages[bundle.representativeIndex] ?? {}) as Record<string, unknown>;
      const representativeDetails = asRecord(representative.details);
      const representativeContextSafe = asRecord(representativeDetails?.contextSafe);
      const digest = createHash("sha256").update(bundle.archiveParts.join("\n\n")).digest("hex").slice(0, 16);
      const stableTaskId = safeId(taskId);
      const existingArchive = persistedArchives.get(taskId);
      const dataKey = existingArchive?.dataKey ?? `canonical_task_eviction:${stableTaskId}`;
      const archived = existingArchive
        ? { archivePath: existingArchive.archivePath }
        : await archiveContent({
            sessionId: params.sessionId,
            segmentId: `task-${stableTaskId}`,
            sourcePass: "canonical_eviction",
            toolName: "task",
            dataKey,
            originalText: bundle.archiveParts.join("\n\n"),
            archiveDir: join(params.stateDir, "ecoclaw", "canonical-eviction", "task"),
            metadata: {
              contentDigest: digest,
              evictionPolicy: params.policy,
              persistedBy: "ecoclaw.context_engine.eviction",
              taskIds: [taskId],
              turnAbsIds: normalizedTurns,
            },
          });
      const originalSize = existingArchive?.originalSize ?? bundle.totalChars;
      if (params.replacementMode === "pointer_stub") {
        const stub =
          `[Evicted completed task \`${taskId}\`] ` +
          `This earlier task was paged out from canonical context after completion. ` +
          buildRecoveryHint({
            dataKey,
            originalSize,
            archivePath: archived.archivePath,
            sourceLabel: "canonical_task_eviction",
          });
        stubByIndex.set(bundle.firstIndex, {
          role: "assistant",
          content: [{ type: "text", text: stub }],
          details: ensureContextSafeDetails(representative.details, {
            turnAbsId: normalizedTurns[0] ?? representativeContextSafe?.turnAbsId,
            taskIds: [taskId],
            eviction: {
              archived: true,
              kind: "cached_pointer_stub",
              archivePath: archived.archivePath,
              dataKey,
              policy: params.policy,
              persistedBy: "ecoclaw.context_engine.eviction",
              scope: "task",
            },
            originalChars: originalSize,
          }),
        });
        for (const idx of bundle.messageIndexes) {
          if (idx === bundle.firstIndex) continue;
          skipIndexes.add(idx);
        }
      } else {
        for (const idx of bundle.messageIndexes) {
          skipIndexes.add(idx);
        }
      }
      changed = true;
      appliedCount += 1;
      appliedTaskIds.push(taskId);
    }

    for (let index = 0; index < params.messages.length; index += 1) {
      const raw = params.messages[index];
      if (skipIndexes.has(index)) {
        continue;
      }
      const stub = stubByIndex.get(index);
      if (stub) {
        nextMessages.push(stub);
        continue;
      }
      if (!raw || typeof raw !== "object") {
        nextMessages.push(raw);
        continue;
      }
      nextMessages.push(raw);
    }
    return { messages: nextMessages, changed, appliedCount, appliedTaskIds };
  });
}

function buildToolResultPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[ecoclaw preview truncated]`;
}

function toolInlineLimit(toolName: string): number {
  if (toolName === "read") return 12_000;
  if (toolName === "exec" || toolName === "bash" || toolName === "web_fetch") return 4_000;
  return 8_000;
}

function canonicalStatePath(stateDir: string, sessionId: string): string {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(stateDir, "ecoclaw", "canonical-state", `${safeSessionId}.json`);
}

async function loadCanonicalState(stateDir: string, sessionId: string): Promise<EcoCanonicalState | null> {
  const path = canonicalStatePath(stateDir, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as EcoCanonicalState;
    if (!parsed || parsed.version !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) {
      return null;
    }
    const seenMessageIds = Array.isArray((parsed as any).seenMessageIds)
      ? ((parsed as any).seenMessageIds as unknown[])
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    return {
      version: 1,
      sessionId: parsed.sessionId,
      messages: parsed.messages,
      seenMessageIds,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

async function saveCanonicalState(stateDir: string, state: EcoCanonicalState): Promise<void> {
  const path = canonicalStatePath(stateDir, state.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

function estimateMessagesChars(messages: any[]): number {
  return messages.reduce((sum, msg) => sum + contentToText(msg?.content ?? "").length, 0);
}

function appendCanonicalTranscript(
  loaded: EcoCanonicalState | null,
  transcriptEntries: TranscriptSessionRow[],
  sessionId: string,
): { state: EcoCanonicalState; changed: boolean } {
  const rawEntries = Array.isArray(transcriptEntries) ? structuredClone(transcriptEntries) : [];
  if (!loaded) {
    return {
      state: {
        version: 1,
        sessionId,
        messages: rawEntries.map((entry) => entry.message),
        seenMessageIds: rawEntries.map(transcriptMessageStableId),
        updatedAt: new Date().toISOString(),
      },
      changed: true,
    };
  }

  const seen = new Set(
    Array.isArray(loaded.seenMessageIds)
      ? loaded.seenMessageIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
  );
  const newMessages: any[] = [];
  const newIds: string[] = [];
  for (const entry of rawEntries) {
    const stableId = transcriptMessageStableId(entry);
    if (seen.has(stableId)) continue;
    seen.add(stableId);
    newIds.push(stableId);
    newMessages.push(entry.message);
  }
  if (newMessages.length === 0) {
    return {
      state: {
        ...loaded,
        updatedAt: loaded.updatedAt,
      },
      changed: false,
    };
  }

  return {
    state: {
      version: 1,
      sessionId,
      messages: [...loaded.messages, ...newMessages],
      seenMessageIds: [...(Array.isArray(loaded.seenMessageIds) ? loaded.seenMessageIds : []), ...newIds],
      updatedAt: new Date().toISOString(),
    },
    changed: true,
  };
}

async function syncCanonicalStateFromTranscript(params: {
  stateDir: string;
  sessionId: string;
  logger?: Required<PluginLogger>;
}): Promise<{ state: EcoCanonicalState; changed: boolean }> {
  const loaded = await loadCanonicalState(params.stateDir, params.sessionId);
  const transcriptEntries = await readTranscriptEntriesForSession(params.sessionId);
  if (!transcriptEntries) {
    if (loaded) return { state: loaded, changed: false };
    const emptyState: EcoCanonicalState = {
      version: 1,
      sessionId: params.sessionId,
      messages: [],
      seenMessageIds: [],
      updatedAt: new Date().toISOString(),
    };
    return { state: emptyState, changed: false };
  }
  const appended = appendCanonicalTranscript(loaded, transcriptEntries, params.sessionId);
  await appendTaskStateTrace(params.stateDir, {
    stage: "canonical_state_sync",
    sessionId: params.sessionId,
    changed: appended.changed,
    loadedMessageCount: Array.isArray(loaded?.messages) ? loaded!.messages.length : 0,
    transcriptEntryCount: transcriptEntries.length,
    finalMessageCount: appended.state.messages.length,
    appendedMessageCount: Math.max(
      0,
      appended.state.messages.length - (Array.isArray(loaded?.messages) ? loaded!.messages.length : 0),
    ),
    seenMessageIdsCount: Array.isArray(appended.state.seenMessageIds) ? appended.state.seenMessageIds.length : 0,
  });
  return appended;
}

async function rewriteCanonicalState(params: {
  stateDir: string;
  sessionId: string;
  state: EcoCanonicalState;
  evictionEnabled?: boolean;
  evictionPolicy?: string;
  evictionMinBlockChars?: number;
  evictionReplacementMode?: "pointer_stub" | "drop";
  logger?: Required<PluginLogger>;
}): Promise<{ state: EcoCanonicalState; changed: boolean }> {
  const registry = await loadSessionTaskRegistry(params.stateDir, params.sessionId);
  const startMessages = params.state.messages;
  let messages = startMessages;
  let changed = false;
  const annotated = annotateCanonicalMessagesWithTaskAnchors(messages, registry);
  if (annotated.changed) {
    messages = annotated.messages;
    changed = true;
  }
  const evictionApplied = await applyCanonicalEviction({
    stateDir: params.stateDir,
    sessionId: params.sessionId,
    messages,
    registry,
    enabled: params.evictionEnabled === true,
    policy: params.evictionPolicy ?? "noop",
    minBlockChars: Math.max(0, params.evictionMinBlockChars ?? 256),
    replacementMode: params.evictionReplacementMode === "drop" ? "drop" : "pointer_stub",
  });
  if (evictionApplied.changed) {
    messages = evictionApplied.messages;
    changed = true;
    await appendTaskStateTrace(params.stateDir, {
      stage: "canonical_eviction_applied",
      sessionId: params.sessionId,
      appliedCount: evictionApplied.appliedCount,
      appliedTaskIds: evictionApplied.appliedTaskIds,
      evictableTaskIds: registry.evictableTaskIds,
      replacementMode: params.evictionReplacementMode === "drop" ? "drop" : "pointer_stub",
    });
    params.logger?.info(
      `[ecoclaw/eviction-apply] session=${params.sessionId} applied=${evictionApplied.appliedCount} tasks=${evictionApplied.appliedTaskIds.join(", ") || "none"}`,
    );
  }
  await appendTaskStateTrace(params.stateDir, {
    stage: "canonical_state_rewrite",
    sessionId: params.sessionId,
    changed,
    replacementMode: params.evictionReplacementMode === "drop" ? "drop" : "pointer_stub",
    beforeMessageCount: startMessages.length,
    afterAnnotationMessageCount: annotated.changed ? annotated.messages.length : startMessages.length,
    afterEvictionMessageCount: messages.length,
    beforeChars: estimateMessagesChars(startMessages),
    afterChars: estimateMessagesChars(messages),
    evictableTaskIds: registry.evictableTaskIds,
  });
  return {
    state: changed
      ? {
          ...params.state,
          messages,
          updatedAt: new Date().toISOString(),
        }
      : params.state,
    changed,
  };
}

function createEcoClawContextEngine(
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
) {
  return {
    info: {
      id: "ecoclaw-context",
      name: "EcoClaw Context Engine",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: false };
    },
    async afterTurn(params: { sessionId: string; messages: any[] }) {
      const synced = await syncCanonicalStateFromTranscript({
        stateDir: cfg.stateDir,
        sessionId: params.sessionId,
        logger,
      });
      const rewritten = await rewriteCanonicalState({
        stateDir: cfg.stateDir,
        sessionId: params.sessionId,
        state: synced.state,
        evictionEnabled: cfg.modules.eviction && cfg.eviction.enabled,
        evictionPolicy: cfg.eviction.policy,
        evictionMinBlockChars: cfg.eviction.minBlockChars,
        evictionReplacementMode: cfg.eviction.replacementMode,
        logger,
      });
      if (synced.changed || rewritten.changed) {
        await saveCanonicalState(cfg.stateDir, rewritten.state);
      }
    },
    async assemble(params: { sessionId: string; messages: any[]; tokenBudget?: number }) {
      const synced = await syncCanonicalStateFromTranscript({
        stateDir: cfg.stateDir,
        sessionId: params.sessionId,
        logger,
      });
      const rewritten = await rewriteCanonicalState({
        stateDir: cfg.stateDir,
        sessionId: params.sessionId,
        state: synced.state,
        evictionEnabled: cfg.modules.eviction && cfg.eviction.enabled,
        evictionPolicy: cfg.eviction.policy,
        evictionMinBlockChars: cfg.eviction.minBlockChars,
        evictionReplacementMode: cfg.eviction.replacementMode,
        logger,
      });
      if (synced.changed || rewritten.changed) {
        await saveCanonicalState(cfg.stateDir, rewritten.state);
      }
      const estimatedChars = estimateMessagesChars(rewritten.state.messages);
      return {
        messages: rewritten.state.messages,
        estimatedTokens: Math.max(1, Math.ceil(estimatedChars / 4)),
      };
    },
    async compact(params: { sessionId: string; messages?: any[]; force?: boolean }) {
      const synced = await syncCanonicalStateFromTranscript({
        stateDir: cfg.stateDir,
        sessionId: params.sessionId,
        logger,
      });
      const rewritten = await rewriteCanonicalState({
        stateDir: cfg.stateDir,
        sessionId: params.sessionId,
        state: synced.state,
        evictionEnabled: cfg.modules.eviction && cfg.eviction.enabled,
        evictionPolicy: cfg.eviction.policy,
        evictionMinBlockChars: cfg.eviction.minBlockChars,
        evictionReplacementMode: cfg.eviction.replacementMode,
        logger,
      });
      if (synced.changed || rewritten.changed) {
        await saveCanonicalState(cfg.stateDir, rewritten.state);
      }
      return {
        ok: true,
        compacted: synced.changed || rewritten.changed,
        reason: synced.changed || rewritten.changed
          ? "ecoclaw canonical state updated"
          : "ecoclaw canonical state unchanged",
      };
    },
  };
}

async function applyToolResultPersistPolicy(
  event: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): Promise<{ message: Record<string, unknown> } | undefined> {
  const message = event?.message;
  if (!message || typeof message !== "object") return undefined;
  const rawMessage = message as Record<string, unknown>;
  if (!isToolResultLikeMessage(rawMessage)) return { message: rawMessage };

  const toolName = resolveToolNameFromPersistEvent(event);
  const text = extractToolMessageText(rawMessage);
  const limit = toolInlineLimit(toolName);
  if (text.length <= limit) {
    return {
      message: {
        ...rawMessage,
        details: ensureContextSafeDetails(rawMessage.details, {
          resultMode: "inline",
        }),
      },
    };
  }

  const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const callId = String(event?.toolCallId ?? event?.tool_call_id ?? "").trim();
  const toolPart = safeId(toolName || "tool");
  const dataKey = `tool_result_persist:${toolPart}:${callId ? safeId(callId) : digest}`;

  let outputFile: string | undefined;
  try {
    const archived = await archiveContent({
      sessionId: "proxy-session",
      segmentId: callId || `${toolPart}-${digest}`,
      sourcePass: "tool_result_persist",
      toolName: toolName || "tool",
      dataKey,
      originalText: text,
      archiveDir: join(cfg.stateDir, "ecoclaw", "artifacts", toolPart),
      metadata: {
        toolCallId: callId || undefined,
        persistedBy: "ecoclaw.tool_result_persist",
      },
    });
    outputFile = archived.archivePath;
  } catch (err) {
    logger.warn(`[ecoclaw] tool_result_persist artifact write failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const preview = buildToolResultPreview(text, limit);
  const notice = outputFile
    ? `[ecoclaw persisted tool_result] full output moved to: ${outputFile}`
    : "[ecoclaw persisted tool_result] artifact write failed, using inline preview fallback";
  const recoveryHint = outputFile
    ? buildRecoveryHint({
      dataKey,
      originalSize: text.length,
      archivePath: outputFile,
      sourceLabel: "tool_result_persist",
    })
    : "";

  if (cfg.stateDir) {
    await appendTaskStateTrace(cfg.stateDir, {
      stage: "tool_result_persist_applied",
      sessionId: String(event?.sessionId ?? event?.session_id ?? "proxy-session"),
      toolName: toolName || "tool",
      toolCallId: callId || null,
      originalChars: text.length,
      inlineLimit: limit,
      persisted: Boolean(outputFile),
      outputFile: outputFile ?? null,
      dataKey,
    });
  }

  return {
    message: {
      ...rawMessage,
      content: `${notice}\n\n${preview}${recoveryHint}`,
      details: ensureContextSafeDetails(rawMessage.details, {
        resultMode: outputFile ? "artifact" : "inline-fallback",
        excludedFromContext: true,
        outputFile,
        dataKey,
        originalChars: text.length,
        previewChars: limit,
        sourcePass: "tool_result_persist",
        persistedBy: "ecoclaw.tool_result_persist",
      }),
    },
  };
}

function maybeRegisterProxyProvider(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
  baseUrl: string,
  upstream: UpstreamConfig,
) {
  if (typeof api.registerProvider !== "function") {
    logger.warn("[ecoclaw] registerProvider not supported by this OpenClaw version.");
    return;
  }

  try {
    const modelIds = upstream.models.map((m) => m.id);
    const modelDefs = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-responses",
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    api.registerProvider({
      id: "ecoclaw",
      name: "EcoClaw Router",
      label: "EcoClaw Router",
      api: "openai-responses",
      baseUrl,
      apiKey: cfg.proxyApiKey ?? "ecoclaw-local",
      authHeader: false,
      models: modelIds.length > 0 ? modelDefs : ["gpt-5.4"],
    });
    logger.info(
      `[ecoclaw] Registered provider ecoclaw/* via embedded proxy. mirrored=${modelIds.slice(0, 6).join(",")}${modelIds.length > 6 ? "..." : ""}`,
    );
  } catch (err: unknown) {
    logger.error(`[ecoclaw] Failed to register provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function extractSessionKey(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionKey ??
    event?.SessionKey ??
    event?.result?.sessionKey ??
    event?.result?.SessionKey ??
    event?.meta?.sessionKey ??
    event?.meta?.SessionKey ??
    event?.ctx?.SessionKey ??
    event?.ctx?.CommandTargetSessionKey ??
    event?.session?.key ??
    event?.sessionId ??
    event?.result?.sessionId ??
    agentMeta?.sessionKey ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const channel = String(event?.channel ?? event?.from?.channel ?? "unknown").trim();
  const channelId = String(event?.channelId ?? event?.to?.id ?? event?.conversationId ?? "").trim();
  const threadId = String(event?.messageThreadId ?? event?.threadId ?? "").trim();
  const senderId = String(event?.senderId ?? event?.from?.id ?? "").trim();
  const scoped = [channel, channelId, threadId, senderId].filter((x) => x.length > 0);
  if (scoped.length > 0) return `scoped:${scoped.join(":")}`;

  return "unknown";
}

function extractOpenClawSessionId(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const sessionFile =
    event?.sessionFile ??
    event?.result?.sessionFile ??
    event?.meta?.sessionFile ??
    agentMeta?.sessionFile ??
    "";
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    const fileBase = basename(sessionFile.trim()).replace(/\.jsonl$/i, "").trim();
    if (fileBase.length > 0) return fileBase;
  }
  const direct =
    event?.sessionId ??
    event?.SessionId ??
    event?.ctx?.SessionId ??
    event?.result?.sessionId ??
    event?.result?.SessionId ??
    event?.meta?.sessionId ??
    event?.meta?.SessionId ??
    event?.session?.id ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return "";
}

function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToText(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "thinking" || obj.type === "reasoning") {
      return "";
    }
    if (obj.type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    const preferred = obj.text ?? obj.content ?? obj.value ?? obj.message;
    if (preferred !== undefined) {
      const nested = contentToText(preferred);
      if (nested.trim().length > 0) return nested;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(value);
}

function extractResponseTextFromProviderNode(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return contentToText(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractResponseTextFromProviderNode(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    const role = String(obj.role ?? "").toLowerCase();
    if (type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.delta === "string" && obj.delta.trim().length > 0) {
      return obj.delta;
    }
    if (type === "message" || role === "assistant") {
      return extractResponseTextFromProviderNode(obj.content ?? obj.output ?? obj.text);
    }
    return extractResponseTextFromProviderNode(
      obj.response ?? obj.output ?? obj.item ?? obj.content ?? obj.text ?? obj.message,
    );
  }
  return "";
}

function extractProviderResponseText(rawText: string, parsed?: unknown): string {
  const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const parsedType = String(parsedRecord?.type ?? "").toLowerCase();
  const fromParsed =
    parsedType === "response.created"
      ? ""
      : extractResponseTextFromProviderNode(parsed);
  if (fromParsed.trim().length > 0) return fromParsed.trim();

  let deltaText = "";
  const lines = String(rawText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const record = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      const type = String(record.type ?? "").toLowerCase();
      if (type === "response.created") continue;
      const fromRecord = extractResponseTextFromProviderNode(
        record.response ?? record.output ?? record.item ?? record,
      );
      if (fromRecord.trim().length > 0) return fromRecord.trim();
      if (typeof record.delta === "string") {
        deltaText += record.delta;
      }
    } catch {
      // ignore malformed stream fragments
    }
  }
  return deltaText.trim();
}

function extractLastUserMessage(event: any): string {
  const promptText = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  if (promptText) return promptText;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  return contentToText(lastUser?.content ?? event?.message?.content ?? event?.message ?? "");
}

function extractLastAssistant(event: any): any {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const fromMessages = [...messages].reverse().find((m: any) => m?.role === "assistant");
  if (fromMessages) return fromMessages;

  const payloads = Array.isArray(event?.result?.payloads) ? event.result.payloads : [];
  if (payloads.length === 0) return null;
  const payloadText = payloads
    .map((payload: any) => contentToText(payload?.text ?? payload?.content ?? payload))
    .filter((s: string) => s.trim().length > 0)
    .join("\n");
  const lastPayload = payloads[payloads.length - 1];

  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta ?? {};
  const usage = agentMeta?.lastCallUsage ?? agentMeta?.usage ?? event?.usage ?? {};
  return {
    role: "assistant",
    content: payloadText || contentToText(lastPayload?.text ?? lastPayload?.content ?? ""),
    provider: agentMeta?.provider ?? event?.provider,
    model: agentMeta?.model ?? event?.model,
    usage,
  };
}

type StructuredTurnObservation = {
  id: string;
  role: "tool" | "observation";
  text: string;
  payloadKind?: "stdout" | "stderr" | "json" | "blob";
  toolName?: string;
  source: string;
  messageIndex?: number;
  mimeType?: string;
  textChars: number;
  textPreview: string;
  metadata?: Record<string, unknown>;
  recovery?: {
    source: string;
    skipReduction?: boolean;
    skipCompaction?: boolean;
  };
};

function inferObservationPayloadKind(
  text: string,
  fallback?: unknown,
): StructuredTurnObservation["payloadKind"] | undefined {
  if (typeof fallback === "string") {
    const normalized = fallback.trim().toLowerCase();
    if (
      normalized === "stdout" ||
      normalized === "stderr" ||
      normalized === "json" ||
      normalized === "blob"
    ) {
      return normalized;
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/^stderr\s*[:=-]/i.test(trimmed)) return "stderr";
  if (/^stdout\s*[:=-]/i.test(trimmed)) return "stdout";
  if (/^blob\s*[:=-]/i.test(trimmed)) return "blob";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // fall through
  }
  if (/^data:[^;]+;base64,/i.test(trimmed)) return "blob";
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return "blob";
  return undefined;
}

function buildToolCallArgsMap(messages: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const msg of messages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "toolCall" && item.type !== "tool_call") continue;
      const callId =
        typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : undefined;
      if (!callId) continue;
      const toolName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : undefined;
      const args =
        item.arguments && typeof item.arguments === "object"
          ? (item.arguments as Record<string, unknown>)
          : undefined;
      const path =
        typeof args?.path === "string" && args.path.trim().length > 0
          ? args.path.trim()
          : typeof args?.file_path === "string" && args.file_path.trim().length > 0
            ? args.file_path.trim()
            : typeof args?.filePath === "string" && args.filePath.trim().length > 0
              ? args.filePath.trim()
              : undefined;
      map.set(callId, { toolName, path });
    }
  }
  return map;
}

function isWriteLikeToolName(toolName: string | undefined): boolean {
  const normalized = String(toolName ?? "").trim().toLowerCase();
  return normalized === "write" || normalized.endsWith(".write") || normalized.includes("write_file");
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function summarizeText(text: string, maxChars = 800): string {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return contentToText(content).trim();
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      const text = contentToText(item).trim();
      if (text) parts.push(text);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    if (type === "toolcall" || type === "tool_call") continue;
    const text = contentToText(obj).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n").trim();
}

function extractFileRefsFromToolArgs(args: Record<string, unknown> | undefined): {
  filesRead: string[];
  filesWritten: string[];
} {
  const candidates = [
    args?.path,
    args?.file_path,
    args?.filePath,
    args?.output,
    args?.output_path,
    args?.outputPath,
  ];
  const normalized = candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  const filesRead = dedupeStrings(normalized.filter((_, index) => index < 1));
  const filesWritten = dedupeStrings(normalized.filter((_, index) => index >= 1));
  return { filesRead, filesWritten };
}

function sliceMessagesForCurrentUserTurn(messages: any[]): any[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  return lastUserIndex >= 0 ? messages.slice(lastUserIndex) : messages;
}

function sliceMessagesForTurnSeq(messages: any[], turnSeq: number): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const role = String(messages[i]?.role ?? "").toLowerCase();
    if (role === "user") userIndices.push(i);
  }
  if (userIndices.length === 0) return [];
  const turnIndex = Math.max(0, turnSeq - 1);
  if (turnIndex >= userIndices.length) return [];
  const start = userIndices[turnIndex]!;
  const endExclusive = turnIndex + 1 < userIndices.length ? userIndices[turnIndex + 1]! : messages.length;
  return messages.slice(start, endExclusive);
}

function extractTurnObservations(event: any): StructuredTurnObservation[] {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const toolCallArgsMap = buildToolCallArgsMap(messages);
  const out: StructuredTurnObservation[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "tool" && role !== "observation" && role !== "toolresult") continue;
    const text = contentToText(msg?.content ?? msg?.text ?? "").trim();
    if (!text) continue;
    const payloadKind = inferObservationPayloadKind(
      text,
      msg?.payloadKind ?? msg?.kind ?? msg?.type,
    );
    const toolName =
      typeof msg?.name === "string" && msg.name.trim().length > 0
        ? msg.name.trim()
        : typeof msg?.toolName === "string" && msg.toolName.trim().length > 0
          ? msg.toolName.trim()
          : typeof msg?.tool_name === "string" && msg.tool_name.trim().length > 0
            ? msg.tool_name.trim()
            : undefined;
    const callId =
      typeof msg?.tool_call_id === "string" && msg.tool_call_id.trim().length > 0
        ? msg.tool_call_id.trim()
        : typeof msg?.toolCallId === "string" && msg.toolCallId.trim().length > 0
          ? msg.toolCallId.trim()
          : undefined;
    const toolCallArgs = callId ? toolCallArgsMap.get(callId) : undefined;
    const resolvedPath = toolCallArgs?.path;
    const recovery = contextSafeRecovery(msg?.details);
    const metadata: Record<string, unknown> | undefined = resolvedPath
      ? { path: resolvedPath, file_path: resolvedPath }
      : undefined;
    out.push({
      id: callId ?? `msg-${i + 1}`,
      role: role === "tool" || role === "toolresult" ? "tool" : "observation",
      text,
      payloadKind,
      toolName: toolName ?? toolCallArgs?.toolName,
      source: "event.messages",
      messageIndex: i,
      mimeType:
        typeof msg?.mime_type === "string" && msg.mime_type.trim().length > 0
          ? msg.mime_type.trim()
          : typeof msg?.mimeType === "string" && msg.mimeType.trim().length > 0
            ? msg.mimeType.trim()
            : undefined,
      textChars: text.length,
      textPreview: text.length > 240 ? `${text.slice(0, 240)}...` : text,
      ...(metadata ? { metadata } : {}),
      ...(recovery
        ? {
            recovery: {
              source:
                typeof recovery.source === "string" && recovery.source.trim().length > 0
                  ? recovery.source.trim()
                  : MEMORY_FAULT_RECOVER_TOOL_NAME,
              skipReduction: recovery.skipReduction === true,
              skipCompaction: recovery.skipCompaction === true,
            },
          }
        : {}),
    });
  }
  return out;
}

function buildRawSemanticTurnRecordFromMessages(
  sessionId: string,
  turnSeq: number,
  messages: any[],
): RawSemanticTurnRecord | null {
  const scopedMessages = sliceMessagesForCurrentUserTurn(messages);
  if (scopedMessages.length === 0) return null;

  const userAnchor = createTurnAnchor(sessionId, turnSeq, "user");
  const assistantAnchor = createTurnAnchor(sessionId, turnSeq, "assistant");
  const toolAnchor = createTurnAnchor(sessionId, turnSeq, "tool");
  const rawRecord: RawSemanticTurnRecord = {
    sessionId,
    turnSeq,
    turnAbsId: buildTurnAbsId(sessionId, turnSeq),
    messages: [],
    toolCalls: [],
    toolResults: [],
  };

  for (const msg of scopedMessages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role === "user") {
      const text = contentToText(msg?.content ?? msg?.text ?? "").trim();
      if (!text) continue;
      rawRecord.messages.push({
        anchor: userAnchor,
        role: "user",
        text,
      });
      continue;
    }
    if (role === "assistant") {
      const assistantText = extractAssistantText(msg?.content ?? msg?.text ?? "").trim();
      if (assistantText) {
        rawRecord.messages.push({
          anchor: assistantAnchor,
          role: "assistant",
          text: assistantText,
        });
      }
      const content = Array.isArray(msg?.content) ? msg.content : [];
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const type = String(obj.type ?? "").toLowerCase();
        if (type !== "toolcall" && type !== "tool_call") continue;
        const toolCallId =
          typeof obj.id === "string" && obj.id.trim().length > 0 ? obj.id.trim() : "";
        const toolName =
          typeof obj.name === "string" && obj.name.trim().length > 0 ? obj.name.trim() : "unknown";
        const args =
          obj.arguments && typeof obj.arguments === "object"
            ? (obj.arguments as Record<string, unknown>)
            : undefined;
        const argumentsText = args ? JSON.stringify(args) : undefined;
        const refs = extractFileRefsFromToolArgs(args);
        rawRecord.toolCalls.push({
          anchor: assistantAnchor,
          toolCallId: toolCallId || `toolcall-${rawRecord.toolCalls.length + 1}`,
          toolName,
          argumentsText,
          argumentsSummary: summarizeText(argumentsText ?? toolName, 400),
          ...(refs.filesRead.length > 0 ? { filesRead: refs.filesRead } : {}),
          ...(refs.filesWritten.length > 0 ? { filesWritten: refs.filesWritten } : {}),
        });
      }
      continue;
    }
  }

  const observations = extractTurnObservations({ messages: scopedMessages });
  for (const observation of observations) {
    const filePath =
      typeof observation.metadata?.path === "string" && observation.metadata.path.trim().length > 0
        ? observation.metadata.path.trim()
        : undefined;
    rawRecord.toolResults.push({
      anchor: toolAnchor,
      toolCallId: observation.id,
      toolName: observation.toolName ?? "unknown",
      status: observation.payloadKind === "stderr" ? "error" : "success",
      fullText: observation.text,
      summary: summarizeText(observation.text, 800),
      rawContentRef: filePath,
      ...(observation.recovery ? { recovery: observation.recovery } : {}),
      ...(filePath
        ? isWriteLikeToolName(observation.toolName)
          ? { filesWritten: [filePath] }
          : { filesRead: [filePath] }
        : {}),
    });
  }

  if (
    rawRecord.messages.length === 0 &&
    rawRecord.toolCalls.length === 0 &&
    rawRecord.toolResults.length === 0
  ) {
    return null;
  }

  return rawRecord;
}

function dedupeRawSemanticMessages(record: RawSemanticTurnRecord["messages"]): RawSemanticTurnRecord["messages"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["messages"] = [];
  for (const item of record) {
    const key = `${item.anchor.turnAbsId}:${item.role}:${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeRawSemanticToolCalls(record: RawSemanticTurnRecord["toolCalls"]): RawSemanticTurnRecord["toolCalls"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["toolCalls"] = [];
  for (const item of record) {
    const key = `${item.toolCallId}:${item.toolName}:${item.argumentsText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeRawSemanticToolResults(record: RawSemanticTurnRecord["toolResults"]): RawSemanticTurnRecord["toolResults"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["toolResults"] = [];
  for (const item of record) {
    const key = `${item.toolCallId}:${item.toolName}:${item.status}:${item.fullText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function resolveOpenClawStateRoot(): string {
  const explicit =
    String(process.env.OPENCLAW_STATE_DIR ?? "").trim()
    || String(process.env.OPENCLAW_HOME ?? "").trim();
  if (explicit) return explicit;
  return join(homedir(), ".openclaw");
}

async function findTranscriptPathForSession(sessionId: string): Promise<string | null> {
  const stateRoot = resolveOpenClawStateRoot();
  const agentsDir = join(stateRoot, "agents");
  try {
    const agentEntries = await readdir(agentsDir, { withFileTypes: true });
    for (const agentEntry of agentEntries) {
      if (!agentEntry.isDirectory()) continue;
      const candidate = join(agentsDir, agentEntry.name, "sessions", `${sessionId}.jsonl`);
      try {
        await readFile(candidate, "utf8");
        return candidate;
      } catch {
        // keep scanning
      }
    }
  } catch {
    return null;
  }
  return null;
}

type TranscriptSessionRow = {
  id?: string;
  parentId?: string;
  timestamp?: string;
  message: Record<string, unknown>;
};

function normalizeTranscriptMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as Record<string, unknown>;
      const type = typeof block.type === "string" ? block.type : "block";
      if (typeof block.text === "string") return `${type}:${block.text.trim()}`;
      if ((type === "toolCall" || type === "tool_call") && typeof block.name === "string") {
        return `${type}:${block.name}:${JSON.stringify(block.arguments ?? {}, Object.keys(block.arguments ?? {}).sort())}`;
      }
      return JSON.stringify(block);
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

function transcriptMessageStableId(row: TranscriptSessionRow): string {
  const nativeId = typeof row.id === "string" ? row.id.trim() : "";
  if (nativeId) return nativeId;
  const message = row.message;
  const role = typeof message.role === "string" ? message.role.trim() : "";
  const toolCallId =
    typeof message.toolCallId === "string" ? message.toolCallId.trim()
    : typeof (message as any).tool_call_id === "string" ? String((message as any).tool_call_id).trim()
    : "";
  const toolName =
    typeof message.toolName === "string" ? message.toolName.trim()
    : typeof (message as any).tool_name === "string" ? String((message as any).tool_name).trim()
    : "";
  const timestamp =
    (typeof row.timestamp === "string" && row.timestamp.trim().length > 0 ? row.timestamp.trim() : "")
    || (typeof message.timestamp === "string" ? message.timestamp.trim() : "")
    || (typeof message.timestamp === "number" ? String(message.timestamp) : "");
  const basis = [
    role,
    toolCallId,
    toolName,
    timestamp,
    normalizeTranscriptMessageText(message),
  ].join("|");
  return createHash("sha256").update(basis).digest("hex").slice(0, 20);
}

async function readTranscriptEntriesForSession(sessionId: string): Promise<TranscriptSessionRow[] | null> {
  const transcriptPath = await findTranscriptPathForSession(sessionId);
  if (!transcriptPath) return null;
  let raw = "";
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const entries: TranscriptSessionRow[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>;
      if (row.type !== "message") continue;
      const message = row.message;
      if (!message || typeof message !== "object") continue;
      entries.push({
        id: typeof row.id === "string" ? row.id : undefined,
        parentId: typeof row.parentId === "string" ? row.parentId : undefined,
        timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
        message: structuredClone(message as Record<string, unknown>),
      });
    } catch {
      // Ignore malformed transcript rows.
    }
  }
  return entries;
}

async function readTranscriptMessagesForSession(sessionId: string): Promise<any[] | null> {
  const entries = await readTranscriptEntriesForSession(sessionId);
  if (!entries) return null;
  return entries.map((entry) => entry.message);
}

async function buildRawSemanticTurnRecordFromTranscript(
  sessionId: string,
  turnSeq: number,
): Promise<RawSemanticTurnRecord | null> {
  const messages = await readTranscriptMessagesForSession(sessionId);
  if (!messages || messages.length === 0) return null;
  const scopedMessages = sliceMessagesForTurnSeq(messages, turnSeq);
  if (scopedMessages.length === 0) return null;
  return buildRawSemanticTurnRecordFromMessages(sessionId, turnSeq, scopedMessages);
}

async function syncRawSemanticTurnsFromTranscript(
  stateDir: string,
  sessionId: string,
): Promise<{ changed: boolean; turnCount: number; updatedTurnSeqs: number[] }> {
  const messages = await readTranscriptMessagesForSession(sessionId);
  if (!messages || messages.length === 0) {
    return { changed: false, turnCount: 0, updatedTurnSeqs: [] };
  }
  let turnCount = 0;
  for (const message of messages) {
    if (String(message?.role ?? "").toLowerCase() === "user") {
      turnCount += 1;
    }
  }
  if (turnCount === 0) {
    return { changed: false, turnCount: 0, updatedTurnSeqs: [] };
  }
  const updatedTurnSeqs: number[] = [];
  for (let turnSeq = 1; turnSeq <= turnCount; turnSeq += 1) {
    const record = await buildRawSemanticTurnRecordFromTranscript(sessionId, turnSeq);
    if (!record) continue;
    const existing = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
    const nextMessages = dedupeRawSemanticMessages(record.messages);
    const nextToolCalls = dedupeRawSemanticToolCalls(record.toolCalls);
    const nextToolResults = dedupeRawSemanticToolResults(record.toolResults);
    const same =
      existing
      && JSON.stringify(existing.messages) === JSON.stringify(nextMessages)
      && JSON.stringify(existing.toolCalls) === JSON.stringify(nextToolCalls)
      && JSON.stringify(existing.toolResults) === JSON.stringify(nextToolResults);
    if (same) continue;
    await persistRawSemanticTurnRecord(stateDir, {
      ...record,
      messages: nextMessages,
      toolCalls: nextToolCalls,
      toolResults: nextToolResults,
    });
    updatedTurnSeqs.push(turnSeq);
  }
  return {
    changed: updatedTurnSeqs.length > 0,
    turnCount,
    updatedTurnSeqs,
  };
}

function registerEcoClawCommand(
  api: any,
  logger: Required<PluginLogger>,
  topology: SessionTopologyManager,
  cfg: ReturnType<typeof normalizeConfig>,
): void {
  if (typeof api.registerCommand !== "function") {
    logger.debug("[ecoclaw] registerCommand unavailable, fallback to inline command parsing.");
    return;
  }

  const handler = async (ctxOrRaw?: any, legacyContext?: any) => {
    const args =
      typeof ctxOrRaw === "string"
        ? ctxOrRaw
        : typeof ctxOrRaw?.args === "string"
          ? ctxOrRaw.args
          : "";
    const context = legacyContext ?? ctxOrRaw ?? {};
    const cmd = parseEcoClawCommand(`ecoclaw ${String(args).trim()}`.trim());
    const sessionKey = extractSessionKey(context) || "unknown";
    logger.info(
      `[ecoclaw] command invoked kind=${cmd.kind} args="${String(args ?? "").trim()}" session=${sessionKey}`,
    );
    if (cmd.kind === "status") {
      return { text: topology.getStatus(sessionKey) };
    }
    if (cmd.kind === "cache_new") {
      const logical = topology.newTaskCache(sessionKey, cmd.taskId);
      return {
        text:
          `Created task-cache and switched current binding.\n${topology.getStatus(sessionKey)}\nlogical=${logical}\n\n` +
          `Reminder: this switches EcoClaw task-cache only.\n` +
          `If you want a truly clean upstream OpenClaw context, run /new now.`,
      };
    }
    if (cmd.kind === "cache_list") {
      return { text: topology.listTaskCaches(sessionKey) };
    }
    if (cmd.kind === "cache_delete") {
      const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
      if (!removed) {
        return { text: `No matching task-cache found for ${cmd.taskId ? `"${safeId(cmd.taskId)}"` : "current binding"}.` };
      }
      const purge = await purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId);
      return {
        text: `Deleted task-cache "${removed.removedTaskId}" (bindings=${removed.removedBindings}, purged=${purge.purged.length}).\n${topology.getStatus(sessionKey)}\nlogical=${removed.switchedToLogical}`,
      };
    }
    if (cmd.kind === "session_new") {
      const logical = topology.newSession(sessionKey);
      return { text: `Created new session in current task-cache.\n${topology.getStatus(sessionKey)}\nlogical=${logical}` };
    }
    return { text: commandHelpText() };
  };

  api.registerCommand({
    name: "ecoclaw",
    description: "EcoClaw task-cache/session controls (try: /ecoclaw help)",
    acceptsArgs: true,
    handler,
    execute: handler,
  });
  logger.debug("[ecoclaw] Registered /ecoclaw command.");
}

const __testHooks = {
  rewritePayloadForStablePrefix,
  applyProxyReductionToInput,
  stripInternalPayloadMarkers,
  normalizeConfig,
};

module.exports = {
  id: "ecoclaw",
  name: "EcoClaw Runtime Optimizer",
  __testHooks,

  register(api: any) {
    const logger = makeLogger(api?.logger);
    const cfg = normalizeConfig(api?.pluginConfig);
    const debugEnabled = cfg.logLevel === "debug";

    if (!cfg.enabled) {
      logger.info("[ecoclaw] Plugin disabled by config.");
      return;
    }

    if (cfg.hooks.beforeToolCall) {
      hookOn(api, "before_tool_call", (event: any) => {
        return { params: applyBeforeToolCallDefaults(event) };
  });
}

function registerMemoryFaultRecoverTool(
  api: any,
  cfg: ReturnType<typeof normalizeConfig>,
  logger: Required<PluginLogger>,
): void {
  if (typeof api.registerTool !== "function") {
    logger.warn("[ecoclaw] registerTool unavailable in this OpenClaw version.");
    return;
  }

  api.registerTool((toolCtx: any) => ({
    label: "Memory Fault Recover",
    name: MEMORY_FAULT_RECOVER_TOOL_NAME,
    description:
      "Recover archived content that was trimmed from a prior tool result. Use this internal tool with the provided dataKey instead of re-running the original tool.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        dataKey: {
          type: "string",
          description: "Archive dataKey from a prior [Tool payload trimmed] notice.",
        },
      },
      required: ["dataKey"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const dataKey = typeof args?.dataKey === "string" ? args.dataKey.trim() : "";
      if (!dataKey) {
        return {
          content: [{ type: "text", text: "Missing required parameter: dataKey" }],
          details: { error: "missing_data_key" },
        };
      }
      const stateDir = resolveRecoveryStateDir(cfg.stateDir);
      const sessionId =
        typeof toolCtx?.sessionId === "string" && toolCtx.sessionId.trim().length > 0
          ? toolCtx.sessionId.trim()
          : "proxy-session";
      const archivePath =
        (await resolveArchivePathFromLookup(dataKey, stateDir, sessionId))
        ?? (await resolveArchivePathFromLookup(dataKey, stateDir, "proxy-session"))
        ?? "";
      const archive = archivePath ? await readArchive(archivePath) : null;
      if (!archive) {
        return {
          content: [{ type: "text", text: `No archived content found for dataKey: ${dataKey}` }],
          details: { error: "archive_not_found", dataKey, archivePath },
        };
      }

      const recoveredText =
        `[Memory Fault Recovery] Recovered content for: ${dataKey}\n` +
        `Original size: ${archive.originalSize.toLocaleString()} chars\n` +
        `Archived by: ${archive.sourcePass}\n` +
        `--- Recovered Content ---\n` +
        `${archive.originalText}\n` +
        `--- End Recovered Content ---`;

      return {
        content: [{ type: "text", text: recoveredText }],
        details: {
          dataKey,
          archivePath,
          originalSize: archive.originalSize,
          sourcePass: archive.sourcePass,
          toolName: archive.toolName,
          recovered: true,
          contextSafe: {
            ...buildRecoveryContextSafePatch(MEMORY_FAULT_RECOVER_TOOL_NAME),
          },
        },
      };
    },
  }), { name: MEMORY_FAULT_RECOVER_TOOL_NAME });
}

    if (cfg.hooks.toolResultPersist) {
      hookOn(api, "tool_result_persist", async (event: any) => {
        const out = await applyToolResultPersistPolicy(event, cfg, logger);
        return out ?? { message: event?.message };
      });
    }

    if (cfg.contextEngine.enabled && typeof api.registerContextEngine === "function") {
      api.registerContextEngine("ecoclaw-context", () => createEcoClawContextEngine(cfg, logger));
    } else if (cfg.contextEngine.enabled) {
      logger.warn("[ecoclaw] registerContextEngine unavailable in this OpenClaw version.");
    }

    registerMemoryFaultRecoverTool(api, cfg, logger);

    const topology = createSessionTopologyManager();
    const recentTurnBindings: Array<{
      userMessage: string;
      matchKey: string;
      sessionKey: string;
      upstreamSessionId?: string;
      at: number;
    }> = [];
    const rememberTurnBinding = (userMessage: string, sessionKey: string, upstreamSessionId?: string) => {
      const normalizedMessage = String(userMessage ?? "").trim();
      const matchKey = normalizeTurnBindingMessage(normalizedMessage);
      const normalizedSessionKey = String(sessionKey ?? "").trim();
      if (!normalizedMessage || !matchKey || !normalizedSessionKey) return;
      recentTurnBindings.push({
        userMessage: normalizedMessage,
        matchKey,
        sessionKey: normalizedSessionKey,
        upstreamSessionId: String(upstreamSessionId ?? "").trim() || undefined,
        at: Date.now(),
      });
      while (recentTurnBindings.length > 128) recentTurnBindings.shift();
      if (cfg.stateDir) {
        persistRecentTurnBindingsToState(cfg.stateDir, recentTurnBindings);
      }
    };
    const resolveTurnBinding = (userMessage: string) => {
      const normalizedMessage = normalizeTurnBindingMessage(String(userMessage ?? "").trim());
      if (!normalizedMessage) return null;
      const persistedCandidates = cfg.stateDir ? loadRecentTurnBindingsFromState(cfg.stateDir) : [];
      const candidates = [...recentTurnBindings, ...persistedCandidates];
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const candidate = candidates[i];
        if (candidate.matchKey !== normalizedMessage) continue;
        if (Date.now() - candidate.at > 30 * 60 * 1000) continue;
        return candidate;
      }
      return null;
    };
    const resolveSessionIdForPayload = (payload: any): string | undefined => {
      const promptBinding = resolveTurnBinding(String(payload?.prompt ?? ""));
      if (promptBinding) {
        return String(promptBinding.upstreamSessionId ?? promptBinding.sessionKey ?? "").trim() || undefined;
      }
      const lastUser = findLastUserItem(payload?.input);
      const bound = resolveTurnBinding(extractItemText(lastUser?.userItem));
      return String(bound?.upstreamSessionId ?? bound?.sessionKey ?? "").trim() || undefined;
    };
    let proxyRuntime: Awaited<ReturnType<typeof startEmbeddedResponsesProxy>> | null = null;
    let proxyInitDone = false;
    let proxyInitPromise: Promise<void> | null = null;
    let proxyLifecycleEpoch = 0;

    const ensureProxyReady = async (): Promise<void> => {
      if (proxyInitDone) return;
      if (proxyInitPromise) return proxyInitPromise;
      const ensureEpoch = proxyLifecycleEpoch;
      proxyInitPromise = (async () => {
        const g = globalThis as any;
        const existing = g.__ecoclaw_embedded_proxy_runtime__;
        if (existing && existing.baseUrl && existing.upstream) {
          if (ensureEpoch !== proxyLifecycleEpoch) return;
          proxyRuntime = existing;
          proxyInitDone = true;
          return;
        }
        const startedRuntime = await startEmbeddedResponsesProxy(
          cfg,
          logger,
          resolveSessionIdForPayload,
        );
        if (!startedRuntime) return;
        if (ensureEpoch !== proxyLifecycleEpoch) {
          await startedRuntime.close().catch(() => undefined);
          return;
        }
        proxyRuntime = startedRuntime;
        g.__ecoclaw_embedded_proxy_runtime__ = startedRuntime;
        maybeRegisterProxyProvider(api, cfg, logger, startedRuntime.baseUrl, startedRuntime.upstream);
        await ensureExplicitProxyModelsInConfig(startedRuntime.baseUrl, startedRuntime.upstream, logger);
        proxyInitDone = true;
      })().catch((err) => {
        proxyInitDone = false;
        logger.warn(`[ecoclaw] embedded proxy init failed: ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        proxyInitPromise = null;
      });
      return proxyInitPromise;
    };

    installLlmHookTap(api, cfg, logger);
    registerEcoClawCommand(api, logger, topology, cfg);
    hookOn(api, "session_start", (event: any) => {
      const sessionKey = extractSessionKey(event);
      const upstreamSessionId = extractOpenClawSessionId(event);
      if (!sessionKey || !upstreamSessionId) return;
      topology.bindUpstreamSession(sessionKey, upstreamSessionId);
      if (debugEnabled) {
        logger.debug(
          `[ecoclaw] session_start synced sessionKey=${sessionKey} openclawSessionId=${upstreamSessionId} ${topology.getStatus(sessionKey)}`,
        );
      }
    });
    hookOn(api, "message_received", async (event: any) => {
      const sessionKey = extractSessionKey(event);
      const upstreamSessionId =
        extractOpenClawSessionId(event) || topology.getUpstreamSessionId(sessionKey) || undefined;
      const userMessage = extractLastUserMessage(event);
      if (userMessage.trim()) {
        rememberTurnBinding(userMessage, sessionKey, upstreamSessionId);
      }
      const cmd = parseEcoClawCommand(userMessage);
      if (cmd.kind !== "none") {
        if (cmd.kind === "status") {
          logger.info(`[ecoclaw] ${topology.getStatus(sessionKey)}`);
        } else if (cmd.kind === "cache_new") {
          const logical = topology.newTaskCache(sessionKey, cmd.taskId);
          logger.info(`[ecoclaw] cache new -> ${topology.getStatus(sessionKey)} logical=${logical}`);
        } else if (cmd.kind === "cache_delete") {
          const removed = topology.deleteTaskCache(sessionKey, cmd.taskId);
          if (!removed) {
            logger.info(
              `[ecoclaw] cache delete -> no matching task-cache for ${cmd.taskId ? safeId(cmd.taskId) : "current"}`,
            );
          } else {
            void purgeTaskCacheWorkspace(cfg.stateDir, removed.removedTaskId)
              .then((purge) => {
                logger.info(
                  `[ecoclaw] cache delete -> removed=${removed.removedTaskId} bindings=${removed.removedBindings} purged=${purge.purged.length} now=${topology.getStatus(sessionKey)} logical=${removed.switchedToLogical}`,
                );
              })
              .catch((err) => {
                logger.warn(
                  `[ecoclaw] cache delete purge failed for ${removed.removedTaskId}: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
          }
        } else if (cmd.kind === "session_new") {
          const logical = topology.newSession(sessionKey);
          logger.info(
            `[ecoclaw] session new -> ${topology.getStatus(sessionKey)} logical=${logical}`,
          );
        } else if (cmd.kind === "openclaw_session_new") {
          logger.info(
            `[ecoclaw] observed native /new on ${sessionKey}; waiting for OpenClaw session_start to publish the new sessionId`,
          );
        } else {
          logger.info(`[ecoclaw] ${commandHelpText().replace(/\n/g, " | ")}`);
        }
      }
      if (!debugEnabled) return;
      logger.debug(`[ecoclaw] message_received session=${sessionKey}`);
    });
    hookOn(api, "llm_input", async (event: any) => {
      const userMessage = extractLastUserMessage(event);
      const upstreamSessionId = extractOpenClawSessionId(event);
      const sessionKey = upstreamSessionId || extractSessionKey(event);
      if (userMessage.trim() && sessionKey.trim()) {
        rememberTurnBinding(userMessage, sessionKey, upstreamSessionId || undefined);
        if (upstreamSessionId) {
          topology.bindUpstreamSession(sessionKey, upstreamSessionId);
        }
      }
      if (cfg.stateDir && sessionKey.trim()) {
        const messages = Array.isArray(event?.messages) ? event.messages : [];
        const transcriptSync = await syncRawSemanticTurnsFromTranscript(cfg.stateDir, sessionKey);
        await appendTaskStateTrace(cfg.stateDir, {
          stage: "llm_input_received",
          sessionId: sessionKey,
          upstreamSessionId: upstreamSessionId || null,
          messageCount: messages.length,
          hasUserMessage: userMessage.trim().length > 0,
          transcriptTurnCount: transcriptSync.turnCount,
          transcriptUpdatedTurnSeqs: transcriptSync.updatedTurnSeqs,
        });
      }
      if (!debugEnabled) return;
      logger.debug(
        `[ecoclaw] llm_input prompt-bound session=${sessionKey || "unknown"} openclawSessionId=${upstreamSessionId || "-"}`,
      );
    });
    hookOn(api, "llm_output", async (event: any) => {
      const upstreamSessionId = extractOpenClawSessionId(event);
      const sessionKey = upstreamSessionId || extractSessionKey(event);
      if (!cfg.stateDir || !sessionKey.trim()) return;
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const transcriptSync = await syncRawSemanticTurnsFromTranscript(cfg.stateDir, sessionKey);
      await appendTaskStateTrace(cfg.stateDir, {
        stage: "llm_output_received",
        sessionId: sessionKey,
        upstreamSessionId: upstreamSessionId || null,
        messageCount: messages.length,
        transcriptTurnCount: transcriptSync.turnCount,
        transcriptUpdatedTurnSeqs: transcriptSync.updatedTurnSeqs,
      });
    });

    if (typeof api.registerService === "function") {
      api.registerService({
        id: "ecoclaw-runtime",
        start: () => {
          void ensureProxyReady();
          logger.info("[ecoclaw] Plugin active.");
          if (proxyRuntime?.baseUrl) {
            logger.info(`[ecoclaw] Embedded proxy active at ${proxyRuntime.baseUrl}`);
          } else {
            logger.info("[ecoclaw] Embedded proxy unavailable; ecoclaw provider was not registered.");
          }
          logger.info("[ecoclaw] Use explicit model key: ecoclaw/<model> (example: ecoclaw/gpt-5.4).");
          logger.info(`[ecoclaw] State dir=${cfg.stateDir} debugTap=${cfg.debugTapProviderTraffic ? "on" : "off"}`);
        },
        stop: () => {
          proxyLifecycleEpoch += 1;
          const stopEpoch = proxyLifecycleEpoch;
          if (proxyRuntime) {
            void proxyRuntime.close().catch((err) => {
              logger.warn(
                `[ecoclaw] embedded proxy stop failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
            const g = globalThis as any;
            if (g.__ecoclaw_embedded_proxy_runtime__ === proxyRuntime) {
              delete g.__ecoclaw_embedded_proxy_runtime__;
            }
            proxyRuntime = null;
            proxyInitDone = false;
          }
          if (proxyInitPromise) {
            void proxyInitPromise
              .then(() => {
                if (stopEpoch !== proxyLifecycleEpoch) return;
                const g = globalThis as any;
                const runtime = g.__ecoclaw_embedded_proxy_runtime__;
                if (runtime && runtime !== proxyRuntime) {
                  void runtime.close().catch(() => undefined);
                  if (g.__ecoclaw_embedded_proxy_runtime__ === runtime) {
                    delete g.__ecoclaw_embedded_proxy_runtime__;
                  }
                }
              })
              .catch(() => undefined);
          }
          logger.info("[ecoclaw] Plugin stopped.");
        },
      });
    }
  },
};
