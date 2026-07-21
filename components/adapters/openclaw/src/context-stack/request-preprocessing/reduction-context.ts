/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ContextSegment, RuntimeTurnContext } from "@tokenpilot/kernel";
import type { BuildLayeredReductionContextDeps } from "./reduction-context-shared.js";
import { createReductionInstructionCollector } from "./reduction-context-instructions.js";
import { scanReductionInput } from "./reduction-context-scan.js";
export type {
  BuildLayeredReductionContextResult,
  ProxyReductionBinding,
  ReductionContextPassToggles,
} from "./reduction-context-types.js";
import type { BuildLayeredReductionContextResult, ReductionContextPassToggles } from "./reduction-context-types.js";

export function buildLayeredReductionContext(
  payload: any,
  triggerMinChars: number,
  sessionId: string,
  deps: BuildLayeredReductionContextDeps,
  passToggles?: ReductionContextPassToggles,
  passOptions?: Record<string, Record<string, unknown>>,
  segmentAnchorByCallId?: Map<string, { turnAbsIds: string[]; taskIds: string[] }>,
  orderedTurnAnchors?: Array<{ turnAbsId: string; taskIds: string[] }>,
): BuildLayeredReductionContextResult {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const instructionCollector = createReductionInstructionCollector({
    passToggles,
    passOptions,
    deps,
  });
  const scanResult = scanReductionInput({
    input,
    deps,
    memoryFaultRecoverToolName: deps.memoryFaultRecoverToolName,
    hasRecoveryMarker: deps.hasRecoveryMarker,
    segmentAnchorByCallId,
    orderedTurnAnchors,
    onReducibleText: instructionCollector.addReductionInstructions,
    onReadSegment: instructionCollector.recordReadSegmentId,
  });
  instructionCollector.finalizeReadStateInstructions();

  const turnCtx: RuntimeTurnContext = {
    sessionId: sessionId.trim() || "proxy-session",
    sessionMode: "single",
    provider: "openai",
    model: String(payload?.model ?? "unknown"),
    apiFamily: "openai-responses",
    prompt: "",
    segments: scanResult.segments as ContextSegment[],
    budget: {
      maxInputTokens: 1_000_000,
      reserveOutputTokens: 16_384,
    },
    metadata: {
      policy: {
        version: "v2",
        mode: "online",
        decisions: {
          reduction: {
            enabled: true,
            beforeCallPassIds: [
              instructionCollector.stats.passToggles.readStateCompaction ? "read_state_compaction" : null,
              instructionCollector.stats.passToggles.toolPayloadTrim ? "tool_payload_trim" : null,
              instructionCollector.stats.passToggles.htmlSlimming ? "html_slimming" : null,
              instructionCollector.stats.passToggles.execOutputTruncation ? "exec_output_truncation" : null,
            ].filter(Boolean) as string[],
            instructions: instructionCollector.reductionInstructions,
          },
        },
      },
    },
  };

  return {
    turnCtx,
    bindings: scanResult.bindings,
    stats: {
      inputItems: input.length,
      toolLikeItems: scanResult.toolLikeItems,
      persistedSkippedItems: scanResult.persistedSkippedItems,
      candidateBlocks: instructionCollector.stats.candidateBlocks,
      overThresholdBlocks: instructionCollector.stats.overThresholdBlocks,
      instructionCount: instructionCollector.reductionInstructions.length,
      enableToolPayloadTrim: instructionCollector.stats.enableToolPayloadTrim,
      passToggles: instructionCollector.stats.passToggles,
    },
  };
}
