import type { HostRequestEnvelope } from "../model/host-request.js";
import type { HostResponseEnvelope } from "../model/host-response.js";

export type ReductionSkippedResult = {
  changedItems: number;
  changedBlocks: number;
  savedChars: number;
  diagnostics: {
    engine: string;
    inputItems: number;
    toolLikeItems: number;
    candidateBlocks: number;
    overThresholdBlocks: number;
    triggerMinChars: number;
    maxToolChars: number;
    instructionCount: number;
    passCount: number;
    skippedReason: string;
  };
};

export type BeforeCallDiagnostics = {
  stablePrefixApplied?: boolean;
  recoveryInjected?: boolean;
  reductionApplied?: boolean;
  notes?: string[];
};

export type AfterCallDiagnostics = {
  reductionApplied?: boolean;
  streamObserved?: boolean;
  notes?: string[];
};

export type HostPipelineConfig = {
  mode?: "conservative" | "normal" | "aggressive";
};

export type HostBeforeCallReductionContext = {
  rawPayload: unknown;
  sessionId: string;
  triggerMinChars: number;
  maxToolChars: number;
  proxyPureForward: boolean;
  reductionEnabled: boolean;
};

export type HostBeforeCallReductionResult = {
  changedItems: number;
  changedBlocks: number;
  savedChars: number;
  diagnostics?: Record<string, unknown>;
};

export type HostBeforeCallReductionOrchestrator = {
  runReduction(
    context: HostBeforeCallReductionContext,
  ): Promise<HostBeforeCallReductionResult> | HostBeforeCallReductionResult;
  buildSkippedResult?(
    context: HostBeforeCallReductionContext,
    skippedReason: string,
  ): HostBeforeCallReductionResult;
};

export type HostPipelineHelpers = {
  prepareStablePrefix?(envelope: HostRequestEnvelope): HostRequestEnvelope;
  injectRecoveryProtocol?(envelope: HostRequestEnvelope): HostRequestEnvelope;
  applyBeforeCallReduction?(envelope: HostRequestEnvelope): Promise<HostRequestEnvelope> | HostRequestEnvelope;
  applyAfterCallReduction?(
    request: HostRequestEnvelope,
    response: HostResponseEnvelope,
  ): Promise<HostResponseEnvelope> | HostResponseEnvelope;
};

export type PreparedBeforeCallResult<TReductionSummary = unknown> = {
  envelope: HostRequestEnvelope;
  diagnostics: BeforeCallDiagnostics;
  reductionSummary?: TReductionSummary;
};
