import {
  RUNTIME_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  findRuntimeEventsByType,
  resolveApiFamily,
  type ApiFamily,
  type DecisionConfidenceLevel,
  type DecisionEvidence,
  type DecisionRecord,
  type RuntimeModule,
} from "@tokenpilot/kernel";
import { readPolicyOnlineMetadata } from "./policy.js";

export type DecisionLedgerModuleConfig = {
  enabled?: boolean;
  maxEvidence?: number;
};

type SessionLedgerState = {
  turn: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
  summaryRequestCount: number;
  summaryUsageKnownCount: number;
  cumulativeSummaryInputTokens: number;
  cumulativeSummaryOutputTokens: number;
  cumulativeSummaryCacheReadTokens: number;
  handoffRequestCount: number;
  handoffUsageKnownCount: number;
  cumulativeHandoffInputTokens: number;
  cumulativeHandoffOutputTokens: number;
  cumulativeHandoffCacheReadTokens: number;
};

const toNum = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

function toConfidenceLevel(confidence: number): DecisionConfidenceLevel {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.6) return "medium";
  return "low";
}

function addEvidence(out: DecisionEvidence[], source: string, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    out.push({ source, key, value });
  }
}

function readUsageSnapshot(usage: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  usageKnown: boolean;
} {
  const usageRecord = (usage ?? {}) as Record<string, unknown>;
  const providerRaw =
    usageRecord.providerRaw && typeof usageRecord.providerRaw === "object"
      ? (usageRecord.providerRaw as Record<string, unknown>)
      : undefined;
  const inputTokens =
    toNum(usageRecord.inputTokens) ??
    toNum(providerRaw?.input_tokens ?? providerRaw?.prompt_tokens ?? providerRaw?.inputTokens ?? providerRaw?.promptTokens);
  const outputTokens =
    toNum(usageRecord.outputTokens) ??
    toNum(providerRaw?.output_tokens ?? providerRaw?.completion_tokens ?? providerRaw?.outputTokens ?? providerRaw?.completionTokens);
  const cacheReadTokens =
    toNum(usageRecord.cacheReadTokens) ??
    toNum(usageRecord.cachedTokens) ??
    toNum(providerRaw?.cache_read_input_tokens) ??
    toNum(
      (providerRaw?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
      (providerRaw?.promptTokensDetails as Record<string, unknown> | undefined)?.cachedTokens,
    );
  return {
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cacheReadTokens: cacheReadTokens ?? null,
    usageKnown: inputTokens != null || outputTokens != null || cacheReadTokens != null,
  };
}

function readArtifactGeneration(
  artifact: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return artifact?.generation && typeof artifact.generation === "object"
    ? (artifact.generation as Record<string, unknown>)
    : undefined;
}

function collectEvidence(ctx: any, apiFamily: ApiFamily, maxEvidence: number): DecisionEvidence[] {
  const evidence: DecisionEvidence[] = [];
  const taskRouter = (ctx.metadata?.taskRouter ?? {}) as Record<string, unknown>;
  const stabilizer = (ctx.metadata?.stabilizer ?? {}) as Record<string, unknown>;
  const policy = readPolicyOnlineMetadata(ctx.metadata);

  addEvidence(evidence, "runtime", "apiFamily", apiFamily);
  addEvidence(evidence, "runtime", "provider", ctx.provider);
  addEvidence(evidence, "runtime", "model", ctx.model);
  addEvidence(evidence, "taskRouter", "tier", taskRouter.tier);
  addEvidence(evidence, "taskRouter", "decision", taskRouter.decision);
  addEvidence(evidence, "taskRouter", "reason", taskRouter.reason);
  addEvidence(evidence, "policy", "summaryRequested", policy?.decisions.summary.requested);
  addEvidence(evidence, "policy", "summaryGenerationMode", policy?.decisions.summary.generationMode);
  addEvidence(evidence, "policy", "summaryRoiNetTokens", policy?.roi.summary.netTokens);
  addEvidence(evidence, "policy", "localityDominantAction", policy?.decisions.locality.dominantAction);
  addEvidence(evidence, "policy", "localitySignalCount", policy?.decisions.locality.signalCount);
  addEvidence(evidence, "policy", "handoffRequested", policy?.decisions.handoff.requested);
  addEvidence(evidence, "policy", "handoffGenerationMode", policy?.decisions.handoff.generationMode);
  addEvidence(evidence, "policy", "handoffRoiNetTokens", policy?.roi.handoff.netTokens);
  addEvidence(evidence, "policy", "reductionEnabled", policy?.decisions.reduction.enabled);
  addEvidence(
    evidence,
    "policy",
    "reductionBeforeCallPassCount",
    policy?.decisions.reduction.beforeCallPassIds.length,
  );
  addEvidence(evidence, "policy", "reductionBeforeCallRoiNetTokens", policy?.roi.reduction.beforeCall.netTokens);
  addEvidence(evidence, "policy", "semanticLlmBudgetOwner", policy?.decisions.semantic.llmBudgetOwner);
  addEvidence(evidence, "policy", "semanticPlannedLlmCalls", policy?.decisions.semantic.plannedLlmCalls.join(","));
  addEvidence(evidence, "policy", "cacheHealthMode", policy?.decisions.cacheHealth.mode);
  addEvidence(evidence, "policy", "recentCacheMissRate", policy?.state.recentCacheMissRate);
  addEvidence(evidence, "stabilizer", "eligible", stabilizer.eligible);
  addEvidence(evidence, "stabilizer", "prefixChars", stabilizer.prefixChars);

  return evidence.slice(0, Math.max(4, maxEvidence));
}

export function createDecisionLedgerModule(cfg: DecisionLedgerModuleConfig = {}): RuntimeModule {
  const enabled = cfg.enabled ?? true;
  const maxEvidence = Math.max(4, cfg.maxEvidence ?? 16);
  const stateBySession = new Map<string, SessionLedgerState>();

  return {
    name: "module-decision-ledger",
    async beforeCall(ctx) {
      if (!enabled) return ctx;

      const apiFamily = resolveApiFamily(ctx);
      const taskRouter = (ctx.metadata?.taskRouter ?? {}) as Record<string, unknown>;
      const decision = String(taskRouter.decision ?? "kept");
      const reason = String(taskRouter.reason ?? "l1_static_policy");
      const confidence = Math.min(1, Math.max(0, toNum(taskRouter.confidence) ?? 0.55));

      const plan: DecisionRecord = {
        module: "module-decision-ledger",
        decision,
        reason,
        confidence,
        confidenceLevel: toConfidenceLevel(confidence),
        apiFamily,
        evidence: collectEvidence(ctx, apiFamily, maxEvidence),
        at: new Date().toISOString(),
      };

      const nextCtx = {
        ...ctx,
        apiFamily,
        metadata: {
          ...(ctx.metadata ?? {}),
          decisionLedger: {
            ...((ctx.metadata?.decisionLedger as Record<string, unknown> | undefined) ?? {}),
            plan,
          },
        },
      };

      return appendContextEvent(nextCtx, {
        type: RUNTIME_EVENT_TYPES.DECISION_L1_RECORDED,
        source: "module-decision-ledger",
        at: plan.at,
        payload: {
          phase: "plan",
          decision: plan.decision,
          reason: plan.reason,
          confidence: plan.confidence,
          confidenceLevel: plan.confidenceLevel,
          apiFamily,
          evidence: plan.evidence,
        },
      });
    },
    async afterCall(ctx, result) {
      if (!enabled) return result;

      const apiFamily = resolveApiFamily(ctx);
      const now = new Date().toISOString();
      const plan = ((ctx.metadata?.decisionLedger as Record<string, unknown> | undefined)?.plan ??
        undefined) as DecisionRecord | undefined;

      const mainUsage = readUsageSnapshot(result.usage);
      const inputTokens = mainUsage.inputTokens ?? 0;
      const outputTokens = mainUsage.outputTokens ?? 0;
      const cacheReadTokens = mainUsage.cacheReadTokens ?? 0;

      const summaryEvents = findRuntimeEventsByType(result.metadata, RUNTIME_EVENT_TYPES.SUMMARY_GENERATED);
      const latestSummaryPayload =
        summaryEvents.length > 0
          ? ((summaryEvents[summaryEvents.length - 1]?.payload ?? {}) as Record<string, unknown>)
          : undefined;
      const summaryArtifact =
        latestSummaryPayload && typeof latestSummaryPayload.artifact === "object"
          ? (latestSummaryPayload.artifact as Record<string, unknown>)
          : undefined;
      const summaryGeneration = readArtifactGeneration(summaryArtifact);
      const summaryUsage = readUsageSnapshot(summaryGeneration?.usage);
      const summaryRequested = Boolean(summaryArtifact);
      const summaryInputTokens = summaryUsage.inputTokens ?? 0;
      const summaryOutputTokens = summaryUsage.outputTokens ?? 0;
      const summaryCacheReadTokens = summaryUsage.cacheReadTokens ?? 0;

      const handoffMeta =
        result.metadata?.handoff && typeof result.metadata.handoff === "object"
          ? (result.metadata.handoff as Record<string, unknown>)
          : undefined;
      const handoffArtifact =
        handoffMeta?.artifact && typeof handoffMeta.artifact === "object"
          ? (handoffMeta.artifact as Record<string, unknown>)
          : undefined;
      const handoffGeneration = readArtifactGeneration(handoffArtifact);
      const handoffUsage = readUsageSnapshot(handoffGeneration?.usage);
      const handoffRequested = Boolean(handoffArtifact);
      const handoffInputTokens = handoffUsage.inputTokens ?? 0;
      const handoffOutputTokens = handoffUsage.outputTokens ?? 0;
      const handoffCacheReadTokens = handoffUsage.cacheReadTokens ?? 0;


      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        cumulativeCacheReadTokens: 0,
        summaryRequestCount: 0,
        summaryUsageKnownCount: 0,
        cumulativeSummaryInputTokens: 0,
        cumulativeSummaryOutputTokens: 0,
        cumulativeSummaryCacheReadTokens: 0,
        handoffRequestCount: 0,
        handoffUsageKnownCount: 0,
        cumulativeHandoffInputTokens: 0,
        cumulativeHandoffOutputTokens: 0,
        cumulativeHandoffCacheReadTokens: 0,
      };
      state.turn += 1;
      state.cumulativeInputTokens += inputTokens;
      state.cumulativeOutputTokens += outputTokens;
      state.cumulativeCacheReadTokens += cacheReadTokens;
      if (summaryRequested) state.summaryRequestCount += 1;
      if (summaryUsage.usageKnown) {
        state.summaryUsageKnownCount += 1;
        state.cumulativeSummaryInputTokens += summaryInputTokens;
        state.cumulativeSummaryOutputTokens += summaryOutputTokens;
        state.cumulativeSummaryCacheReadTokens += summaryCacheReadTokens;
      }
      if (handoffRequested) state.handoffRequestCount += 1;
      if (handoffUsage.usageKnown) {
        state.handoffUsageKnownCount += 1;
        state.cumulativeHandoffInputTokens += handoffInputTokens;
        state.cumulativeHandoffOutputTokens += handoffOutputTokens;
        state.cumulativeHandoffCacheReadTokens += handoffCacheReadTokens;
      }
      stateBySession.set(ctx.sessionId, state);

      const turnNetTokenBenefit = cacheReadTokens - inputTokens - outputTokens;
      const cumulativeNetTokenBenefit =
        state.cumulativeCacheReadTokens - state.cumulativeInputTokens - state.cumulativeOutputTokens;
      const summaryTurnNetTokenBenefit = summaryUsage.usageKnown
        ? summaryCacheReadTokens - summaryInputTokens - summaryOutputTokens
        : null;
      const cumulativeSummaryNetTokenBenefit =
        state.cumulativeSummaryCacheReadTokens -
        state.cumulativeSummaryInputTokens -
        state.cumulativeSummaryOutputTokens;
      const handoffTurnNetTokenBenefit = handoffUsage.usageKnown
        ? handoffCacheReadTokens - handoffInputTokens - handoffOutputTokens
        : null;
      const cumulativeHandoffNetTokenBenefit =
        state.cumulativeHandoffCacheReadTokens -
        state.cumulativeHandoffInputTokens -
        state.cumulativeHandoffOutputTokens;
      const effectiveTurnNetTokenBenefit =
        turnNetTokenBenefit +
        (summaryTurnNetTokenBenefit ?? 0) +
        (handoffTurnNetTokenBenefit ?? 0);
      const effectiveCumulativeNetTokenBenefit =
        cumulativeNetTokenBenefit +
        cumulativeSummaryNetTokenBenefit +
        cumulativeHandoffNetTokenBenefit;

      const outcome = {
        at: now,
        apiFamily,
        turn: state.turn,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
        },
        summaryGeneration: summaryRequested
          ? {
              requested: true,
              usageKnown: summaryUsage.usageKnown,
              mode: typeof summaryGeneration?.mode === "string" ? summaryGeneration.mode : undefined,
              provider: typeof summaryGeneration?.provider === "string" ? summaryGeneration.provider : undefined,
              model: typeof summaryGeneration?.model === "string" ? summaryGeneration.model : undefined,
              requestedAt:
                typeof summaryGeneration?.requestedAt === "string" ? summaryGeneration.requestedAt : undefined,
              completedAt:
                typeof summaryGeneration?.completedAt === "string" ? summaryGeneration.completedAt : undefined,
              usage: {
                inputTokens: summaryUsage.inputTokens,
                outputTokens: summaryUsage.outputTokens,
                cacheReadTokens: summaryUsage.cacheReadTokens,
              },
              request:
                summaryGeneration?.request && typeof summaryGeneration.request === "object"
                  ? (summaryGeneration.request as Record<string, unknown>)
                  : undefined,
              error: typeof summaryGeneration?.error === "string" ? summaryGeneration.error : undefined,
              roi: {
                turnNetTokenBenefit: summaryTurnNetTokenBenefit,
                cumulativeNetTokenBenefit: cumulativeSummaryNetTokenBenefit,
              },
            }
          : {
              requested: false,
              usageKnown: false,
            },
        handoffGeneration: handoffRequested
          ? {
              requested: true,
              usageKnown: handoffUsage.usageKnown,
              mode: typeof handoffGeneration?.mode === "string" ? handoffGeneration.mode : undefined,
              provider: typeof handoffGeneration?.provider === "string" ? handoffGeneration.provider : undefined,
              model: typeof handoffGeneration?.model === "string" ? handoffGeneration.model : undefined,
              requestedAt:
                typeof handoffGeneration?.requestedAt === "string" ? handoffGeneration.requestedAt : undefined,
              completedAt:
                typeof handoffGeneration?.completedAt === "string" ? handoffGeneration.completedAt : undefined,
              usage: {
                inputTokens: handoffUsage.inputTokens,
                outputTokens: handoffUsage.outputTokens,
                cacheReadTokens: handoffUsage.cacheReadTokens,
              },
              request:
                handoffGeneration?.request && typeof handoffGeneration.request === "object"
                  ? (handoffGeneration.request as Record<string, unknown>)
                  : undefined,
              error: typeof handoffGeneration?.error === "string" ? handoffGeneration.error : undefined,
              roi: {
                turnNetTokenBenefit: handoffTurnNetTokenBenefit,
                cumulativeNetTokenBenefit: cumulativeHandoffNetTokenBenefit,
              },
            }
          : {
              requested: false,
              usageKnown: false,
            },
        roi: {
          turnNetTokenBenefit,
          cumulativeNetTokenBenefit,
          summaryTurnNetTokenBenefit,
          cumulativeSummaryNetTokenBenefit,
          handoffTurnNetTokenBenefit,
          cumulativeHandoffNetTokenBenefit,
          effectiveTurnNetTokenBenefit,
          effectiveCumulativeNetTokenBenefit,
        },
      };

      const nextResult = {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          decisionLedger: {
            plan,
            outcome,
          },
        },
      };

      return appendResultEvent(nextResult, {
        type: RUNTIME_EVENT_TYPES.DECISION_L1_RECORDED,
        source: "module-decision-ledger",
        at: now,
        payload: {
          phase: "outcome",
          decision: plan?.decision ?? "kept",
          reason: plan?.reason ?? "l1_static_policy",
          confidence: plan?.confidence ?? 0.5,
          confidenceLevel: plan?.confidenceLevel ?? "low",
          apiFamily,
          turn: state.turn,
          usage: outcome.usage,
          summaryGeneration: outcome.summaryGeneration,
          handoffGeneration: outcome.handoffGeneration,
          roi: outcome.roi,
        },
      });
    },
  };
}
