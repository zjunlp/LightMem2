/* eslint-disable @typescript-eslint/no-explicit-any */
import { createOpenClawHostBridge } from "./openclaw-host-bridge.js";
import { upsertOpenClawSessionSummary } from "../../session/session-summary.js";

export async function recordStreamingUxEffect(params: {
  cfg: any;
  helpers: any;
  logger: any;
  model: string;
  upstreamModel: string;
  resolvedSessionId: string;
  originalInputText: string;
  afterReductionInputText: string;
  beforeReductionCanonicalInput: string;
  afterReductionCanonicalInput: string;
  streamChunks: Buffer[];
  reductionApplied?: { savedChars?: number } | null;
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
    beforeReductionCanonicalInput,
    afterReductionCanonicalInput,
    streamChunks,
    reductionApplied,
  } = params;
  if (!cfg.stateDir || streamChunks.length === 0) return;

  try {
    const streamedRawText = Buffer.concat(streamChunks).toString("utf8");
    const streamSnapshot = createOpenClawHostBridge(helpers).snapshotStream(streamedRawText);
    const responseText = streamSnapshot.assistantText;
    const inputBeforeCount = await helpers.countTokensWithFallback(model || upstreamModel || "gpt-5.4-mini", originalInputText);
    const inputAfterCount = await helpers.countTokensWithFallback(model || upstreamModel || "gpt-5.4-mini", afterReductionInputText);
    const responseCount = await helpers.countTokensWithFallback(model || upstreamModel || "gpt-5.4-mini", responseText);
    const countMode =
      inputBeforeCount.mode === "litellm_tokens"
      && inputAfterCount.mode === "litellm_tokens"
      && responseCount.mode === "litellm_tokens"
        ? "litellm_tokens"
        : "chars";
    const requestSavedCount = countMode === "chars"
      ? Math.max(0, beforeReductionCanonicalInput.length - afterReductionCanonicalInput.length)
      : Math.max(0, inputBeforeCount.count - inputAfterCount.count);
    const afterCount = inputAfterCount.count + responseCount.count;
    const beforeCount = countMode === "chars"
      ? afterCount + requestSavedCount
      : inputBeforeCount.count + responseCount.count;
    await helpers.recordUxEffect(cfg.stateDir, {
      at: new Date().toISOString(),
      sessionId: resolvedSessionId,
      model: model || upstreamModel || "unknown",
      countMode,
      beforeCount,
      afterCount,
      savedCount: requestSavedCount,
      details: {
        requestSavedCount,
        responseSavedCount: 0,
      },
    });
    await upsertOpenClawSessionSummary(cfg.stateDir, resolvedSessionId, {
      latestModel: model || upstreamModel || "unknown",
      requestChars: afterReductionInputText.length,
      responseChars: responseText.length,
      assistantChars: responseText.length,
      reductionSavedChars: Number(reductionApplied?.savedChars ?? 0),
      updatedAt: new Date().toISOString(),
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
