/* eslint-disable @typescript-eslint/no-explicit-any */

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
  parsedResponseForMirror: any;
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
    parsedResponseForMirror,
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
          activePayload,
          parsedResponseForMirror,
          reductionMaxToolChars,
          reductionTriggerMinChars,
          resolvedSessionId,
          cfg.reduction.passes,
          {
            repeated_read_dedup: reductionPassOptions.repeatedReadDedup ?? {},
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
          activePayload,
          nextText,
          reductionMaxToolChars,
          reductionTriggerMinChars,
          cfg.reduction.passes,
          {
            repeated_read_dedup: reductionPassOptions.repeatedReadDedup ?? {},
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
  originalResponseText: string;
  finalResponseText: string;
}): Promise<void> {
  const {
    cfg,
    helpers,
    model,
    upstreamModel,
    resolvedSessionId,
    originalInputText,
    afterReductionInputText,
    originalResponseText,
    finalResponseText,
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
  const requestSavedCount = Math.max(0, inputBeforeCount.count - inputAfterCount.count);
  const responseSavedCount = Math.max(0, responseBeforeCount.count - responseAfterCount.count);
  const savedCount = requestSavedCount + responseSavedCount;
  await helpers.recordUxEffect(cfg.stateDir, {
    at: new Date().toISOString(),
    sessionId: resolvedSessionId,
    model: model || upstreamModel || "unknown",
    countMode,
    beforeCount: inputBeforeCount.count + responseBeforeCount.count,
    afterCount: inputAfterCount.count + responseAfterCount.count,
    savedCount,
    details: {
      requestSavedCount,
      responseSavedCount,
    },
  });
}
