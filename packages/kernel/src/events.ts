import type { RuntimeTurnContext, RuntimeTurnResult } from "./types.js";

export const ECOCLAW_EVENTS_METADATA_KEY = "ecoclawEvents";

export const ECOCLAW_EVENT_TYPES = {
  // Stabilizer
  STABILIZER_BEFORE_BUILD_EVALUATED: "stabilizer.before_build.evaluated",
  STABILIZER_AFTER_CALL_SKIPPED: "stabilizer.after_call.skipped",
  STABILIZER_AFTER_CALL_RECORDED: "stabilizer.after_call.recorded",
  // Reduction
  REDUCTION_BEFORE_CALL_RECORDED: "reduction.before_call.recorded",
  REDUCTION_AFTER_CALL_RECORDED: "reduction.after_call.recorded",
  // Policy
  POLICY_SUMMARY_REQUESTED: "policy.summary.requested",
  POLICY_COMPACTION_REQUESTED: "policy.compaction.requested",
  POLICY_HANDOFF_REQUESTED: "policy.handoff.requested",
  POLICY_CACHE_JITTER_DETECTED: "policy.cache.jitter.detected",
  POLICY_CACHE_HEALTH_DECIDED: "policy.cache.health.decided",
  POLICY_CACHE_HEALTH_RESULT: "policy.cache.health.result",
  POLICY_REDUCTION_DECIDED: "policy.reduction.decided",
  // Compaction
  COMPACTION_PLAN_GENERATED: "compaction.plan.generated",
  COMPACTION_APPLY_EXECUTED: "compaction.apply.executed",
  // Branch materialization
  BRANCH_MATERIALIZED: "branch.materialized",
  // Decision ledger
  DECISION_L1_RECORDED: "decision.l1.recorded",
  // Summary
  SUMMARY_GENERATED: "summary.generated",
  // Handoff
  HANDOFF_REQUESTED: "handoff.requested",
  HANDOFF_GENERATED: "handoff.generated",
  // Context state
  CONTEXT_STATE_AVAILABLE: "context.state.available",
  CONTEXT_STATE_UPDATED: "context.state.updated",
} as const;

export type RuntimeEventType =
  | (typeof ECOCLAW_EVENT_TYPES)[keyof typeof ECOCLAW_EVENT_TYPES]
  | (string & {});

export type RuntimeEvent<TPayload = Record<string, unknown>> = {
  type: RuntimeEventType;
  source: string;
  at: string;
  payload: TPayload;
};

function toEventList(metadata?: Record<string, unknown>): RuntimeEvent[] {
  const raw = metadata?.[ECOCLAW_EVENTS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is RuntimeEvent =>
      typeof v === "object" && v !== null && "type" in v && "source" in v && "at" in v,
  );
}

export function getRuntimeEvents(metadata?: Record<string, unknown>): RuntimeEvent[] {
  return toEventList(metadata);
}

export function appendRuntimeEvent(
  metadata: Record<string, unknown> | undefined,
  event: RuntimeEvent,
): Record<string, unknown> {
  const nextEvents = [...toEventList(metadata), event];
  return {
    ...(metadata ?? {}),
    [ECOCLAW_EVENTS_METADATA_KEY]: nextEvents,
  };
}

export function appendContextEvent(
  ctx: RuntimeTurnContext,
  event: RuntimeEvent,
): RuntimeTurnContext {
  return {
    ...ctx,
    metadata: appendRuntimeEvent(ctx.metadata, event),
  };
}

export function appendResultEvent(
  result: RuntimeTurnResult,
  event: RuntimeEvent,
): RuntimeTurnResult {
  return {
    ...result,
    metadata: appendRuntimeEvent(result.metadata, event),
  };
}

export function findRuntimeEventsByType(
  metadata: Record<string, unknown> | undefined,
  type: RuntimeEventType,
): RuntimeEvent[] {
  return toEventList(metadata).filter((e) => e.type === type);
}
