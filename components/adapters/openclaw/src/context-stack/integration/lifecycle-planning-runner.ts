import type { RuntimeModule } from "@tokenpilot/kernel";
import {
  buildLifecyclePolicyContext,
  type LifecyclePlanningResult,
} from "@tokenpilot/eviction";

export type { LifecyclePlanningResult } from "@tokenpilot/eviction";

export async function runLifecyclePlanningIfEnabled(params: {
  cfg: any;
  logger: any;
  payload: any;
  sessionId: string;
  policyModule?: RuntimeModule;
  extractInputText(input: any): string;
  applyPolicyBeforeCall(
    turnCtx: any,
    cfg: any,
    logger: any,
    modules: { policy?: RuntimeModule },
  ): Promise<{ turnCtx: any }>;
}): Promise<LifecyclePlanningResult> {
  const enabled = Boolean(params.cfg.moduleEnablement.eviction);
  if (!enabled) {
    return { enabled: false, executed: false, skippedReason: "module_disabled" };
  }
  if (!params.policyModule) {
    return { enabled: true, executed: false, skippedReason: "policy_module_unavailable" };
  }

  const turnCtx = buildLifecyclePolicyContext({
    sessionId: params.sessionId,
    model: String(params.payload?.model ?? "unknown"),
    prompt: params.extractInputText(params.payload?.input),
  });
  const applied = await params.applyPolicyBeforeCall(turnCtx, params.cfg, params.logger, {
    policy: params.policyModule,
  });
  const policyMetadata = applied.turnCtx.metadata?.policy as any;
  const evictionDecision = policyMetadata?.decisions?.eviction;
  const taskStateDecision = policyMetadata?.decisions?.taskState;
  const plannedInstructionCount = Array.isArray(evictionDecision?.instructions)
    ? evictionDecision.instructions.length
    : 0;
  return {
    enabled: true,
    executed: true,
    registryChanged: Boolean(taskStateDecision?.applied),
    planCreated: plannedInstructionCount > 0,
    plannedSavedChars: Math.max(0, Number(evictionDecision?.estimatedSavedChars ?? 0)),
    plannedInstructionCount,
    ...(taskStateDecision?.estimatorUsage
      ? { estimatorUsage: taskStateDecision.estimatorUsage }
      : {}),
    policyMetadata,
  };
}
