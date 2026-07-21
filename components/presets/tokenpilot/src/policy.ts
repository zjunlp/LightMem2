import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RUNTIME_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  resolveApiFamily,
  type ApiFamily,
  type RuntimeModule,
  type RuntimeTurnContext,
} from "@lightmem2/kernel";
import {
  analyzePolicyLocality,
  type LocalityActionHint,
  type PolicyLocalityAnalysis,
  type PolicyLocalityConfig,
  type PolicyLocalitySignal,
} from "./locality.js";
import {
  analyzeReadStateCompaction,
  analyzeToolPayloadTrim,
  analyzeFormatSlimming,
  analyzeExecOutputTruncation,
  analyzeFormatCleaning,
  analyzePathTruncation,
  analyzeImageDownsample,
  analyzeLineNumberStrip,
} from "@lightmem2/reduction";
import {
  analyzeEvictionFromTaskRegistry,
  createApiTaskStateEstimator,
  type EvictionBlock,
  type EvictionInstruction,
  type EvictionPolicy,
  type SemanticTaskUpdate,
  type TaskStateEstimator,
  type TaskStateEstimatorApiConfig,
  type TaskStateTransition,
} from "@lightmem2/eviction";
import {
  applySessionTaskRegistryPatch,
  buildDeltaViewFromRawSemanticSnapshot,
  deriveCompletedSummaryPlusActiveTurnsWindow,
  buildHistoryView,
  type HistoryView,
  loadRawSemanticSnapshotWindow,
  loadSessionTaskRegistry,
  listRawSemanticTurnSeqs,
  persistSessionTaskRegistry,
  SessionTaskRegistryVersionMismatchError,
  type SessionTaskRegistryPatch,
  type SessionTaskRegistry,
  type TaskLifecycle,
  type TaskState,
} from "@lightmem2/history";

export type PolicyModuleConfig = {
  localityEnabled?: boolean;
  localityHardLoopWindowMessages?: number;
  localityHardLoopMinRepeats?: number;
  localityStructuralPayloadMinChars?: number;
  localityErrorMinChars?: number;
  localitySubtaskBoundaryMinMessages?: number;
  reductionEnabled?: boolean;
  reductionToolPayloadMinChars?: number;
  reductionFormatSlimmingEnabled?: boolean;
  reductionFormatSlimmingMinChars?: number;
  reductionSemanticEnabled?: boolean;
  reductionSemanticMinChars?: number;
  evictionEnabled?: boolean;
  evictionPolicy?: EvictionPolicy;
  evictionMinBlockChars?: number;
  cacheJitterWindowTurns?: number;
  cacheMissRateThreshold?: number;
  minTurnsBeforeJitter?: number;
  cacheHealthEnabled?: boolean;
  cacheHealthIntervalSeconds?: number;
  cacheHealthMaxPromptChars?: number;
  cacheHealthHitMinTokens?: number;
  cacheHealthMissesToCold?: number;
  cacheHealthWarmSeconds?: number;
  taskStateEstimator?: TaskStateEstimatorApiConfig;
  stateDir?: string;
};

export type PolicyCacheHealthMode = "warm" | "uncertain" | "cold";

export type PolicyOnlineConfigSnapshot = {
  locality: PolicyLocalityConfig;
  reduction: {
    enabled: boolean;
    toolPayloadMinChars: number;
    formatSlimmingEnabled: boolean;
    formatSlimmingMinChars: number;
    semanticEnabled: boolean;
    semanticMinChars: number;
  };
  eviction: {
    enabled: boolean;
    policy: EvictionPolicy;
    minBlockChars: number;
  };
  cache: {
    telemetryWindowTurns: number;
    missRateThreshold: number;
    minTurnsBeforeSignal: number;
  };
  cacheHealth: {
    enabled: boolean;
    intervalSeconds: number;
    maxPromptChars: number;
    hitMinTokens: number;
    missesToCold: number;
    warmSeconds: number;
  };
};

export type PolicyOnlineStateSnapshot = {
  completedTurns: number;
  stableChars: number;
  cumulativeInputTokens: number;
  recentCacheMissRate: number;
  recentMissCount: number;
  cacheHealth: {
    mode: PolicyCacheHealthMode;
    lastCheckAtMs?: number;
    lastReadTokens?: number;
    consecutiveMisses: number;
  };
};

export type PolicyOnlineSignals = {
  stabilizerEligible: boolean;
  promptChars: number;
  reductionToolPayloadSegmentCount: number;
  reductionToolPayloadChars: number;
  reductionReasons: string[];
  evictionReasons: string[];
  locality: {
    source: PolicyLocalityAnalysis["source"];
    signalCount: number;
    dominantAction: PolicyLocalityAnalysis["dominantAction"];
    stablePrefixChars: number;
    stablePrefixShare: number;
    activeReplayMessageCount: number;
    activeReplayChars: number;
    protectedMessageIds: string[];
    protectedChars: number;
    reductionCandidateMessageIds: string[];
    reductionCandidateChars: number;
    errorCandidateMessageIds: string[];
  };
  cacheHealth: {
    supported: boolean;
    due: boolean;
    planned: boolean;
    hitFresh: boolean;
  };
};

export type PolicyRoiConfidence = "low" | "medium" | "high";

export type PolicyRoiEstimate = {
  estimatedSavedTokens: number;
  estimatedCostTokens: number;
  netTokens: number;
  recommended: boolean;
  confidence: PolicyRoiConfidence;
  notes: string[];
};

export type PolicyReductionRoiSnapshot = {
  beforeCall: PolicyRoiEstimate;
  afterCall: PolicyRoiEstimate;
  passes: Record<string, PolicyRoiEstimate>;
};

export type PolicyOnlineRoiSnapshot = {
  reduction: PolicyReductionRoiSnapshot;
};

export type PolicyEvictionDecision = {
  enabled: boolean;
  policy: EvictionPolicy;
  blocks: EvictionBlock[];
  instructions: EvictionInstruction[];
  estimatedSavedChars: number;
  reasons: string[];
};

export type PolicyTaskStateDecision = {
  enabled: boolean;
  attempted: boolean;
  applied: boolean;
  baseVersion?: number;
  nextVersion?: number;
  coveredTurnAbsIds: string[];
  touchedTaskIds: string[];
  transitionCount: number;
  transitions?: Array<{
    taskId: string;
    from?: string;
    to: string;
    rationale: string;
  }>;
  rejectedUpdates?: Array<{
    taskId: string;
    from?: string;
    to: string;
    reason: string;
  }>;
  note?: string;
  estimatorUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd?: number;
  };
};

export type PolicyCacheHealthDecision = {
  enabled: boolean;
  supported: boolean;
  mode: PolicyCacheHealthMode;
  due: boolean;
  planned: boolean;
  promptChars: number;
  lastCheckAtMs?: number;
  lastReadTokens?: number;
  consecutiveMisses: number;
  hitFresh: boolean;
};

export type PolicyLocalityDecision = {
  enabled: boolean;
  dominantAction: LocalityActionHint | "mixed" | "observe";
  signalCount: number;
  protectedMessageIds: string[];
  reductionCandidateMessageIds: string[];
  errorCandidateMessageIds: string[];
  signals: PolicyLocalitySignal[];
};

import type { ReductionInstruction } from "./types.js";

export type PolicyOnlineDecisions = {
  reduction: {
    enabled: boolean;
    beforeCallPassIds: string[];
    afterCallPassIds: string[];
    instructions: ReductionInstruction[];
    reasons: string[];
  };
  eviction: PolicyEvictionDecision;
  taskState?: PolicyTaskStateDecision;
  locality: PolicyLocalityDecision;
  cacheHealth: PolicyCacheHealthDecision;
};

export type PolicyOnlineMetadata = {
  version: "v2";
  mode: "online";
  apiFamily: ApiFamily;
  config: PolicyOnlineConfigSnapshot;
  state: PolicyOnlineStateSnapshot;
  signals: PolicyOnlineSignals;
  roi: PolicyOnlineRoiSnapshot;
  decisions: PolicyOnlineDecisions;
};

type PolicySessionState = {
  completedTurns: number;
  recentCacheReadHit: number[];
  cumulativeInputTokens: number;
  cacheHealth: {
    mode: PolicyCacheHealthMode;
    lastCheckAtMs?: number;
    lastHitAtMs?: number;
    lastReadTokens?: number;
    consecutiveMisses: number;
  };
};

type NormalizedPolicyConfig = {
  locality: PolicyLocalityConfig;
  reductionEnabled: boolean;
  reductionToolPayloadMinChars: number;
  reductionFormatSlimmingEnabled: boolean;
  reductionFormatSlimmingMinChars: number;
  reductionSemanticEnabled: boolean;
  reductionSemanticMinChars: number;
  evictionEnabled: boolean;
  evictionPolicy: EvictionPolicy;
  evictionMinBlockChars: number;
  cacheJitterWindowTurns: number;
  cacheMissRateThreshold: number;
  minTurnsBeforeJitter: number;
  cacheHealthEnabled: boolean;
  cacheHealthIntervalSeconds: number;
  cacheHealthMaxPromptChars: number;
  cacheHealthHitMinTokens: number;
  cacheHealthMissesToCold: number;
  cacheHealthWarmSeconds: number;
  stateDir?: string;
  taskStateEstimator: Required<TaskStateEstimatorApiConfig>;
};

type LifecycleMode = "coupled" | "decoupled";

type TaskStateRunResult = {
  registry: SessionTaskRegistry;
  decision: PolicyTaskStateDecision;
};

type TaskStateEstimatorRunMarker = {
  sessionId: string;
  registryVersion: number;
  fromTurnSeqExclusive: number;
  toTurnSeqInclusive: number;
  batchTurns: number;
  inputMode: string;
  lifecycleMode: LifecycleMode;
  evidenceMode: "three_state" | "two_state";
  at: string;
};

async function appendTaskStateTrace(stateDir: string, payload: Record<string, unknown>): Promise<void> {
  const path = join(stateDir, "task-state", "trace.jsonl");
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify({
        at: new Date().toISOString(),
        ...payload,
      })}\n`,
      "utf8",
    );
  } catch {
    // best-effort trace only
  }
}

async function appendTaskStateEstimatorOutput(
  stateDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const path = join(stateDir, "task-state", "estimator-output.jsonl");
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify({
        at: new Date().toISOString(),
        ...payload,
      })}\n`,
      "utf8",
    );
  } catch {
    // best-effort trace only
  }
}

function taskStateEstimatorMarkerPath(stateDir: string): string {
  return join(stateDir, "task-state", "estimator-last-run.json");
}

async function readTaskStateEstimatorMarker(stateDir: string): Promise<TaskStateEstimatorRunMarker | null> {
  try {
    const raw = await readFile(taskStateEstimatorMarkerPath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as TaskStateEstimatorRunMarker;
  } catch {
    return null;
  }
}

async function writeTaskStateEstimatorMarker(
  stateDir: string,
  marker: Omit<TaskStateEstimatorRunMarker, "at"> & { at?: string },
): Promise<void> {
  const path = taskStateEstimatorMarkerPath(stateDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({
        ...marker,
        at: marker.at ?? new Date().toISOString(),
      }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // best-effort trace only
  }
}

function titleFromTaskId(taskId: string): string {
  return taskId
    .replace(/^task[-_]/i, "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function lifecycleBucketIds(tasks: Record<string, TaskState>, lifecycle: TaskLifecycle): string[] {
  return Object.values(tasks)
    .filter((task) => task.lifecycle === lifecycle)
    .map((task) => task.taskId);
}

type RejectedTaskUpdate = {
  taskId: string;
  from?: TaskLifecycle;
  to: TaskLifecycle;
  reason: string;
};

function hasCompletionEvidence(task: Pick<TaskState, "completionEvidence"> | undefined): boolean {
  return Array.isArray(task?.completionEvidence) && task.completionEvidence.some((item) => item.trim().length > 0);
}

function buildPatchFromTaskUpdates(
  registry: SessionTaskRegistry,
  updates: SemanticTaskUpdate[],
  coveredTurnAbsIds: string[],
  toTurnSeqInclusive: number,
  options?: {
    allowActiveToEvictable?: boolean;
    collapseCompletedIntoEvictable?: boolean;
  },
): {
  patch: SessionTaskRegistryPatch;
  transitions: TaskStateTransition[];
  touchedTaskIds: string[];
  rejectedUpdates: RejectedTaskUpdate[];
} {
  const upsertTasks: Record<string, TaskState> = {};
  const upsertTurnToTaskIds: Record<string, string[]> = {};
  const transitions: TaskStateTransition[] = [];
  const rejectedUpdates: RejectedTaskUpdate[] = [];

  for (const update of updates) {
    const taskId = String(update.taskId ?? "").trim();
    const previous = registry.tasks[taskId];
    const objective =
      typeof update.objective === "string" && update.objective.trim().length > 0
        ? update.objective.trim()
        : previous?.objective ?? "";
    const covered = uniqueStrings(update.coveredTurnAbsIds ?? []);
    if (!taskId || !objective) continue;
    if (covered.length === 0 && !previous) continue;
    const supportingTurnAbsIds = uniqueStrings([
      ...(previous?.span.supportingTurnAbsIds ?? []),
      ...covered,
    ]);
    if (supportingTurnAbsIds.length === 0) continue;
    const firstTurnAbsId = previous?.span.firstTurnAbsId ?? supportingTurnAbsIds[0]!;
    const lastTurnAbsId = supportingTurnAbsIds[supportingTurnAbsIds.length - 1]!;
    const mergedCompletionEvidence = uniqueStrings([
      ...(previous?.completionEvidence ?? []),
      ...(update.completionEvidence ?? []),
    ]);
    const mergedUnresolvedQuestions = uniqueStrings(update.unresolvedQuestions ?? previous?.unresolvedQuestions ?? []);
    const fromLifecycle = previous?.lifecycle;
    const toLifecycle = update.lifecycle;
    const fromHasCompletionEvidence = hasCompletionEvidence(previous);
    const toHasCompletionEvidence = mergedCompletionEvidence.length > 0;
    const allowActiveToEvictable = options?.allowActiveToEvictable === true;
    const collapseCompletedIntoEvictable = options?.collapseCompletedIntoEvictable === true;

    if (toLifecycle === "completed" && !toHasCompletionEvidence) {
      rejectedUpdates.push({
        taskId,
        ...(fromLifecycle ? { from: fromLifecycle } : {}),
        to: toLifecycle,
        reason: "completed_requires_completion_evidence",
      });
      continue;
    }
    if (toLifecycle === "evictable") {
      if (!allowActiveToEvictable) {
        if (fromLifecycle === "active" || !previous) {
          rejectedUpdates.push({
            taskId,
            ...(fromLifecycle ? { from: fromLifecycle } : {}),
            to: toLifecycle,
            reason: "active_to_evictable_forbidden",
          });
          continue;
        }
        if (fromLifecycle !== "completed" && fromLifecycle !== "evictable") {
          rejectedUpdates.push({
            taskId,
            ...(fromLifecycle ? { from: fromLifecycle } : {}),
            to: toLifecycle,
            reason: "evictable_requires_completed_state",
          });
          continue;
        }
      }
      if (!fromHasCompletionEvidence && !toHasCompletionEvidence) {
        rejectedUpdates.push({
          taskId,
          ...(fromLifecycle ? { from: fromLifecycle } : {}),
          to: toLifecycle,
          reason: "evictable_requires_completion_evidence",
        });
        continue;
      }
      if (mergedUnresolvedQuestions.length > 0) {
        rejectedUpdates.push({
          taskId,
          ...(fromLifecycle ? { from: fromLifecycle } : {}),
          to: toLifecycle,
          reason: "evictable_forbidden_with_unresolved_questions",
        });
        continue;
      }
    }

    const task: TaskState = {
      taskId,
      title:
        typeof update.title === "string" && update.title.trim().length > 0
          ? update.title.trim()
          : previous?.title ?? titleFromTaskId(taskId),
      objective,
      lifecycle: update.lifecycle,
      ...(typeof update.currentSubgoal === "string" && update.currentSubgoal.trim().length > 0
        ? { currentSubgoal: update.currentSubgoal.trim() }
        : previous?.currentSubgoal
          ? { currentSubgoal: previous.currentSubgoal }
          : {}),
      ...(typeof update.evictableReason === "string" && update.evictableReason.trim().length > 0
        ? { evictableReason: update.evictableReason.trim() }
        : previous?.evictableReason
          ? { evictableReason: previous.evictableReason }
          : {}),
      completionEvidence: mergedCompletionEvidence,
      unresolvedQuestions: mergedUnresolvedQuestions,
      span: {
        firstTurnAbsId,
        lastTurnAbsId,
        supportingTurnAbsIds,
        lastEstimatorTurnAbsId:
          covered[covered.length - 1] ??
          previous?.span.lastEstimatorTurnAbsId ??
          lastTurnAbsId,
      },
    };
    upsertTasks[taskId] = task;
    for (const turnAbsId of covered) {
      const existing = upsertTurnToTaskIds[turnAbsId] ?? registry.turnToTaskIds[turnAbsId] ?? [];
      upsertTurnToTaskIds[turnAbsId] = uniqueStrings([...existing, taskId]);
    }
    transitions.push({
      taskId,
      ...(previous ? { from: previous.lifecycle } : {}),
      to: update.lifecycle,
      rationale:
        covered.length > 0
          ? `task update applied from covered turns: ${covered.join(", ")}`
          : `lifecycle-only task update applied for ${taskId}`,
    });
  }

  const nextTasks = {
    ...registry.tasks,
    ...upsertTasks,
  };

  return {
    patch: {
      upsertTasks,
      upsertTurnToTaskIds,
      activeTaskIds: lifecycleBucketIds(nextTasks, "active"),
      completedTaskIds: lifecycleBucketIds(nextTasks, "completed"),
      evictableTaskIds: lifecycleBucketIds(nextTasks, "evictable"),
      lastProcessedTurnSeq: toTurnSeqInclusive,
    },
    transitions,
    touchedTaskIds: Object.keys(upsertTasks),
    rejectedUpdates,
  };
}

function normalizeTaskUpdatesForLifecycleMode(
  updates: SemanticTaskUpdate[],
  lifecycleMode: LifecycleMode,
): SemanticTaskUpdate[] {
  if (lifecycleMode === "coupled") return updates;
  return updates.map((update) =>
    update.lifecycle === "evictable"
      ? {
          ...update,
          lifecycle: "completed",
        }
      : update);
}

function collapseCompletedIntoEvictableForTwoState(updates: SemanticTaskUpdate[]): SemanticTaskUpdate[] {
  return updates.map((update) =>
    update.lifecycle === "completed"
      ? {
          ...update,
          lifecycle: "evictable",
        }
      : update,
  );
}

function sortTaskIdsByLastTurnAscending(registry: SessionTaskRegistry, taskIds: string[]): string[] {
  const rank = (taskId: string): number => {
    const lastTurnAbsId = registry.tasks[taskId]?.span.lastTurnAbsId;
    if (typeof lastTurnAbsId !== "string") return Number.MAX_SAFE_INTEGER;
    const parsed = Number(lastTurnAbsId.split(":t").at(-1) ?? Number.NaN);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  return [...taskIds].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function buildDecoupledFifoPromotionPatch(
  registry: SessionTaskRegistry,
  hotTailSize: number,
): {
  patch: SessionTaskRegistryPatch;
  promotedTaskIds: string[];
  preservedCompletedTaskIds: string[];
} {
  const completedTaskIds = sortTaskIdsByLastTurnAscending(registry, registry.completedTaskIds ?? []);
  if (completedTaskIds.length === 0) {
    return {
      patch: {},
      promotedTaskIds: [],
      preservedCompletedTaskIds: [],
    };
  }

  const safeHotTailSize = Math.max(0, hotTailSize);
  const preservedCompletedTaskIds =
    safeHotTailSize > 0 ? completedTaskIds.slice(-safeHotTailSize) : [];
  const promotedTaskIds = completedTaskIds.slice(0, Math.max(0, completedTaskIds.length - preservedCompletedTaskIds.length));
  const upsertTasks: Record<string, TaskState> = {};
  for (const taskId of promotedTaskIds) {
    const task = registry.tasks[taskId];
    if (!task || task.lifecycle === "evictable") continue;
    upsertTasks[taskId] = {
      ...task,
      lifecycle: "evictable",
      evictableReason: task.evictableReason ?? "fifo promotion from completed backlog",
    };
  }

  const nextCompletedTaskIds = completedTaskIds.filter((taskId) => !promotedTaskIds.includes(taskId));
  const nextEvictableTaskIds = sortTaskIdsByLastTurnAscending(
    registry,
    uniqueStrings([...(registry.evictableTaskIds ?? []), ...promotedTaskIds]),
  );

  return {
    patch: {
      ...(Object.keys(upsertTasks).length > 0 ? { upsertTasks } : {}),
      completedTaskIds: nextCompletedTaskIds,
      evictableTaskIds: nextEvictableTaskIds,
    },
    promotedTaskIds,
    preservedCompletedTaskIds,
  };
}

type PolicyAnalysis = {
  historyView: HistoryView;
  stableChars: number;
  recentCacheMissRate: number;
  recentMissCount: number;
  promptChars: number;
  reductionToolPayloadSegmentCount: number;
  reductionToolPayloadChars: number;
  reductionReasons: string[];
  reductionBeforeCallPassIds: string[];
  reductionAfterCallPassIds: string[];
  reductionInstructions: ReductionInstruction[];
  evictionReasons: string[];
  evictionDecision: PolicyEvictionDecision;
  locality: PolicyLocalityAnalysis;
  roi: PolicyOnlineRoiSnapshot;
  cacheHealth: {
    supported: boolean;
    due: boolean;
    planned: boolean;
    hitFresh: boolean;
    mode: PolicyCacheHealthMode;
  };
};

const POLICY_DEFAULT_CHARS_PER_TOKEN = 4;
const POLICY_DEFAULT_TOOL_TRIM_KEEP_RATIO = 0.35;
const POLICY_DEFAULT_FORMAT_SLIMMING_RATIO = 0.02;
const POLICY_DEFAULT_FORMAT_SLIMMING_MIN_SAVED_TOKENS = 8;

const toNum = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
};

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))];
}

function createInitialPolicySessionState(): PolicySessionState {
  return {
    completedTurns: 0,
    recentCacheReadHit: [],
    cumulativeInputTokens: 0,
    cacheHealth: {
      mode: "uncertain",
      consecutiveMisses: 0,
    },
  };
}

function estimateTokensFromChars(chars: number): number {
  return Math.max(0, Math.round(chars / POLICY_DEFAULT_CHARS_PER_TOKEN));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildRoiEstimate(params: {
  savedTokens: number;
  costTokens?: number;
  minNetTokens?: number;
  confidence?: PolicyRoiConfidence;
  notes?: string[];
}): PolicyRoiEstimate {
  const estimatedSavedTokens = Math.max(0, Math.round(params.savedTokens));
  const estimatedCostTokens = Math.max(0, Math.round(params.costTokens ?? 0));
  const netTokens = estimatedSavedTokens - estimatedCostTokens;
  return {
    estimatedSavedTokens,
    estimatedCostTokens,
    netTokens,
    recommended: netTokens >= Math.max(0, params.minNetTokens ?? 0),
    confidence: params.confidence ?? "medium",
    notes: params.notes ?? [],
  };
}

function readInputTokens(usage: unknown): number {
  const usageRecord = asRecord(usage);
  const direct = toNum(usageRecord?.inputTokens);
  if (direct !== undefined) return direct;
  const raw = asRecord(usageRecord?.providerRaw);
  return toNum(raw?.input_tokens ?? raw?.prompt_tokens ?? raw?.inputTokens ?? raw?.promptTokens) ?? 0;
}

function readCacheReadTokens(usage: unknown): number | undefined {
  const usageRecord = asRecord(usage);
  const direct = toNum(usageRecord?.cacheReadTokens ?? usageRecord?.cacheRead ?? usageRecord?.cachedTokens);
  if (direct !== undefined) return direct;
  const raw = asRecord(usageRecord?.providerRaw);
  const inputDetails = asRecord(raw?.input_tokens_details);
  const promptDetails = asRecord(raw?.prompt_tokens_details);
  return toNum(
    raw?.cache_read_input_tokens
      ?? raw?.cached_tokens
      ?? inputDetails?.cached_tokens
      ?? promptDetails?.cached_tokens,
  );
}

function readStableChars(ctx: RuntimeTurnContext): number {
  return ctx.segments
    .filter((segment) => segment.kind === "stable")
    .map((segment) => segment.text)
    .join("\n").length;
}

function isLikelyReductionToolPayloadSegment(segment: RuntimeTurnContext["segments"][number]): boolean {
  const metadata = asRecord(segment.metadata);
  const reduction = asRecord(metadata?.reduction);
  const toolPayload = asRecord(metadata?.toolPayload);
  const reductionTrim = asRecord(reduction?.toolPayloadTrim);
  const payloadKind = [reductionTrim?.kind, toolPayload?.kind, reduction?.payloadKind, metadata?.payloadKind]
    .find((value) => typeof value === "string");
  if (payloadKind) return true;

  const explicitEnabled =
    reductionTrim?.enabled === true ||
    toolPayload?.enabled === true ||
    metadata?.isToolPayload === true ||
    reduction?.target === "tool_payload";
  if (explicitEnabled) return true;

  const role = typeof metadata?.role === "string" ? metadata.role : "";
  if (/tool|observation/i.test(role)) return true;

  const head = String(segment.text ?? "").slice(0, 600);
  const haystack = [segment.id, segment.source, head].filter(Boolean).join("\n");
  if (/(tool|observation|artifact|payload|stdout|stderr|blob)/i.test(haystack)) return true;
  if (/(^|\n)\s*(stdout|stderr|json|blob)\s*[:=-]/i.test(head)) return true;
  if (/^\s*[\[{]/.test(head.trim())) return true;
  if (/^data:[^;]+;base64,/i.test(head.trim())) return true;
  return false;
}

function collectReductionToolPayloadStats(ctx: RuntimeTurnContext): {
  segmentCount: number;
  chars: number;
} {
  return ctx.segments.reduce(
    (acc, segment) => {
      if (!isLikelyReductionToolPayloadSegment(segment)) return acc;
      acc.segmentCount += 1;
      acc.chars += segment.text.length;
      return acc;
    },
    { segmentCount: 0, chars: 0 },
  );
}

function readStabilizerEligible(ctx: RuntimeTurnContext): boolean {
  const stabilizerMeta = asRecord(ctx.metadata?.stabilizer);
  return Boolean(stabilizerMeta?.eligible);
}

export function readPolicyOnlineMetadata(
  metadata?: Record<string, unknown>,
): PolicyOnlineMetadata | undefined {
  const policy = asRecord(metadata?.policy);
  if (!policy) return undefined;
  if (policy.version === "v2" && policy.mode === "online") {
    return policy as PolicyOnlineMetadata;
  }
  return undefined;
}

function normalizeConfig(cfg: PolicyModuleConfig): NormalizedPolicyConfig {
  return {
    locality: {
      enabled: cfg.localityEnabled ?? true,
      hardLoopWindowMessages: Math.max(3, cfg.localityHardLoopWindowMessages ?? 8),
      hardLoopMinRepeats: Math.max(2, cfg.localityHardLoopMinRepeats ?? 2),
      structuralPayloadMinChars: Math.max(40, cfg.localityStructuralPayloadMinChars ?? 120),
      errorMinChars: Math.max(16, cfg.localityErrorMinChars ?? 24),
      subtaskBoundaryMinMessages: Math.max(2, cfg.localitySubtaskBoundaryMinMessages ?? 2),
    },
    reductionEnabled: cfg.reductionEnabled ?? true,
    reductionToolPayloadMinChars: Math.max(1, cfg.reductionToolPayloadMinChars ?? 200),
    reductionFormatSlimmingEnabled: cfg.reductionFormatSlimmingEnabled ?? true,
    reductionFormatSlimmingMinChars: Math.max(1, cfg.reductionFormatSlimmingMinChars ?? 1200),
    reductionSemanticEnabled: cfg.reductionSemanticEnabled ?? false,
    reductionSemanticMinChars: Math.max(1, cfg.reductionSemanticMinChars ?? 4000),
    evictionEnabled: cfg.evictionEnabled ?? false,
    evictionPolicy: cfg.evictionPolicy ?? "noop",
    evictionMinBlockChars: Math.max(16, cfg.evictionMinBlockChars ?? 256),
    cacheJitterWindowTurns: Math.max(3, cfg.cacheJitterWindowTurns ?? 6),
    cacheMissRateThreshold: Math.min(1, Math.max(0, cfg.cacheMissRateThreshold ?? 0.5)),
    minTurnsBeforeJitter: Math.max(1, cfg.minTurnsBeforeJitter ?? 4),
    cacheHealthEnabled: cfg.cacheHealthEnabled ?? true,
    cacheHealthIntervalSeconds: Math.max(30, cfg.cacheHealthIntervalSeconds ?? 1800),
    cacheHealthMaxPromptChars: Math.max(1, cfg.cacheHealthMaxPromptChars ?? 120),
    cacheHealthHitMinTokens: Math.max(0, cfg.cacheHealthHitMinTokens ?? 64),
    cacheHealthMissesToCold: Math.max(1, cfg.cacheHealthMissesToCold ?? 2),
    cacheHealthWarmSeconds: Math.max(30, cfg.cacheHealthWarmSeconds ?? 7200),
    stateDir: typeof cfg.stateDir === "string" && cfg.stateDir.trim().length > 0 ? cfg.stateDir : undefined,
    taskStateEstimator: {
      enabled: cfg.taskStateEstimator?.enabled ?? false,
      baseUrl: cfg.taskStateEstimator?.baseUrl ?? "",
      apiKey: cfg.taskStateEstimator?.apiKey ?? "",
      model: cfg.taskStateEstimator?.model ?? "",
      requestTimeoutMs: Math.max(1000, cfg.taskStateEstimator?.requestTimeoutMs ?? 60_000),
      batchTurns: Math.max(1, cfg.taskStateEstimator?.batchTurns ?? 5),
      evictionLookaheadTurns: Math.max(1, cfg.taskStateEstimator?.evictionLookaheadTurns ?? 3),
      completedSummaryMaxRawTurns: Math.max(0, cfg.taskStateEstimator?.completedSummaryMaxRawTurns ?? 0),
      inputMode:
        cfg.taskStateEstimator?.inputMode === "completed_summary_plus_active_turns"
          ? "completed_summary_plus_active_turns"
          : "sliding_window",
      lifecycleMode: cfg.taskStateEstimator?.lifecycleMode === "decoupled" ? "decoupled" : "coupled",
      evidenceMode: cfg.taskStateEstimator?.evidenceMode === "two_state" ? "two_state" : "three_state",
      evictionPromotionPolicy: cfg.taskStateEstimator?.evictionPromotionPolicy === "fifo" ? "fifo" : "fifo",
      evictionPromotionHotTailSize: Math.max(0, cfg.taskStateEstimator?.evictionPromotionHotTailSize ?? 1),
    },
  };
}

function collectSignalReasons(
  locality: PolicyLocalityAnalysis,
  action: "reduction",
): string[] {
  const reasons: string[] = [];
  for (const signal of locality.signals) {
    if (!signal.actionHints.includes(action)) continue;
    switch (signal.kind) {
      case "subtask_boundary":
        reasons.push("locality_subtask_boundary");
        break;
      case "hard_loop_detected":
        reasons.push("locality_hard_loop_detected");
        break;
      case "error_detected":
        reasons.push(action === "reduction" ? "locality_error_prune" : "locality_error_detected");
        break;
      case "structural_payload_detected":
        reasons.push("locality_structural_payload_detected");
        break;
      case "content_type_prior":
        reasons.push("locality_content_type_prior");
        break;
      default:
        reasons.push(`locality_${signal.kind}`);
        break;
    }
  }
  return uniqueStrings(reasons);
}

function analyzePolicyBeforeBuild(
  ctx: RuntimeTurnContext,
  state: PolicySessionState,
  apiFamily: ApiFamily,
  config: NormalizedPolicyConfig,
): PolicyAnalysis {
  const nowMs = Date.now();
  const stableChars = readStableChars(ctx);
  const stabilizerEligible = readStabilizerEligible(ctx);
  const reductionStats = collectReductionToolPayloadStats(ctx);
  const locality = analyzePolicyLocality({
    ctx,
    cfg: config.locality,
  });

  const recent = state.recentCacheReadHit.slice(-config.cacheJitterWindowTurns);
  const recentMissCount = recent.filter((value) => value === 0).length;
  const recentCacheMissRate = recent.length > 0 ? recentMissCount / recent.length : 0;

  const cacheHealthSupported = apiFamily !== "openai-completions";
  const promptChars = String(ctx.prompt ?? "").length;
  const cacheHealthDue =
    config.cacheHealthEnabled &&
    cacheHealthSupported &&
    stabilizerEligible &&
    (state.cacheHealth.lastCheckAtMs == null ||
      nowMs - state.cacheHealth.lastCheckAtMs >= config.cacheHealthIntervalSeconds * 1000);
  const cacheHealthPlanned = cacheHealthDue && promptChars <= config.cacheHealthMaxPromptChars;
  const cacheHealthHitFresh =
    typeof state.cacheHealth.lastHitAtMs === "number" &&
    nowMs - state.cacheHealth.lastHitAtMs <= config.cacheHealthWarmSeconds * 1000;

  let cacheHealthMode: PolicyCacheHealthMode = state.cacheHealth.mode;
  if (cacheHealthHitFresh) {
    cacheHealthMode = "warm";
  } else if (state.cacheHealth.consecutiveMisses >= config.cacheHealthMissesToCold) {
    cacheHealthMode = "cold";
  } else {
    cacheHealthMode = "uncertain";
  }
  state.cacheHealth.mode = cacheHealthMode;

  // Analyze segments for reduction opportunities
  const readStateCompactionDecision = analyzeReadStateCompaction(ctx.segments);
  const toolPayloadDecision = analyzeToolPayloadTrim(ctx.segments);
  const formatSlimmingDecision = analyzeFormatSlimming(ctx.segments);
  const execOutputDecision = analyzeExecOutputTruncation(ctx.segments);
  const formatCleaningDecision = analyzeFormatCleaning(ctx.segments);
  const pathTruncationDecision = analyzePathTruncation(ctx.segments);
  const imageDownsampleDecision = analyzeImageDownsample(ctx.segments);
  const lineNumberStripDecision = analyzeLineNumberStrip(ctx.segments);

  const historyView = buildHistoryView(ctx);
  const promptTokensEstimate = estimateTokensFromChars(promptChars);
  const reductionTargetTokens = estimateTokensFromChars(locality.reductionCandidateChars);
  const reductionToolPayloadTokens = estimateTokensFromChars(reductionStats.chars);

  const toolTrimSavedTokens = Math.max(
    reductionTargetTokens,
    Math.round(reductionToolPayloadTokens * (1 - POLICY_DEFAULT_TOOL_TRIM_KEEP_RATIO)),
  );
  const formatSlimmingSavedTokens = Math.max(
    POLICY_DEFAULT_FORMAT_SLIMMING_MIN_SAVED_TOKENS,
    Math.round(promptTokensEstimate * POLICY_DEFAULT_FORMAT_SLIMMING_RATIO),
  );

  const reductionPassRoi: Record<string, PolicyRoiEstimate> = {
    tool_payload_trim: buildRoiEstimate({
      savedTokens: toolTrimSavedTokens,
      costTokens: 0,
      minNetTokens: 1,
      confidence: reductionStats.segmentCount > 0 || locality.reductionCandidateChars > 0 ? "high" : "low",
      notes: [
        `tool_payload_chars=${reductionStats.chars}`,
        `locality_reduction_chars=${locality.reductionCandidateChars}`,
      ],
    }),
    format_slimming: buildRoiEstimate({
      savedTokens: formatSlimmingSavedTokens,
      costTokens: 0,
      minNetTokens: 1,
      confidence:
        locality.reductionCandidateChars > 0 || reductionStats.segmentCount > 0 ? "medium" : "low",
      notes: [
        `prompt_tokens_estimate=${promptTokensEstimate}`,
        `savings_ratio=${POLICY_DEFAULT_FORMAT_SLIMMING_RATIO}`,
      ],
    }),
    semantic_llmlingua2: buildRoiEstimate({
      savedTokens: 0,
      costTokens: 0,
      minNetTokens: 0,
      confidence: "low",
      notes: [
        "post_call_observed_only",
        `min_input_chars=${config.reductionSemanticMinChars}`,
      ],
    }),
  };

  const reductionBeforeCallRoi = buildRoiEstimate({
    savedTokens:
      reductionPassRoi.tool_payload_trim.estimatedSavedTokens +
      Math.round(reductionTargetTokens * 0.35),
    costTokens: 0,
    minNetTokens: 1,
    confidence: reductionPassRoi.tool_payload_trim.confidence,
    notes: ["aggregate_before_call"],
  });
  const reductionAfterCallRoi = buildRoiEstimate({
    savedTokens: reductionPassRoi.format_slimming.estimatedSavedTokens,
    costTokens: 0,
    minNetTokens: 0,
    confidence: "low",
    notes: ["semantic_requires_observed_output"],
  });

  const roi: PolicyOnlineRoiSnapshot = {
    reduction: {
      beforeCall: reductionBeforeCallRoi,
      afterCall: reductionAfterCallRoi,
      passes: reductionPassRoi,
    },
  };

  const evictionReasons: string[] = config.evictionEnabled
    ? [`eviction_policy=${config.evictionPolicy}`]
    : [];

  const reductionReasons: string[] = [];
  const reductionBeforeCallPassIds: string[] = [];
  const reductionAfterCallPassIds: string[] = [];
  const localityReductionReasons = collectSignalReasons(locality, "reduction");
  reductionReasons.push(...localityReductionReasons);
  if (config.reductionEnabled) {
    reductionBeforeCallPassIds.push("agents_startup_optimization");
    reductionReasons.push("agents_startup_optimization_always_enabled");
  }
  if (
    config.reductionEnabled &&
    (reductionStats.segmentCount > 0 || localityReductionReasons.length > 0) &&
    reductionPassRoi.tool_payload_trim.recommended
  ) {
    reductionReasons.push("tool_payload_detected");
    reductionBeforeCallPassIds.push("tool_payload_trim");
  }
  if (
    config.reductionFormatSlimmingEnabled &&
    (promptChars >= config.reductionFormatSlimmingMinChars || localityReductionReasons.length > 0) &&
    reductionPassRoi.format_slimming.recommended
  ) {
    reductionReasons.push("format_slimming_candidate");
    reductionAfterCallPassIds.push("format_slimming");
  }
  if (config.reductionSemanticEnabled && reductionPassRoi.semantic_llmlingua2.recommended) {
    reductionReasons.push("semantic_candidate");
    reductionAfterCallPassIds.push("semantic_llmlingua2");
  }
  if (
    config.reductionEnabled &&
    readStateCompactionDecision.instructions.length > 0 &&
    readStateCompactionDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`read_state_compaction_detected(count=${readStateCompactionDecision.instructions.length},saved=${readStateCompactionDecision.estimatedSavedChars})`);
    reductionBeforeCallPassIds.push("read_state_compaction");
  }
  if (
    config.reductionEnabled &&
    toolPayloadDecision.instructions.length > 0 &&
    toolPayloadDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`tool_payload_detected(count=${toolPayloadDecision.instructions.length},saved=${toolPayloadDecision.estimatedSavedChars})`);
    reductionBeforeCallPassIds.push("tool_payload_trim");
  }
  if (
    config.reductionFormatSlimmingEnabled &&
    formatSlimmingDecision.instructions.length > 0 &&
    formatSlimmingDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`format_overhead_detected(count=${formatSlimmingDecision.instructions.length},saved=${formatSlimmingDecision.estimatedSavedChars})`);
    reductionAfterCallPassIds.push("format_slimming");
  }
  if (
    config.reductionEnabled &&
    execOutputDecision.instructions.length > 0 &&
    execOutputDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`large_exec_output(count=${execOutputDecision.instructions.length},saved=${execOutputDecision.estimatedSavedChars})`);
    reductionBeforeCallPassIds.push("exec_output_truncation");
  }
  if (
    config.reductionEnabled &&
    formatCleaningDecision.instructions.length > 0 &&
    formatCleaningDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`format_cleaning_needed(count=${formatCleaningDecision.instructions.length},saved=${formatCleaningDecision.estimatedSavedChars})`);
    reductionAfterCallPassIds.push("format_cleaning");
  }
  if (
    config.reductionEnabled &&
    pathTruncationDecision.instructions.length > 0 &&
    pathTruncationDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`long_paths_detected(count=${pathTruncationDecision.instructions.length},saved=${pathTruncationDecision.estimatedSavedChars})`);
    reductionAfterCallPassIds.push("path_truncation");
  }
  if (
    config.reductionEnabled &&
    imageDownsampleDecision.instructions.length > 0 &&
    imageDownsampleDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`large_images_detected(count=${imageDownsampleDecision.instructions.length},saved=${imageDownsampleDecision.estimatedSavedChars})`);
    reductionAfterCallPassIds.push("image_downsample");
  }
  if (
    config.reductionEnabled &&
    lineNumberStripDecision.instructions.length > 0 &&
    lineNumberStripDecision.estimatedSavedChars > 0
  ) {
    reductionReasons.push(`line_number_prefixes_detected(count=${lineNumberStripDecision.instructions.length},saved=${lineNumberStripDecision.estimatedSavedChars})`);
    reductionAfterCallPassIds.push("line_number_strip");
  }

  const allReductionInstructions: ReductionInstruction[] = [
    ...readStateCompactionDecision.instructions,
    ...toolPayloadDecision.instructions,
    ...formatSlimmingDecision.instructions,
    ...execOutputDecision.instructions,
    ...formatCleaningDecision.instructions,
    ...pathTruncationDecision.instructions,
    ...imageDownsampleDecision.instructions,
    ...lineNumberStripDecision.instructions,
  ].sort((a, b) => b.priority - a.priority);

  return {
    historyView,
    stableChars,
    recentCacheMissRate,
    recentMissCount,
    promptChars,
    reductionToolPayloadSegmentCount: reductionStats.segmentCount,
    reductionToolPayloadChars: reductionStats.chars,
    reductionReasons: uniqueStrings(reductionReasons),
    reductionBeforeCallPassIds: uniqueStrings(reductionBeforeCallPassIds),
    reductionAfterCallPassIds: uniqueStrings(reductionAfterCallPassIds),
    reductionInstructions: allReductionInstructions,
    evictionReasons: uniqueStrings(evictionReasons),
    evictionDecision: {
      enabled: config.evictionEnabled,
      policy: config.evictionPolicy,
      blocks: [],
      instructions: [],
      estimatedSavedChars: 0,
      reasons: uniqueStrings(evictionReasons),
    },
    locality,
    roi,
    cacheHealth: {
      supported: cacheHealthSupported,
      due: cacheHealthDue,
      planned: cacheHealthPlanned,
      hitFresh: cacheHealthHitFresh,
      mode: cacheHealthMode,
    },
  };
}

function buildPolicyMetadata(
  apiFamily: ApiFamily,
  state: PolicySessionState,
  analysis: PolicyAnalysis,
  config: NormalizedPolicyConfig,
  stabilizerEligible: boolean,
): PolicyOnlineMetadata {
  return {
    version: "v2",
    mode: "online",
    apiFamily,
    config: {
      locality: config.locality,
      reduction: {
        enabled: config.reductionEnabled,
        toolPayloadMinChars: config.reductionToolPayloadMinChars,
        formatSlimmingEnabled: config.reductionFormatSlimmingEnabled,
        formatSlimmingMinChars: config.reductionFormatSlimmingMinChars,
        semanticEnabled: config.reductionSemanticEnabled,
        semanticMinChars: config.reductionSemanticMinChars,
      },
      eviction: {
        enabled: config.evictionEnabled,
        policy: config.evictionPolicy,
        minBlockChars: config.evictionMinBlockChars,
      },
      cache: {
        telemetryWindowTurns: config.cacheJitterWindowTurns,
        missRateThreshold: config.cacheMissRateThreshold,
        minTurnsBeforeSignal: config.minTurnsBeforeJitter,
      },
      cacheHealth: {
        enabled: config.cacheHealthEnabled,
        intervalSeconds: config.cacheHealthIntervalSeconds,
        maxPromptChars: config.cacheHealthMaxPromptChars,
        hitMinTokens: config.cacheHealthHitMinTokens,
        missesToCold: config.cacheHealthMissesToCold,
        warmSeconds: config.cacheHealthWarmSeconds,
      },
    },
    state: {
      completedTurns: state.completedTurns,
      stableChars: analysis.stableChars,
      cumulativeInputTokens: state.cumulativeInputTokens,
      recentCacheMissRate: analysis.recentCacheMissRate,
      recentMissCount: analysis.recentMissCount,
      cacheHealth: {
        mode: analysis.cacheHealth.mode,
        lastCheckAtMs: state.cacheHealth.lastCheckAtMs,
        lastReadTokens: state.cacheHealth.lastReadTokens,
        consecutiveMisses: state.cacheHealth.consecutiveMisses,
      },
    },
    signals: {
      stabilizerEligible,
      promptChars: analysis.promptChars,
      reductionToolPayloadSegmentCount: analysis.reductionToolPayloadSegmentCount,
      reductionToolPayloadChars: analysis.reductionToolPayloadChars,
      reductionReasons: analysis.reductionReasons,
      evictionReasons: analysis.evictionReasons,
      locality: {
        source: analysis.locality.source,
        signalCount: analysis.locality.signalCount,
        dominantAction: analysis.locality.dominantAction,
        stablePrefixChars: analysis.locality.stablePrefixChars,
        stablePrefixShare: analysis.locality.stablePrefixShare,
        activeReplayMessageCount: analysis.locality.activeReplayMessageCount,
        activeReplayChars: analysis.locality.activeReplayChars,
        protectedMessageIds: analysis.locality.protectedMessageIds,
        protectedChars: analysis.locality.protectedChars,
        reductionCandidateMessageIds: analysis.locality.reductionCandidateMessageIds,
        reductionCandidateChars: analysis.locality.reductionCandidateChars,
        errorCandidateMessageIds: analysis.locality.errorCandidateMessageIds,
      },
      cacheHealth: {
        supported: analysis.cacheHealth.supported,
        due: analysis.cacheHealth.due,
        planned: analysis.cacheHealth.planned,
        hitFresh: analysis.cacheHealth.hitFresh,
      },
    },
    roi: analysis.roi,
    decisions: {
      reduction: {
        enabled: config.reductionEnabled,
        beforeCallPassIds: analysis.reductionBeforeCallPassIds,
        afterCallPassIds: analysis.reductionAfterCallPassIds,
        instructions: analysis.reductionInstructions,
        reasons: analysis.reductionReasons,
      },
      eviction: {
        enabled: config.evictionEnabled,
        policy: analysis.evictionDecision.policy,
        blocks: analysis.evictionDecision.blocks,
        instructions: analysis.evictionDecision.instructions,
        estimatedSavedChars: analysis.evictionDecision.estimatedSavedChars,
        reasons: analysis.evictionReasons,
      },
      locality: {
        enabled: config.locality.enabled,
        dominantAction: analysis.locality.dominantAction,
        signalCount: analysis.locality.signalCount,
        protectedMessageIds: analysis.locality.protectedMessageIds,
        reductionCandidateMessageIds: analysis.locality.reductionCandidateMessageIds,
        errorCandidateMessageIds: analysis.locality.errorCandidateMessageIds,
        signals: analysis.locality.signals,
      },
      cacheHealth: {
        enabled: config.cacheHealthEnabled,
        supported: analysis.cacheHealth.supported,
        mode: analysis.cacheHealth.mode,
        due: analysis.cacheHealth.due,
        planned: analysis.cacheHealth.planned,
        promptChars: analysis.promptChars,
        lastCheckAtMs: state.cacheHealth.lastCheckAtMs,
        lastReadTokens: state.cacheHealth.lastReadTokens,
        consecutiveMisses: state.cacheHealth.consecutiveMisses,
        hitFresh: analysis.cacheHealth.hitFresh,
      },
    },
  };
}

async function maybeRunTaskStateEstimator(
  ctx: RuntimeTurnContext,
  config: NormalizedPolicyConfig,
  estimator: TaskStateEstimator | null,
): Promise<TaskStateRunResult | null> {
  if (!config.stateDir) return null;
  await appendTaskStateTrace(config.stateDir, {
        stage: "estimator_gate_check",
        sessionId: ctx.sessionId,
        estimatorEnabled: config.taskStateEstimator.enabled,
        hasStateDir: Boolean(config.stateDir),
        hasEstimatorInstance: Boolean(estimator),
    estimatorBaseUrlPresent: Boolean(config.taskStateEstimator.baseUrl),
    estimatorApiKeyPresent: Boolean(config.taskStateEstimator.apiKey),
        estimatorModel: config.taskStateEstimator.model ?? null,
        batchTurns: config.taskStateEstimator.batchTurns,
        completedSummaryMaxRawTurns: config.taskStateEstimator.completedSummaryMaxRawTurns,
        lifecycleMode: config.taskStateEstimator.lifecycleMode,
        inputMode: config.taskStateEstimator.inputMode,
      });
  if (!config.taskStateEstimator.enabled || !estimator) {
    await appendTaskStateTrace(config.stateDir, {
      stage: "estimator_gate_blocked",
      sessionId: ctx.sessionId,
      reason: !config.taskStateEstimator.enabled ? "disabled" : "missing_estimator_instance",
      estimatorEnabled: config.taskStateEstimator.enabled,
      hasEstimatorInstance: Boolean(estimator),
      estimatorBaseUrlPresent: Boolean(config.taskStateEstimator.baseUrl),
      estimatorApiKeyPresent: Boolean(config.taskStateEstimator.apiKey),
      estimatorModel: config.taskStateEstimator.model ?? null,
    });
    return null;
  }

  const registry = await loadSessionTaskRegistry(config.stateDir, ctx.sessionId);
  const turnSeqs = await listRawSemanticTurnSeqs(config.stateDir, ctx.sessionId);
  const pendingTurnSeqs = turnSeqs.filter((turnSeq) => turnSeq > registry.lastProcessedTurnSeq);
  await appendTaskStateTrace(config.stateDir, {
    stage: "estimator_window_check",
    sessionId: ctx.sessionId,
    registryVersion: registry.version,
    lastProcessedTurnSeq: registry.lastProcessedTurnSeq,
    availableTurnSeqs: turnSeqs,
    pendingTurnSeqs,
      batchTurns: config.taskStateEstimator.batchTurns,
      completedSummaryMaxRawTurns: config.taskStateEstimator.completedSummaryMaxRawTurns,
      inputMode: config.taskStateEstimator.inputMode,
    });
  if (pendingTurnSeqs.length < config.taskStateEstimator.batchTurns) {
    await appendTaskStateTrace(config.stateDir, {
      stage: "estimator_skipped",
      sessionId: ctx.sessionId,
      reason: "insufficient_pending_turns",
      pendingTurnCount: pendingTurnSeqs.length,
    });
    return {
      registry,
      decision: {
        enabled: true,
        attempted: false,
        applied: false,
        baseVersion: registry.version,
        nextVersion: registry.version,
        coveredTurnAbsIds: [],
        touchedTaskIds: [],
        transitionCount: 0,
        transitions: [],
        rejectedUpdates: [],
        note: "insufficient_pending_turns",
      },
    };
  }

  const slidingWindowToTurnSeqInclusive = pendingTurnSeqs[config.taskStateEstimator.batchTurns - 1]!;
  const evidenceMode = config.taskStateEstimator.evidenceMode ?? "three_state";
  const estimatorWindow =
    evidenceMode === "two_state"
      ? {
          fromTurnSeqExclusive: registry.lastProcessedTurnSeq,
          toTurnSeqInclusive: slidingWindowToTurnSeqInclusive,
          completedTaskSummaries: [],
        }
      : config.taskStateEstimator.inputMode === "completed_summary_plus_active_turns"
      ? deriveCompletedSummaryPlusActiveTurnsWindow(
          registry,
          pendingTurnSeqs,
          config.taskStateEstimator.batchTurns,
          config.taskStateEstimator.completedSummaryMaxRawTurns,
        )
      : {
          fromTurnSeqExclusive: registry.lastProcessedTurnSeq,
          toTurnSeqInclusive: slidingWindowToTurnSeqInclusive,
          completedTaskSummaries: [],
        };
  const snapshot = await loadRawSemanticSnapshotWindow(
    config.stateDir,
    ctx.sessionId,
    estimatorWindow.fromTurnSeqExclusive,
    estimatorWindow.toTurnSeqInclusive,
  );
  const delta = buildDeltaViewFromRawSemanticSnapshot(snapshot, {
    fromTurnSeqExclusive: estimatorWindow.fromTurnSeqExclusive,
    toTurnSeqInclusive: estimatorWindow.toTurnSeqInclusive,
    inputMode: config.taskStateEstimator.inputMode,
    completedTaskSummaries: evidenceMode === "two_state" ? [] : estimatorWindow.completedTaskSummaries,
  });

  const lastMarker = await readTaskStateEstimatorMarker(config.stateDir);
  if (
    lastMarker
    && lastMarker.sessionId === ctx.sessionId
    && lastMarker.registryVersion === registry.version
    && lastMarker.fromTurnSeqExclusive === estimatorWindow.fromTurnSeqExclusive
    && lastMarker.toTurnSeqInclusive === estimatorWindow.toTurnSeqInclusive
    && lastMarker.batchTurns === config.taskStateEstimator.batchTurns
    && lastMarker.inputMode === config.taskStateEstimator.inputMode
    && lastMarker.lifecycleMode === config.taskStateEstimator.lifecycleMode
    && lastMarker.evidenceMode === evidenceMode
  ) {
    await appendTaskStateTrace(config.stateDir, {
      stage: "estimator_skipped_duplicate",
      sessionId: ctx.sessionId,
      registryVersion: registry.version,
      fromTurnSeqExclusive: estimatorWindow.fromTurnSeqExclusive,
      toTurnSeqInclusive: estimatorWindow.toTurnSeqInclusive,
      batchTurns: config.taskStateEstimator.batchTurns,
      inputMode: config.taskStateEstimator.inputMode,
      lifecycleMode: config.taskStateEstimator.lifecycleMode,
      evidenceMode,
    });
    return {
      registry,
      decision: {
        enabled: true,
        attempted: false,
        applied: false,
        baseVersion: registry.version,
        nextVersion: registry.version,
        coveredTurnAbsIds: [],
        touchedTaskIds: [],
        transitionCount: 0,
        transitions: [],
        rejectedUpdates: [],
        note: "duplicate_estimator_window",
      },
    };
  }

  if (delta.coveredTurnAbsIds.length === 0) {
    await appendTaskStateTrace(config.stateDir, {
      stage: "estimator_skipped",
      sessionId: ctx.sessionId,
      reason: "empty_delta_window",
      fromTurnSeqExclusive: estimatorWindow.fromTurnSeqExclusive,
      toTurnSeqInclusive: estimatorWindow.toTurnSeqInclusive,
    });
    return {
      registry,
      decision: {
        enabled: true,
        attempted: false,
        applied: false,
        baseVersion: registry.version,
        nextVersion: registry.version,
        coveredTurnAbsIds: [],
        touchedTaskIds: [],
        transitionCount: 0,
        transitions: [],
        rejectedUpdates: [],
        note: "empty_delta_window",
      },
    };
  }

  try {
    const output = await estimator.estimate({
      registry,
      delta,
    });
    const normalizedTaskUpdates = normalizeTaskUpdatesForLifecycleMode(
      output.taskUpdates,
      config.taskStateEstimator.lifecycleMode,
    );
    const lifecycleAwareTaskUpdates =
      evidenceMode === "two_state"
        ? collapseCompletedIntoEvictableForTwoState(normalizedTaskUpdates)
        : normalizedTaskUpdates;
    await appendTaskStateEstimatorOutput(config.stateDir, {
      stage: "estimator_output",
      sessionId: ctx.sessionId,
      baseVersion: output.baseVersion,
      registryVersion: registry.version,
      lifecycleMode: config.taskStateEstimator.lifecycleMode,
      evidenceMode,
      batchTurns: config.taskStateEstimator.batchTurns,
      inputMode: config.taskStateEstimator.inputMode,
      delta: {
        fromTurnSeqExclusive: estimatorWindow.fromTurnSeqExclusive,
        toTurnSeqInclusive: estimatorWindow.toTurnSeqInclusive,
        coveredTurnAbsIds: delta.coveredTurnAbsIds,
        messageCount: delta.messages.length,
        toolCallCount: delta.toolCalls.length,
        toolResultCount: delta.toolResults.length,
        filesRead: delta.filesRead,
        filesWritten: delta.filesWritten,
        currentActiveTaskHint: delta.currentActiveTaskHint,
        completedTaskSummaries: delta.completedTaskSummaries ?? [],
      },
      rawOutput: output,
      normalizedTaskUpdates,
      appliedTaskUpdates: lifecycleAwareTaskUpdates,
    });
    await appendTaskStateTrace(config.stateDir, {
      stage: "estimator_output",
      sessionId: ctx.sessionId,
      baseVersion: output.baseVersion,
      lifecycleMode: config.taskStateEstimator.lifecycleMode,
      taskUpdates: lifecycleAwareTaskUpdates.map((update) => ({
        taskId: update.taskId,
        lifecycle: update.lifecycle,
        coveredTurnAbsIds: update.coveredTurnAbsIds ?? [],
      })),
    });
    await writeTaskStateEstimatorMarker(config.stateDir, {
      sessionId: ctx.sessionId,
      registryVersion: registry.version,
      fromTurnSeqExclusive: estimatorWindow.fromTurnSeqExclusive,
      toTurnSeqInclusive: estimatorWindow.toTurnSeqInclusive,
      batchTurns: config.taskStateEstimator.batchTurns,
      inputMode: config.taskStateEstimator.inputMode,
      lifecycleMode: config.taskStateEstimator.lifecycleMode,
      evidenceMode,
    });
    if (output.baseVersion !== registry.version) {
      await appendTaskStateTrace(config.stateDir, {
        stage: "estimator_skipped",
        sessionId: ctx.sessionId,
        reason: "base_version_mismatch",
        outputBaseVersion: output.baseVersion,
        registryVersion: registry.version,
      });
      return {
        registry,
        decision: {
          enabled: true,
          attempted: true,
          applied: false,
          baseVersion: output.baseVersion,
          nextVersion: registry.version,
          coveredTurnAbsIds: delta.coveredTurnAbsIds,
          touchedTaskIds: normalizedTaskUpdates.map((update) => update.taskId),
          transitionCount: normalizedTaskUpdates.length,
          transitions: [],
          rejectedUpdates: [],
          note: "base_version_mismatch",
          estimatorUsage: output.usage,
        },
      };
    }

    const built = buildPatchFromTaskUpdates(
      registry,
      lifecycleAwareTaskUpdates,
      delta.coveredTurnAbsIds,
      estimatorWindow.toTurnSeqInclusive,
      {
        allowActiveToEvictable: evidenceMode === "two_state",
        collapseCompletedIntoEvictable: evidenceMode === "two_state",
      },
    );
    if (built.rejectedUpdates.length > 0) {
      await appendTaskStateTrace(config.stateDir, {
        stage: "estimator_updates_rejected",
        sessionId: ctx.sessionId,
        rejectedUpdates: built.rejectedUpdates,
      });
    }
    let nextRegistry = applySessionTaskRegistryPatch(registry, built.patch);
    if (
      config.taskStateEstimator.lifecycleMode === "decoupled"
      && config.taskStateEstimator.evictionPromotionPolicy === "fifo"
    ) {
      const promotion = buildDecoupledFifoPromotionPatch(
        nextRegistry,
        config.taskStateEstimator.evictionPromotionHotTailSize,
      );
      if (promotion.promotedTaskIds.length > 0) {
        nextRegistry = applySessionTaskRegistryPatch(nextRegistry, promotion.patch);
        await appendTaskStateTrace(config.stateDir, {
          stage: "eviction_promotion_applied",
          sessionId: ctx.sessionId,
          lifecycleMode: config.taskStateEstimator.lifecycleMode,
          policy: config.taskStateEstimator.evictionPromotionPolicy,
          hotTailSize: config.taskStateEstimator.evictionPromotionHotTailSize,
          promotedTaskIds: promotion.promotedTaskIds,
          preservedCompletedTaskIds: promotion.preservedCompletedTaskIds,
          completedTaskIds: nextRegistry.completedTaskIds,
          evictableTaskIds: nextRegistry.evictableTaskIds,
        });
      }
    }
    try {
      await persistSessionTaskRegistry(config.stateDir, nextRegistry, {
        expectedVersion: registry.version,
      });
    } catch (error) {
      if (error instanceof SessionTaskRegistryVersionMismatchError) {
        await appendTaskStateTrace(config.stateDir, {
          stage: "estimator_skipped",
          sessionId: ctx.sessionId,
          reason: "persist_version_mismatch",
          outputBaseVersion: output.baseVersion,
          registryVersion: registry.version,
        });
        return {
          registry,
          decision: {
            enabled: true,
            attempted: true,
            applied: false,
            baseVersion: output.baseVersion,
            nextVersion: registry.version,
            coveredTurnAbsIds: delta.coveredTurnAbsIds,
            touchedTaskIds: built.touchedTaskIds,
            transitionCount: built.transitions.length,
            transitions: built.transitions,
            rejectedUpdates: built.rejectedUpdates,
            note: "persist_version_mismatch",
            estimatorUsage: output.usage,
          },
        };
      }
      throw error;
    }
    await appendTaskStateTrace(config.stateDir, {
      stage: "registry_persisted",
      sessionId: ctx.sessionId,
      previousVersion: registry.version,
      nextVersion: nextRegistry.version,
      lastProcessedTurnSeq: nextRegistry.lastProcessedTurnSeq,
      touchedTaskIds: built.touchedTaskIds,
      transitionCount: built.transitions.length,
    });

    return {
      registry: nextRegistry,
      decision: {
        enabled: true,
        attempted: true,
        applied: true,
        baseVersion: output.baseVersion,
        nextVersion: nextRegistry.version,
        coveredTurnAbsIds: delta.coveredTurnAbsIds,
        touchedTaskIds: built.touchedTaskIds,
        transitionCount: built.transitions.length,
        transitions: built.transitions,
        rejectedUpdates: built.rejectedUpdates,
        estimatorUsage: output.usage,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : null;
    const stack =
      error instanceof Error && typeof error.stack === "string"
        ? error.stack.split("\n").slice(0, 6)
        : [];
    await appendTaskStateTrace(config.stateDir, {
      stage: "estimator_error",
      sessionId: ctx.sessionId,
      errorName: name,
      errorMessage: message,
      errorStack: stack,
      registryVersion: registry.version,
      lastProcessedTurnSeq: registry.lastProcessedTurnSeq,
      coveredTurnAbsIds: delta.coveredTurnAbsIds,
      availableTurnSeqs: turnSeqs,
      pendingTurnSeqs,
      fromTurnSeqExclusive: estimatorWindow.fromTurnSeqExclusive,
      toTurnSeqInclusive: estimatorWindow.toTurnSeqInclusive,
      inputMode: config.taskStateEstimator.inputMode,
      lifecycleMode: config.taskStateEstimator.lifecycleMode,
    });
    throw error;
  }
}

export function createPolicyModule(cfg: PolicyModuleConfig = {}): RuntimeModule {
  const config = normalizeConfig(cfg);
  const stateBySession = new Map<string, PolicySessionState>();
  let taskStateEstimator: TaskStateEstimator | null = null;
  let estimatorCreationError: string | null = null;
  if (config.taskStateEstimator.enabled) {
    try {
      taskStateEstimator = createApiTaskStateEstimator(config.taskStateEstimator);
    } catch (error) {
      estimatorCreationError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    name: "module-policy",
    async beforeBuild(ctx) {
      const metadata =
        ctx.metadata && typeof ctx.metadata === "object"
          ? (ctx.metadata as Record<string, unknown>)
          : undefined;
      if (metadata?.policyBypass === true) {
        return ctx;
      }
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? createInitialPolicySessionState();
      const stabilizerEligible = readStabilizerEligible(ctx);
      const analysis = analyzePolicyBeforeBuild(ctx, state, apiFamily, config);
      const evidenceMode = config.taskStateEstimator.evidenceMode ?? "three_state";
      if (config.stateDir) {
        await appendTaskStateTrace(config.stateDir, {
          stage: "policy_before_build",
          sessionId: ctx.sessionId,
          estimatorEnabled: config.taskStateEstimator.enabled,
          hasEstimatorInstance: Boolean(taskStateEstimator),
          estimatorCreationError,
          estimatorBaseUrlPresent: Boolean(config.taskStateEstimator.baseUrl),
          estimatorApiKeyPresent: Boolean(config.taskStateEstimator.apiKey),
          estimatorModel: config.taskStateEstimator.model ?? null,
          batchTurns: config.taskStateEstimator.batchTurns,
          lifecycleMode: config.taskStateEstimator.lifecycleMode,
          evidenceMode,
          inputMode: config.taskStateEstimator.inputMode,
          evictionEnabled: config.evictionEnabled,
        });
      }
      const taskStateRun = await maybeRunTaskStateEstimator(ctx, config, taskStateEstimator);
      const policy = buildPolicyMetadata(apiFamily, state, analysis, config, stabilizerEligible);
      if (taskStateRun) {
        policy.decisions.taskState = taskStateRun.decision;
        if (config.evictionEnabled) {
          const registryDrivenEviction = analyzeEvictionFromTaskRegistry(
            analysis.historyView.blocks,
            taskStateRun.registry,
            {
              enabled: config.evictionEnabled,
              policy: config.evictionPolicy,
              minBlockChars: config.evictionMinBlockChars,
            },
          );
          if (config.stateDir) {
            const blocksWithTurnAbsIds = analysis.historyView.blocks.filter(
              (block) => Array.isArray(block.turnAbsIds) && block.turnAbsIds.length > 0,
            ).length;
            const blocksWithTaskIds = analysis.historyView.blocks.filter(
              (block) => Array.isArray(block.taskIds) && block.taskIds.length > 0,
            ).length;
            await appendTaskStateTrace(config.stateDir, {
              stage: "registry_driven_eviction_evaluated",
              sessionId: ctx.sessionId,
              evictableTaskIds: taskStateRun.registry.evictableTaskIds,
              blockCount: registryDrivenEviction.blocks.length,
              instructionCount: registryDrivenEviction.instructions.length,
              blocksWithTurnAbsIds,
              blocksWithTaskIds,
              notes: registryDrivenEviction.notes ?? [],
            });
          }
          policy.decisions.eviction = {
            enabled: config.evictionEnabled,
            policy: registryDrivenEviction.policy,
            blocks: registryDrivenEviction.blocks,
            instructions: registryDrivenEviction.instructions,
            estimatedSavedChars: registryDrivenEviction.estimatedSavedChars,
            reasons: registryDrivenEviction.notes ?? ["source=task_state_registry"],
          };
        }
      }

      let nextCtx: RuntimeTurnContext = {
        ...ctx,
        metadata: {
          ...(ctx.metadata ?? {}),
          policy,
        },
      };

      if (policy.decisions.reduction.enabled) {
        nextCtx = appendContextEvent(nextCtx, {
          type: RUNTIME_EVENT_TYPES.POLICY_REDUCTION_DECIDED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            beforeCallPassIds: policy.decisions.reduction.beforeCallPassIds,
            afterCallPassIds: policy.decisions.reduction.afterCallPassIds,
            reasons: policy.decisions.reduction.reasons,
            toolPayloadSegmentCount: policy.signals.reductionToolPayloadSegmentCount,
            toolPayloadChars: policy.signals.reductionToolPayloadChars,
            localityReductionChars: policy.signals.locality.reductionCandidateChars,
            roi: policy.roi.reduction,
            apiFamily,
          },
        });
      }

      if (stabilizerEligible && config.cacheHealthEnabled && analysis.cacheHealth.supported) {
        nextCtx = appendContextEvent(nextCtx, {
          type: RUNTIME_EVENT_TYPES.POLICY_CACHE_HEALTH_DECIDED,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            mode: policy.decisions.cacheHealth.mode,
            due: policy.decisions.cacheHealth.due,
            planned: policy.decisions.cacheHealth.planned,
            promptChars: policy.decisions.cacheHealth.promptChars,
            maxPromptChars: policy.config.cacheHealth.maxPromptChars,
            intervalSeconds: policy.config.cacheHealth.intervalSeconds,
            consecutiveMisses: policy.decisions.cacheHealth.consecutiveMisses,
            hitFresh: policy.decisions.cacheHealth.hitFresh,
            apiFamily,
          },
        });
      }


      stateBySession.set(ctx.sessionId, state);
      return nextCtx;
    },
    async afterCall(ctx, result) {
      const metadata =
        ctx.metadata && typeof ctx.metadata === "object"
          ? (ctx.metadata as Record<string, unknown>)
          : undefined;
      if (metadata?.policyBypass === true) {
        return result;
      }
      const apiFamily = resolveApiFamily(ctx);
      const state = stateBySession.get(ctx.sessionId) ?? createInitialPolicySessionState();
      state.completedTurns += 1;

      const rawReadTokens = readCacheReadTokens(result.usage);
      const hasReadSignal = typeof rawReadTokens === "number" && Number.isFinite(rawReadTokens);
      const readTokens = hasReadSignal ? Number(rawReadTokens) : 0;
      state.cumulativeInputTokens += readInputTokens(result.usage);

      if (hasReadSignal) {
        state.recentCacheReadHit.push(readTokens > 0 ? 1 : 0);
        if (state.recentCacheReadHit.length > config.cacheJitterWindowTurns * 3) {
          state.recentCacheReadHit = state.recentCacheReadHit.slice(-config.cacheJitterWindowTurns * 3);
        }
      }
      stateBySession.set(ctx.sessionId, state);

      const policyMeta = readPolicyOnlineMetadata(ctx.metadata);
      const cacheHealthDecision = policyMeta?.decisions.cacheHealth;
      if (
        config.cacheHealthEnabled &&
        cacheHealthDecision?.supported &&
        cacheHealthDecision.planned &&
        hasReadSignal
      ) {
        const nowMs = Date.now();
        const hit = readTokens >= config.cacheHealthHitMinTokens;
        state.cacheHealth.lastCheckAtMs = nowMs;
        state.cacheHealth.lastReadTokens = readTokens;
        if (hit) {
          state.cacheHealth.lastHitAtMs = nowMs;
          state.cacheHealth.consecutiveMisses = 0;
          state.cacheHealth.mode = "warm";
        } else {
          state.cacheHealth.consecutiveMisses += 1;
          state.cacheHealth.mode =
            state.cacheHealth.consecutiveMisses >= config.cacheHealthMissesToCold ? "cold" : "uncertain";
        }
        stateBySession.set(ctx.sessionId, state);
        result = appendResultEvent(result, {
          type: RUNTIME_EVENT_TYPES.POLICY_CACHE_HEALTH_RESULT,
          source: "module-policy",
          at: new Date().toISOString(),
          payload: {
            planned: true,
            hit,
            readTokens,
            hasReadSignal,
            hitMinTokens: config.cacheHealthHitMinTokens,
            mode: state.cacheHealth.mode,
            consecutiveMisses: state.cacheHealth.consecutiveMisses,
            apiFamily,
          },
        });
      }

      return result;
    },
  };
}
