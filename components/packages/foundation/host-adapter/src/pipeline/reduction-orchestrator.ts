import type {
  HostBeforeCallReductionContext,
  HostBeforeCallReductionOrchestrator,
  HostBeforeCallReductionResult,
  ReductionSkippedResult,
} from "./types.js";

export function buildDefaultSkippedReductionResult(
  context: HostBeforeCallReductionContext,
  skippedReason: string,
): ReductionSkippedResult {
  const rawPayload = context.rawPayload as { input?: unknown[] } | null | undefined;
  return {
    changedItems: 0,
    changedBlocks: 0,
    savedChars: 0,
    diagnostics: {
      engine: "layered",
      inputItems: Array.isArray(rawPayload?.input) ? rawPayload.input.length : 0,
      toolLikeItems: 0,
      candidateBlocks: 0,
      overThresholdBlocks: 0,
      triggerMinChars: context.triggerMinChars,
      maxToolChars: context.maxToolChars,
      instructionCount: 0,
      passCount: 0,
      skippedReason,
    },
  };
}

export async function runBeforeCallReductionOrchestrator(
  orchestrator: HostBeforeCallReductionOrchestrator,
  context: HostBeforeCallReductionContext,
): Promise<HostBeforeCallReductionResult> {
  if (context.proxyPureForward || !context.reductionEnabled) {
    const skippedReason = context.proxyPureForward ? "proxy_pure_forward" : "module_disabled";
    return (
      orchestrator.buildSkippedResult?.(context, skippedReason) ??
      buildDefaultSkippedReductionResult(context, skippedReason)
    );
  }
  return orchestrator.runReduction(context);
}
