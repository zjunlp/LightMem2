import type { HostPayloadCodec } from "../contracts/payload-codec.js";
import type { HostRequestEnvelope } from "../model/host-request.js";
import { prepareBeforeCall } from "./before-call.js";
import type { PreparedBeforeCallResult } from "./types.js";

export async function prepareBeforeCallWithReductionSummary<TReductionSummary>(params: {
  envelope: HostRequestEnvelope;
  codec: HostPayloadCodec;
  config?: { mode?: "conservative" | "normal" | "aggressive" };
  prepareStablePrefix(envelope: HostRequestEnvelope): HostRequestEnvelope;
  applyBeforeCallReduction(args: {
    envelope: HostRequestEnvelope;
    codec: HostPayloadCodec;
  }): Promise<{ envelope: HostRequestEnvelope; summary: TReductionSummary }>;
}): Promise<PreparedBeforeCallResult<TReductionSummary>> {
  let reductionSummary: TReductionSummary | undefined;
  const prepared = await prepareBeforeCall({
    envelope: params.envelope,
    config: params.config,
    helpers: {
      prepareStablePrefix: params.prepareStablePrefix,
      async applyBeforeCallReduction(nextEnvelope) {
        const reduced = await params.applyBeforeCallReduction({
          envelope: nextEnvelope,
          codec: params.codec,
        });
        reductionSummary = reduced.summary;
        return reduced.envelope;
      },
    },
  });
  return {
    envelope: prepared.envelope,
    diagnostics: prepared.diagnostics,
    reductionSummary,
  };
}
