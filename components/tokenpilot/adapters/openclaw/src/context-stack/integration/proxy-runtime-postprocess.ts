/* eslint-disable @typescript-eslint/no-explicit-any */

import { upsertOpenClawSessionSummary } from "../../session/session-summary.js";

function buildReductionHooks(helpers: any) {
  return {
    buildLayeredReductionContext: (payload: any, triggerMinChars: number, sessionId: string, passToggles?: any, passOptions?: any) =>
      helpers.buildLayeredReductionContext(
        payload,
        triggerMinChars,
        sessionId,
        {
          memoryFaultRecoverToolName: helpers.MEMORY_FAULT_RECOVER_TOOL_NAME,
          hasRecoveryMarker: helpers.hasRecoveryMarker,
          inferObservationPayloadKind: helpers.inferObservationPayloadKind,
        },
        passToggles,
        passOptions,
      ),
    isReductionPassEnabled: helpers.isReductionPassEnabled,
  };
}

export async function applyProxyAfterCallReduction(params: {
  proxyPureForward: boolean;
  cfg: any;
  helpers: any;
  activePayload: any;
  requestEnvelope?: any;
  parsedResponseForMirror: any;
  responseEnvelope?: any;
  txt: string;
  responseContentType: string;
  reductionMaxToolChars: number;
  reductionTriggerMinChars: number;
  resolvedSessionId: string;
  reductionPassOptions: any;
}): Promise<{ txt: string; afterCallReduction: any }> {
  const {
    proxyPureForward,
    cfg,
    helpers,
    activePayload,
    requestEnvelope,
    parsedResponseForMirror,
    responseEnvelope,
    txt,
    responseContentType,
    reductionMaxToolChars,
    reductionTriggerMinChars,
    resolvedSessionId,
    reductionPassOptions,
  } = params;

  let nextText = txt;
  let afterCallReduction: any = null;

  if (!proxyPureForward && cfg.modules.reduction && cfg.reduction.engine === "layered") {
    if (parsedResponseForMirror) {
      try {
        afterCallReduction = await helpers.applyLayeredReductionAfterCall(
          requestEnvelope?.rawPayload ?? activePayload,
          parsedResponseForMirror,
          reductionMaxToolChars,
          reductionTriggerMinChars,
          resolvedSessionId,
          cfg.reduction.passes,
          {
            read_state_compaction: reductionPassOptions.readStateCompaction ?? {},
            tool_payload_trim: reductionPassOptions.toolPayloadTrim ?? {},
            html_slimming: reductionPassOptions.htmlSlimming ?? {},
            exec_output_truncation: reductionPassOptions.execOutputTruncation ?? {},
            agents_startup_optimization: reductionPassOptions.agentsStartupOptimization ?? {},
            format_slimming: reductionPassOptions.formatSlimming ?? {},
            format_cleaning: reductionPassOptions.formatCleaning ?? {},
            path_truncation: reductionPassOptions.pathTruncation ?? {},
            image_downsample: reductionPassOptions.imageDownsample ?? {},
            line_number_strip: reductionPassOptions.lineNumberStrip ?? {},
          },
          buildReductionHooks(helpers),
        );
        if (afterCallReduction.changed) {
          nextText = JSON.stringify(parsedResponseForMirror);
        }
        afterCallReduction = { ...afterCallReduction, mode: "json" };
      } catch {
        afterCallReduction = { changed: false, savedChars: 0, passCount: 0, skippedReason: "after_call_error", mode: "json" };
      }
    } else if (helpers.isSseContentType(responseContentType)) {
      try {
        const sseResult = await helpers.applyLayeredReductionAfterCallToSse(
          requestEnvelope?.rawPayload ?? activePayload,
          nextText,
          reductionMaxToolChars,
          reductionTriggerMinChars,
          cfg.reduction.passes,
          {
            read_state_compaction: reductionPassOptions.readStateCompaction ?? {},
            tool_payload_trim: reductionPassOptions.toolPayloadTrim ?? {},
            html_slimming: reductionPassOptions.htmlSlimming ?? {},
            exec_output_truncation: reductionPassOptions.execOutputTruncation ?? {},
            agents_startup_optimization: reductionPassOptions.agentsStartupOptimization ?? {},
            format_slimming: reductionPassOptions.formatSlimming ?? {},
            format_cleaning: reductionPassOptions.formatCleaning ?? {},
            path_truncation: reductionPassOptions.pathTruncation ?? {},
            image_downsample: reductionPassOptions.imageDownsample ?? {},
            line_number_strip: reductionPassOptions.lineNumberStrip ?? {},
          },
          buildReductionHooks(helpers),
        );
        nextText = sseResult.text;
        afterCallReduction = sseResult.reduction;
      } catch {
        afterCallReduction = { changed: false, savedChars: 0, passCount: 0, skippedReason: "after_call_sse_error", mode: "sse" };
      }
    } else {
      afterCallReduction = { changed: false, savedChars: 0, passCount: 0, skippedReason: "unsupported_response_shape" };
    }
  } else if (proxyPureForward) {
    afterCallReduction = { changed: false, savedChars: 0, passCount: 0, skippedReason: "proxy_pure_forward" };
  }

  return { txt: nextText, afterCallReduction };
}

export async function recordNonStreamingUxEffect(params: {
  cfg: any;
  helpers: any;
  model: string;
  upstreamModel: string;
  resolvedSessionId: string;
  originalInputText: string;
  afterReductionInputText: string;
  beforeReductionCanonicalInput: string;
  afterReductionCanonicalInput: string;
  originalResponseText: string;
  finalResponseText: string;
  reductionApplied?: { savedChars?: number } | null;
  afterCallReduction?: { savedChars?: number } | null;
}): Promise<void> {
  const {
    cfg,
    helpers,
    model,
    upstreamModel,
    resolvedSessionId,
    originalInputText,
    afterReductionInputText,
    beforeReductionCanonicalInput,
    afterReductionCanonicalInput,
    originalResponseText,
    finalResponseText,
    reductionApplied,
    afterCallReduction,
  } = params;
  if (!cfg.stateDir) return;

  const countingModel = model || upstreamModel || "gpt-5.4-mini";
  const inputBeforeCount = await helpers.countTokensWithFallback(countingModel, originalInputText);
  const inputAfterCount = await helpers.countTokensWithFallback(countingModel, afterReductionInputText);
  const responseBeforeCount = await helpers.countTokensWithFallback(countingModel, originalResponseText);
  const responseAfterCount = await helpers.countTokensWithFallback(countingModel, finalResponseText);
  const countMode =
    inputBeforeCount.mode === "litellm_tokens"
    && inputAfterCount.mode === "litellm_tokens"
    && responseBeforeCount.mode === "litellm_tokens"
    && responseAfterCount.mode === "litellm_tokens"
      ? "litellm_tokens"
      : "chars";
  const requestSavedCount = countMode === "chars"
    ? Math.max(0, beforeReductionCanonicalInput.length - afterReductionCanonicalInput.length)
    : Math.max(0, inputBeforeCount.count - inputAfterCount.count);
  const responseSavedCount = countMode === "chars"
    ? Math.max(0, Number(afterCallReduction?.savedChars ?? (responseBeforeCount.count - responseAfterCount.count)))
    : Math.max(0, responseBeforeCount.count - responseAfterCount.count);
  const savedCount = requestSavedCount + responseSavedCount;
  const afterCount = inputAfterCount.count + responseAfterCount.count;
  const beforeCount = countMode === "chars"
    ? afterCount + savedCount
    : inputBeforeCount.count + responseBeforeCount.count;
  await helpers.recordUxEffect(cfg.stateDir, {
    at: new Date().toISOString(),
    sessionId: resolvedSessionId,
    model: model || upstreamModel || "unknown",
    countMode,
    beforeCount,
    afterCount,
    savedCount,
    details: {
      requestSavedCount,
      responseSavedCount,
    },
  });
  await upsertOpenClawSessionSummary(cfg.stateDir, resolvedSessionId, {
    latestModel: model || upstreamModel || "unknown",
    requestChars: afterReductionInputText.length,
    responseChars: finalResponseText.length,
    assistantChars: finalResponseText.length,
    reductionSavedChars: Number(reductionApplied?.savedChars ?? 0) + Number(afterCallReduction?.savedChars ?? 0),
    updatedAt: new Date().toISOString(),
  });
}
