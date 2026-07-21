import type { HostRequestEnvelope } from "../model/host-request.js";
import {
  applyBeforeCallReductionEnvelope,
} from "./reduction.js";
import {
  injectRecoveryProtocolEnvelope,
} from "./recovery.js";
import type {
  BeforeCallDiagnostics,
  HostPipelineConfig,
  HostPipelineHelpers,
} from "./types.js";

export async function prepareBeforeCall(params: {
  envelope: HostRequestEnvelope;
  config?: HostPipelineConfig;
  helpers?: HostPipelineHelpers;
}): Promise<{
  envelope: HostRequestEnvelope;
  diagnostics: BeforeCallDiagnostics;
}> {
  const diagnostics: BeforeCallDiagnostics = { notes: [] };
  const stableEnvelope = params.helpers?.prepareStablePrefix
    ? params.helpers.prepareStablePrefix(params.envelope)
    : params.envelope;
  diagnostics.stablePrefixApplied = stableEnvelope !== params.envelope;

  const recovery = injectRecoveryProtocolEnvelope(
    stableEnvelope,
    params.helpers?.injectRecoveryProtocol,
  );
  diagnostics.recoveryInjected = recovery.applied;

  const reduction = await applyBeforeCallReductionEnvelope(
    recovery.envelope,
    params.helpers?.applyBeforeCallReduction,
  );
  diagnostics.reductionApplied = reduction.applied;

  diagnostics.notes?.push(`mode=${params.config?.mode ?? "normal"}`);
  return { envelope: reduction.envelope, diagnostics };
}
