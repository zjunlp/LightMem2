/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UpstreamConfig, UpstreamHttpResponse } from "./upstream.js";
import { applyProxyAfterCallReduction, recordNonStreamingUxEffect } from "./proxy-runtime-postprocess.js";
import { recordStreamingUxEffect } from "./proxy-runtime-stream.js";
import { recordProxyForwarding, recordProxyResponse } from "./proxy-runtime-logging.js";

export async function handleStreamingProxyResponse(args: {
  cfg: any;
  res: any;
  helpers: any;
  logger: any;
  upstream: UpstreamConfig;
  activePayload: any;
  resolvedSessionId: string;
  model: string;
  upstreamModel: string;
  proxyPureForward: boolean;
  originalInputText: string;
  afterReductionInputText: string;
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
  } = args;
  const upstreamStreamResp = await helpers.requestUpstreamResponsesStream(upstream, activePayload, logger, cfg.stateDir);
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
    await recordStreamingUxEffect({
      cfg,
      helpers,
      logger,
      model,
      upstreamModel,
      resolvedSessionId,
      originalInputText,
      afterReductionInputText,
      streamChunks,
    });
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
  resolvedSessionId: string;
  model: string;
  upstreamModel: string;
  proxyPureForward: boolean;
  originalInputText: string;
  afterReductionInputText: string;
  reductionApplied: any;
  reductionPassOptions: any;
  reductionMaxToolChars: number;
  reductionTriggerMinChars: number;
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
    reductionApplied,
    reductionPassOptions,
    reductionMaxToolChars,
    reductionTriggerMinChars,
  } = args;
  let upstreamResp: UpstreamHttpResponse | null = null;
  let txt = "";
  let parsedResponseForMirror: any = null;
  let responseContentType = "";
  const memoryFaultAutoReplayCount = 0;
  upstreamResp = await helpers.requestUpstreamResponses(upstream, activePayload, logger, cfg.stateDir);
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
  const postprocessResult = await applyProxyAfterCallReduction({
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
  });
  txt = postprocessResult.txt;
  const afterCallReduction = postprocessResult.afterCallReduction;
  if (cfg.stateDir) {
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
    activePayload,
    model,
    upstreamModel,
    upstreamRespFinal,
    afterCallReduction,
    memoryFaultAutoReplayCount,
  });
  if (cfg.stateDir) {
    await recordNonStreamingUxEffect({
      cfg,
      helpers,
      model,
      upstreamModel,
      resolvedSessionId,
      originalInputText,
      afterReductionInputText,
      originalResponseText,
      finalResponseText: txt,
    });
  }
  await recordProxyForwarding({
    cfg,
    helpers,
    txt,
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
