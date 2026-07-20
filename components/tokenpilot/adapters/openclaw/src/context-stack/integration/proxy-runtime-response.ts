/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UpstreamConfig, UpstreamHttpResponse } from "./upstream.js";
import { appendModuleObservation } from "@tokenpilot/product-surface";
import { createOpenClawHostBridge } from "./openclaw-host-bridge.js";
import { applyProxyAfterCallReduction, recordNonStreamingUxEffect } from "./proxy-runtime-postprocess.js";
import { recordStreamingUxEffect } from "./proxy-runtime-stream.js";
import { recordProxyForwarding, recordProxyResponse } from "./proxy-runtime-logging.js";
import { appendOpenClawCacheAuditRecord } from "../../cache-audit.js";

async function recordRealizedReductionSavings(args: {
  cfg: any;
  logger: any;
  sessionId: string;
  enabled: boolean;
  reductionApplied: any;
}): Promise<void> {
  const { cfg, logger, sessionId, enabled, reductionApplied } = args;
  if (!cfg.stateDir || !enabled) return;
  const savedChars = Math.max(0, Number(reductionApplied?.savedChars ?? 0));
  if (savedChars === 0) return;
  try {
    await appendModuleObservation(cfg.stateDir, {
      sessionId,
      phase: "response",
      moduleId: "reduction",
      enabled: true,
      executed: false,
      changed: false,
      savedChars,
      savedTokens: Math.max(0, Math.round(savedChars / 4)),
      api: { inputTokens: 0, outputTokens: 0 },
    });
  } catch (error) {
    logger.warn?.(
      `[plugin-runtime] realized reduction observation write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleStreamingProxyResponse(args: {
  cfg: any;
  res: any;
  helpers: any;
  logger: any;
  upstream: UpstreamConfig;
  activePayload: any;
  requestEnvelope?: any;
  payloadCodec?: any;
  resolvedSessionId: string;
  model: string;
  upstreamModel: string;
  proxyPureForward: boolean;
  originalInputText: string;
  afterReductionInputText: string;
  beforeReductionCanonicalInput: string;
  afterReductionCanonicalInput: string;
  reductionApplied: any;
  cacheAuditSnapshot?: Omit<import("../../cache-audit.js").OpenClawCacheAuditRecord, "at" | "responsePromptCacheKey" | "cachedInputTokens" | "usage" | "status">;
}): Promise<void> {
  const {
    cfg,
    res,
    helpers,
    logger,
    upstream,
    activePayload,
    resolvedSessionId,
    model,
    upstreamModel,
    proxyPureForward,
    originalInputText,
    afterReductionInputText,
    beforeReductionCanonicalInput,
    afterReductionCanonicalInput,
    reductionApplied,
    cacheAuditSnapshot,
  } = args;
  const reductionEnabled = !proxyPureForward && Boolean(cfg.moduleEnablement?.reduction);
  const upstreamStreamResp = await helpers.requestUpstreamResponsesStream(upstream, activePayload, logger, cfg.stateDir);
  await recordRealizedReductionSavings({
    cfg,
    logger,
    sessionId: resolvedSessionId,
    enabled: reductionEnabled,
    reductionApplied,
  });
  if (cfg.stateDir) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "proxy_stream_forward",
      sessionId: resolvedSessionId,
      model,
      proxyPureForward,
      responseContentType: upstreamStreamResp.headers["content-type"] ?? null,
      transport: upstreamStreamResp.transport,
    });
  }
  res.statusCode = upstreamStreamResp.status;
  for (const [headerName, headerValue] of Object.entries(upstreamStreamResp.headers)) {
    if (typeof headerValue !== "string" || headerValue.length === 0) continue;
    const lower = headerName.toLowerCase();
    if (lower === "content-length") continue;
    res.setHeader(headerName, headerValue);
  }
  if (!res.hasHeader("content-type")) {
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
  }
  const streamChunks: Buffer[] = [];
  let streamEnded = false;
  let responseFinished = false;
  let responseClosed = false;
  upstreamStreamResp.stream.on("data", (chunk: Buffer | string) => {
    streamChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  });
  await new Promise<void>((resolve, reject) => {
    upstreamStreamResp.stream.on("error", reject);
    res.on("finish", () => {
      responseFinished = true;
      resolve();
    });
    res.on("close", () => {
      responseClosed = true;
      resolve();
    });
    upstreamStreamResp.stream.on("end", () => {
      streamEnded = true;
    });
    upstreamStreamResp.stream.pipe(res);
  });
  if (cfg.stateDir && (responseFinished || streamEnded) && streamChunks.length > 0) {
    if (reductionEnabled) {
      await recordStreamingUxEffect({
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
      });
    }
    const streamSnapshot = createOpenClawHostBridge(helpers).snapshotStream(Buffer.concat(streamChunks).toString("utf8"));
    if (cfg.stateDir && cacheAuditSnapshot) {
      await appendOpenClawCacheAuditRecord({
        stateDir: cfg.stateDir,
        snapshot: cacheAuditSnapshot,
        responsePromptCacheKey: streamSnapshot.promptCacheKey ?? null,
        usage: streamSnapshot.usage ?? null,
        status: upstreamStreamResp.status,
      });
    }
  } else if (cfg.stateDir && responseClosed && !responseFinished) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "proxy_stream_ux_skipped",
      sessionId: resolvedSessionId,
      model,
      upstreamModel,
      reason: "response_closed_before_finish",
      streamEnded,
      streamedChunkCount: streamChunks.length,
    });
  }
}

export async function handleNonStreamingProxyResponse(args: {
  cfg: any;
  res: any;
  helpers: any;
  logger: any;
  upstream: UpstreamConfig;
  activePayload: any;
  requestEnvelope?: any;
  payloadCodec?: any;
  resolvedSessionId: string;
  model: string;
  upstreamModel: string;
  proxyPureForward: boolean;
  originalInputText: string;
  afterReductionInputText: string;
  beforeReductionCanonicalInput: string;
  afterReductionCanonicalInput: string;
  reductionApplied: any;
  reductionPassOptions: any;
  reductionMaxToolChars: number;
  reductionTriggerMinChars: number;
  cacheAuditSnapshot?: Omit<import("../../cache-audit.js").OpenClawCacheAuditRecord, "at" | "responsePromptCacheKey" | "cachedInputTokens" | "usage" | "status">;
}): Promise<void> {
  const {
    cfg,
    res,
    helpers,
    logger,
    upstream,
    activePayload,
    requestEnvelope,
    payloadCodec,
    resolvedSessionId,
    model,
    upstreamModel,
    proxyPureForward,
    originalInputText,
    afterReductionInputText,
    beforeReductionCanonicalInput,
    afterReductionCanonicalInput,
    reductionApplied,
    reductionPassOptions,
    reductionMaxToolChars,
    reductionTriggerMinChars,
    cacheAuditSnapshot,
  } = args;
  const reductionEnabled = !proxyPureForward && Boolean(cfg.moduleEnablement?.reduction);
  const hostBridge = createOpenClawHostBridge(helpers);
  const responseCodec = payloadCodec ?? hostBridge.payloadCodec;
  let upstreamResp: UpstreamHttpResponse | null = null;
  let txt = "";
  let parsedResponseForMirror: any = null;
  let responseContentType = "";
  const memoryFaultAutoReplayCount = 0;
  upstreamResp = await helpers.requestUpstreamResponses(upstream, activePayload, logger, cfg.stateDir);
  await recordRealizedReductionSavings({
    cfg,
    logger,
    sessionId: resolvedSessionId,
    enabled: reductionEnabled,
    reductionApplied,
  });
  const upstreamRespFinal = upstreamResp!;
  txt = upstreamRespFinal.text;
  const originalResponseText = txt;
  const beforeAfterCallTextChars = txt.length;
  responseContentType = upstreamRespFinal.headers["content-type"] ?? "";
  try {
    parsedResponseForMirror = JSON.parse(txt);
  } catch {
    parsedResponseForMirror = null;
  }
  const responseEnvelope = parsedResponseForMirror
    ? hostBridge.decodeResponse(parsedResponseForMirror, activePayload)
    : null;
  const postprocessResult = await applyProxyAfterCallReduction({
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
  });
  txt = postprocessResult.txt;
  const afterCallReduction = postprocessResult.afterCallReduction;
  if (cfg.stateDir && reductionEnabled) {
    await helpers.appendTaskStateTrace(cfg.stateDir, {
      stage: "proxy_after_call_rewrite",
      sessionId: resolvedSessionId,
      model,
      proxyPureForward,
      responseContentType,
      parsedResponse: Boolean(parsedResponseForMirror),
      beforeTextChars: beforeAfterCallTextChars,
      afterTextChars: txt.length,
      changed: Boolean(afterCallReduction?.changed),
      savedChars: Number(afterCallReduction?.savedChars ?? 0),
      passCount: Number(afterCallReduction?.passCount ?? 0),
      skippedReason: afterCallReduction?.skippedReason ?? null,
      mode: afterCallReduction?.mode ?? null,
    });
  }
  await recordProxyResponse({
    cfg,
    helpers,
    txt,
    responseEnvelope,
    activePayload,
    model,
    upstreamModel,
    upstreamRespFinal,
    afterCallReduction,
    shouldRecordReduction: reductionEnabled,
    memoryFaultAutoReplayCount,
  });
  if (cfg.stateDir && cacheAuditSnapshot) {
    await appendOpenClawCacheAuditRecord({
      stateDir: cfg.stateDir,
      snapshot: cacheAuditSnapshot,
      responsePromptCacheKey:
        typeof responseEnvelope?.metadata?.promptCacheKey === "string"
          ? responseEnvelope.metadata.promptCacheKey
          : typeof parsedResponseForMirror?.prompt_cache_key === "string"
            ? parsedResponseForMirror.prompt_cache_key
            : null,
      usage:
        responseEnvelope?.usage && typeof responseEnvelope.usage === "object"
          ? responseEnvelope.usage
          : parsedResponseForMirror?.usage && typeof parsedResponseForMirror.usage === "object"
            ? parsedResponseForMirror.usage
            : null,
      status: upstreamRespFinal.status,
    });
  }
  if (cfg.stateDir && reductionEnabled) {
    await recordNonStreamingUxEffect({
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
      finalResponseText: txt,
      reductionApplied,
      afterCallReduction,
    });
  }
  await recordProxyForwarding({
    cfg,
    helpers,
    txt,
    responseEnvelope,
    activePayload,
    resolvedSessionId,
    model,
    upstreamModel,
    upstreamRespFinal,
    reductionApplied,
    afterCallReduction,
    memoryFaultAutoReplayCount,
  });
  res.statusCode = upstreamRespFinal.status;
  res.setHeader("content-type", upstreamRespFinal.headers["content-type"] ?? "application/json");
  res.end(txt);
}
