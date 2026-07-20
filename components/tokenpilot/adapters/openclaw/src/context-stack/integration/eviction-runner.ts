import type { RuntimeModule } from "@tokenpilot/kernel";

import { buildLifecyclePolicyContext } from "./lifecycle-policy-context.js";

export type EvictionRunResult = {
  enabled: boolean;
  executed: boolean;
  skippedReason?: "module_disabled" | "policy_module_unavailable";
  policyMetadata?: unknown;
};

export async function runEvictionIfEnabled(params: {
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
}): Promise<EvictionRunResult> {
  const enabled = Boolean(params.cfg.modules.eviction && params.cfg.eviction.enabled);
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
  return {
    enabled: true,
    executed: true,
    policyMetadata: applied.turnCtx.metadata?.policy,
  };
}
