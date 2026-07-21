import type { HostRequestEnvelope } from "../model/host-request.js";
import type { HostResponseEnvelope } from "../model/host-response.js";

export async function applyBeforeCallReductionEnvelope(
  envelope: HostRequestEnvelope,
  transform?: (envelope: HostRequestEnvelope) => Promise<HostRequestEnvelope> | HostRequestEnvelope,
): Promise<{ envelope: HostRequestEnvelope; applied: boolean }> {
  if (!transform) return { envelope, applied: false };
  const next = await transform(envelope);
  return { envelope: next, applied: next !== envelope };
}

export async function applyAfterCallReductionEnvelope(
  request: HostRequestEnvelope,
  response: HostResponseEnvelope,
  transform?: (
    request: HostRequestEnvelope,
    response: HostResponseEnvelope,
  ) => Promise<HostResponseEnvelope> | HostResponseEnvelope,
): Promise<{ response: HostResponseEnvelope; applied: boolean }> {
  if (!transform) return { response, applied: false };
  const next = await transform(request, response);
  return { response: next, applied: next !== response };
}
