import type { RuntimeTurnContext, RuntimeTurnResult } from "./types.js";

export const ECOCLAW_EVENTS_METADATA_KEY = "ecoclawEvents";

export const ECOCLAW_EVENT_TYPES = {
  // Cache
  CACHE_BEFORE_BUILD_EVALUATED: "cache.before_build.evaluated",
  CACHE_AFTER_CALL_SKIPPED: "cache.after_call.skipped",
  CACHE_AFTER_CALL_RECORDED: "cache.after_call.recorded",
  // Policy
  POLICY_SUMMARY_REQUESTED: "policy.summary.requested",
  POLICY_FORK_RECOMMENDED: "policy.fork.recommended",
  POLICY_CACHE_JITTER_DETECTED: "policy.cache.jitter.detected",
  POLICY_CACHE_PROBE_DECIDED: "policy.cache.probe.decided",
  POLICY_CACHE_PROBE_RESULT: "policy.cache.probe.result",
  // Decision ledger
  DECISION_L1_RECORDED: "decision.l1.recorded",
  // Summary
  SUMMARY_GENERATED: "summary.generated",
  // Memory state
  MEMORY_SEED_AVAILABLE: "memory.seed.available",
  MEMORY_STATE_UPDATED: "memory.state.updated",
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
