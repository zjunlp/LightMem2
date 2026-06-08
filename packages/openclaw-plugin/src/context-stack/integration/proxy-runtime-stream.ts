/* eslint-disable @typescript-eslint/no-explicit-any */

export async function recordStreamingUxEffect(params: {
  cfg: any;
  helpers: any;
  logger: any;
  model: string;
  upstreamModel: string;
  resolvedSessionId: string;
  originalInputText: string;
  afterReductionInputText: string;
  streamChunks: Buffer[];
}): Promise<void> {
  const {
    cfg,
    helpers,
    logger,
    model,
    upstreamModel,
    resolvedSessionId,
    originalInputText,
    afterReductionInputText,
    streamChunks,
  } = params;
  if (!cfg.stateDir || streamChunks.length === 0) return;

  try {
    const streamedRawText = Buffer.concat(streamChunks).toString("utf8");
    const responseText = helpers.extractProviderResponseText(
      streamedRawText,
      null,
      helpers.contentToText,
    );
    const inputBeforeCount = await helpers.countTokensWithFallback(model || upstreamModel || "gpt-5.4-mini", originalInputText);
    const inputAfterCount = await helpers.countTokensWithFallback(model || upstreamModel || "gpt-5.4-mini", afterReductionInputText);
    const responseCount = await helpers.countTokensWithFallback(model || upstreamModel || "gpt-5.4-mini", responseText);
    const countMode =
      inputBeforeCount.mode === "litellm_tokens"
      && inputAfterCount.mode === "litellm_tokens"
      && responseCount.mode === "litellm_tokens"
        ? "litellm_tokens"
        : "chars";
    const requestSavedCount = Math.max(0, inputBeforeCount.count - inputAfterCount.count);
    await helpers.recordUxEffect(cfg.stateDir, {
      at: new Date().toISOString(),
      sessionId: resolvedSessionId,
      model: model || upstreamModel || "unknown",
      countMode,
      beforeCount: inputBeforeCount.count + responseCount.count,
      afterCount: inputAfterCount.count + responseCount.count,
      savedCount: requestSavedCount,
      details: {
        requestSavedCount,
        responseSavedCount: 0,
      },
    });
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "proxy_stream_ux_recorded",
      sessionId: resolvedSessionId,
      model,
      upstreamModel,
      responseChars: responseText.length,
      requestSavedCount,
      countMode,
    });
  } catch (err) {
    logger.warn(`[plugin-runtime] stream ux record failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
