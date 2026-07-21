import type { HostRequestEnvelope } from "../model/host-request.js";
import type { HostResponseEnvelope } from "../model/host-response.js";
import { applyAfterCallReductionEnvelope } from "./reduction.js";
import type {
  AfterCallDiagnostics,
  HostPipelineConfig,
  HostPipelineHelpers,
} from "./types.js";

export async function finalizeAfterCall(params: {
  request: HostRequestEnvelope;
  response: HostResponseEnvelope;
  config?: HostPipelineConfig;
  helpers?: HostPipelineHelpers;
}): Promise<{
  response: HostResponseEnvelope;
  diagnostics: AfterCallDiagnostics;
}> {
  const reduction = await applyAfterCallReductionEnvelope(
    params.request,
    params.response,
    params.helpers?.applyAfterCallReduction,
  );

  return {
    response: reduction.response,
    diagnostics: {
      reductionApplied: reduction.applied,
      notes: [`mode=${params.config?.mode ?? "normal"}`],
    },
  };
}
