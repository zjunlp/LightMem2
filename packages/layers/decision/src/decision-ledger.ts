import {
  ECOCLAW_EVENT_TYPES,
  appendContextEvent,
  appendResultEvent,
  resolveApiFamily,
  type ApiFamily,
  type DecisionConfidenceLevel,
  type DecisionEvidence,
  type DecisionRecord,
  type RuntimeModule,
} from "@ecoclaw/kernel";

export type DecisionLedgerModuleConfig = {
  enabled?: boolean;
  maxEvidence?: number;
};

type SessionLedgerState = {
  turn: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  cumulativeCacheReadTokens: number;
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

function collectEvidence(ctx: any, apiFamily: ApiFamily, maxEvidence: number): DecisionEvidence[] {
  const evidence: DecisionEvidence[] = [];
  const taskRouter = (ctx.metadata?.taskRouter ?? {}) as Record<string, unknown>;
  const policy = (ctx.metadata?.policy ?? {}) as Record<string, unknown>;
  const cache = (ctx.metadata?.cache ?? {}) as Record<string, unknown>;

  addEvidence(evidence, "runtime", "apiFamily", apiFamily);
  addEvidence(evidence, "runtime", "provider", ctx.provider);
  addEvidence(evidence, "runtime", "model", ctx.model);
  addEvidence(evidence, "taskRouter", "tier", taskRouter.tier);
  addEvidence(evidence, "taskRouter", "decision", taskRouter.decision);
  addEvidence(evidence, "taskRouter", "reason", taskRouter.reason);
  addEvidence(evidence, "policy", "shouldRequestSummary", policy.shouldRequestSummary);
  addEvidence(evidence, "policy", "recentCacheMissRate", policy.recentCacheMissRate);
  addEvidence(evidence, "policy", "cacheExpiresSoon", policy.cacheExpiresSoon);
  addEvidence(evidence, "cache", "eligible", cache.eligible);
  addEvidence(evidence, "cache", "prefixChars", cache.prefixChars);

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
        type: ECOCLAW_EVENT_TYPES.DECISION_L1_RECORDED,
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

      const inputTokens = toNum(result.usage?.inputTokens) ?? 0;
      const outputTokens = toNum(result.usage?.outputTokens) ?? 0;
      const cacheReadTokens =
        toNum(result.usage?.cacheReadTokens) ??
        toNum(result.usage?.cachedTokens) ??
        toNum((result.usage?.providerRaw as Record<string, unknown> | undefined)?.cache_read_input_tokens) ??
        0;

      const state = stateBySession.get(ctx.sessionId) ?? {
        turn: 0,
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        cumulativeCacheReadTokens: 0,
      };
      state.turn += 1;
      state.cumulativeInputTokens += inputTokens;
      state.cumulativeOutputTokens += outputTokens;
      state.cumulativeCacheReadTokens += cacheReadTokens;
      stateBySession.set(ctx.sessionId, state);

      const turnNetTokenBenefit = cacheReadTokens - inputTokens - outputTokens;
      const cumulativeNetTokenBenefit =
        state.cumulativeCacheReadTokens - state.cumulativeInputTokens - state.cumulativeOutputTokens;

      const outcome = {
        at: now,
        apiFamily,
        turn: state.turn,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
        },
        roi: {
          turnNetTokenBenefit,
          cumulativeNetTokenBenefit,
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
        type: ECOCLAW_EVENT_TYPES.DECISION_L1_RECORDED,
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
          roi: outcome.roi,
        },
      });
    },
  };
}
