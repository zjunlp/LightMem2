/* eslint-disable @typescript-eslint/no-explicit-any */
import { dirname } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import {
  buildVisualRequestId,
  findFirstMessageText,
  recordBeforeCallVisualState,
} from "@tokenpilot/product-surface";
import { buildStabilityVisualSnapshotFromEnvelopes } from "@tokenpilot/stabilizer";
import { pluginStateSubdir } from "@tokenpilot/artifact-store";
import { summarizeResponseFunctionCalls } from "./proxy-runtime-shared.js";

export async function recordProxyInbound(params: {
  cfg: any;
  helpers: any;
  upstream: any;
  requestEnvelope?: any;
  payload: any;
  resolvedSessionId: string;
  model: string;
  upstreamModel: string;
  instructions: string;
  stableRewrite: any;
  rootPromptRewrite: any;
  reductionApplied: any;
  developerForwardedText: string;
  developerCanonicalText: string;
  devAndUser: any;
  firstTurnCandidate: boolean;
  originalPromptCacheKey: string;
  dynamicContextTarget: "user" | "developer";
  shouldRecordStability: boolean;
  shouldRecordReduction: boolean;
}): Promise<void> {
  const {
    cfg,
    helpers,
    upstream,
    requestEnvelope,
    payload,
    resolvedSessionId,
    model,
    upstreamModel,
    instructions,
    stableRewrite,
    rootPromptRewrite,
    reductionApplied,
    developerForwardedText,
    developerCanonicalText,
    devAndUser,
    firstTurnCandidate,
    originalPromptCacheKey,
    dynamicContextTarget,
    shouldRecordStability,
    shouldRecordReduction,
  } = params;
  const activePayload = requestEnvelope?.rawPayload && typeof requestEnvelope.rawPayload === "object"
    ? requestEnvelope.rawPayload
    : payload;
  const requestAt = new Date().toISOString();
  const proxyLogPath = pluginStateSubdir(cfg.stateDir, "proxy-requests.jsonl");
  const visualResult = await recordBeforeCallVisualState({
    stateDir: cfg.stateDir,
    at: requestAt,
    sessionId: resolvedSessionId,
    model,
    upstreamModel,
    preparedEnvelope: requestEnvelope,
    stability: shouldRecordStability
      ? buildStabilityVisualSnapshotFromEnvelopes({
        at: requestAt,
        sessionId: resolvedSessionId,
        model,
        upstreamModel,
        originalEnvelope: {
          ...requestEnvelope,
          messages: Array.isArray(requestEnvelope?.messages) && devAndUser
            ? requestEnvelope.messages.map((message: any, index: number) => {
                if (index === devAndUser.developerIndex && rootPromptRewrite) {
                  return {
                    ...message,
                    content: String(rootPromptRewrite.rawPromptText ?? rootPromptRewrite.canonicalPromptText ?? ""),
                  };
                }
                if (index === devAndUser.userIndex && dynamicContextTarget === "user" && rootPromptRewrite?.dynamicContextText) {
                  return {
                    ...message,
                    content: String(devAndUser.userItem?.content ?? message?.content ?? ""),
                  };
                }
                return message;
              })
            : requestEnvelope?.messages ?? [],
          metadata: {
            ...(requestEnvelope?.metadata ?? {}),
            promptCacheKey: originalPromptCacheKey,
          },
        },
        dynamicContextTarget,
        getDeveloperText(envelope) {
          return findFirstMessageText(envelope, (message: any) => message?.role === "developer");
        },
        developerCanonical: developerCanonicalText,
        developerForwarded: developerForwardedText,
        dynamicContextText: String(rootPromptRewrite?.dynamicContextText ?? ""),
        senderMetadataBlocksBefore: Number(stableRewrite.senderMetadataBlocksBefore ?? 0),
        senderMetadataBlocksAfter: Number(stableRewrite.senderMetadataBlocksAfter ?? 0),
        firstTurnCandidate,
        preparedEnvelope: requestEnvelope,
      })
      : undefined,
    reductionSegments:
      shouldRecordReduction && Array.isArray(reductionApplied.visualSegments)
        ? reductionApplied.visualSegments
        : [],
  });
  const requestId = visualResult.reductionRequestId ?? "";
  const logRecord = {
    at: requestAt,
    requestId,
    stage: "proxy_inbound",
    sessionId: resolvedSessionId,
    model,
    upstreamModel,
    upstreamBaseUrl: upstream.baseUrl,
    instructionsLength: instructions.length,
    instructions: String(requestEnvelope?.instructions ?? activePayload?.instructions ?? ""),
    inputItemCount: Array.isArray(requestEnvelope?.messages) ? requestEnvelope.messages.length : Array.isArray(activePayload?.input) ? activePayload.input.length : -1,
    input: Array.isArray(requestEnvelope?.messages) ? requestEnvelope.messages : activePayload?.input,
    tools: Array.isArray(requestEnvelope?.tools) ? requestEnvelope.tools : activePayload?.tools,
    promptCacheKey: stableRewrite.promptCacheKey,
    developerRewritten: Boolean(rootPromptRewrite?.changed),
    developerRewriteWorkdir: rootPromptRewrite?.workdir ?? "",
    developerRewriteAgentId: rootPromptRewrite?.agentId ?? "",
    reductionChangedItems: reductionApplied.changedItems,
    reductionChangedBlocks: reductionApplied.changedBlocks,
    reductionSavedChars: reductionApplied.savedChars,
    reductionReport: reductionApplied.report ?? null,
    reductionDiagnostics: reductionApplied.diagnostics,
    reductionEngine: cfg.reduction.engine,
  };
  await mkdir(dirname(proxyLogPath), { recursive: true });
  await appendFile(proxyLogPath, `${JSON.stringify(logRecord)}\n`, "utf8");
  if (shouldRecordReduction) {
    await helpers.appendReductionPassTrace(cfg.stateDir, {
      at: requestAt,
      stage: "proxy_inbound",
      model,
      upstreamModel,
      promptCacheKey: stableRewrite.promptCacheKey,
      requestId,
      report: reductionApplied.report ?? [],
      extra: {
        reductionSavedChars: reductionApplied.savedChars,
        reductionChangedItems: reductionApplied.changedItems,
        reductionChangedBlocks: reductionApplied.changedBlocks,
      },
    });
  }
  if (!cfg.debugTapProviderTraffic) return;

  const debugRecord = {
    at: new Date().toISOString(),
    stage: "proxy_inbound",
    sessionId: resolvedSessionId,
    model,
    upstreamModel,
    instructionsChars: instructions.length,
    inputChars: helpers.normalizeText(helpers.extractInputText(
      Array.isArray(requestEnvelope?.messages) ? requestEnvelope.messages : activePayload?.input,
    )).length,
    devUserDetected: Boolean(devAndUser),
    firstTurnCandidate,
    developerChars: developerForwardedText.length,
    developerCanonicalChars: developerCanonicalText.length,
    developerRewritten: Boolean(rootPromptRewrite?.changed),
    developerRewriteWorkdir: rootPromptRewrite?.workdir ?? "",
    developerRewriteAgentId: rootPromptRewrite?.agentId ?? "",
    originalPromptCacheKey,
    rewrittenPromptCacheKey: stableRewrite.promptCacheKey,
    userContentRewrites: stableRewrite.userContentRewrites,
    senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
    senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
    reductionChangedItems: reductionApplied.changedItems,
    reductionChangedBlocks: reductionApplied.changedBlocks,
    reductionSavedChars: reductionApplied.savedChars,
    reductionReport: reductionApplied.report ?? null,
    reductionDiagnostics: reductionApplied.diagnostics,
    payload: activePayload,
  };
  await mkdir(dirname(cfg.debugTapPath), { recursive: true });
  await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
}

export async function recordProxyResponse(params: {
  cfg: any;
  helpers: any;
  txt: string;
  responseEnvelope?: any;
  activePayload: any;
  model: string;
  upstreamModel: string;
  upstreamRespFinal: any;
  afterCallReduction: any;
  shouldRecordReduction: boolean;
  memoryFaultAutoReplayCount: number;
}): Promise<void> {
  const {
    cfg,
    helpers,
    txt,
    responseEnvelope,
    activePayload,
    model,
    upstreamModel,
    upstreamRespFinal,
    afterCallReduction,
    shouldRecordReduction,
    memoryFaultAutoReplayCount,
  } = params;
  let parsedResponseSent: any = null;
  try {
    parsedResponseSent = JSON.parse(txt);
  } catch {
    parsedResponseSent = null;
  }
  const responseView = responseEnvelope ?? null;
  const responseAt = new Date().toISOString();
  const responseRequestId = buildVisualRequestId([
    responseAt,
    model,
    upstreamModel,
    activePayload?.prompt_cache_key ?? "",
    responseView?.metadata?.responseId ?? parsedResponseSent?.id ?? "",
    upstreamRespFinal.status,
  ]);
  const proxyRespLogPath = pluginStateSubdir(cfg.stateDir, "proxy-responses.jsonl");
  const respRecord = {
    at: responseAt,
    requestId: responseRequestId,
    stage: "proxy_response",
    model,
    upstreamModel,
    status: upstreamRespFinal.status,
    transport: upstreamRespFinal.transport,
    promptCacheKey: activePayload?.prompt_cache_key,
    promptCacheRetention: activePayload?.prompt_cache_retention,
    responseId: responseView?.metadata?.responseId ?? parsedResponseSent?.id ?? null,
    previousResponseId: responseView?.metadata?.previousResponseId ?? parsedResponseSent?.previous_response_id ?? null,
    responsePromptCacheKey: responseView?.metadata?.promptCacheKey ?? parsedResponseSent?.prompt_cache_key ?? null,
    responsePromptCacheRetention: responseView?.metadata?.promptCacheRetention ?? parsedResponseSent?.prompt_cache_retention ?? null,
    usage: responseView?.usage ?? parsedResponseSent?.usage ?? null,
    responseFunctionCalls: summarizeResponseFunctionCalls(parsedResponseSent),
    afterCallReduction: afterCallReduction ?? null,
    memoryFaultAutoReplayCount,
  };
  await mkdir(dirname(proxyRespLogPath), { recursive: true });
  await appendFile(proxyRespLogPath, `${JSON.stringify(respRecord)}\n`, "utf8");
  if (shouldRecordReduction) {
    await helpers.appendReductionPassTrace(cfg.stateDir, {
      at: responseAt,
      stage: "proxy_response",
      model,
      upstreamModel,
      promptCacheKey: String(activePayload?.prompt_cache_key ?? ""),
      requestId: responseRequestId,
      report: afterCallReduction?.report ?? [],
      extra: {
        status: upstreamRespFinal.status,
        transport: upstreamRespFinal.transport,
        responseId: parsedResponseSent?.id ?? "",
        responseReductionChanged: Boolean(afterCallReduction?.changed),
        responseReductionSavedChars: Number(afterCallReduction?.savedChars ?? 0),
        memoryFaultAutoReplayCount,
      },
    });
  }
}

export async function recordProxyForwarding(params: {
  cfg: any;
  helpers: any;
  txt: string;
  responseEnvelope?: any;
  activePayload: any;
  resolvedSessionId: string;
  model: string;
  upstreamModel: string;
  upstreamRespFinal: any;
  reductionApplied: any;
  afterCallReduction: any;
  memoryFaultAutoReplayCount: number;
}): Promise<void> {
  const {
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
  } = params;
  const forwardedRecord = {
    at: new Date().toISOString(),
    stage: "proxy_forwarded",
    sessionId: resolvedSessionId,
    model,
    upstreamModel,
    upstreamTransport: upstreamRespFinal.transport,
    forwardedHasPrev: typeof activePayload?.previous_response_id === "string" && activePayload.previous_response_id.length > 0,
    forwardedPromptCacheKey: typeof activePayload?.prompt_cache_key === "string" ? activePayload.prompt_cache_key : null,
    forwardedPromptCacheRetention: typeof activePayload?.prompt_cache_retention === "string" ? activePayload.prompt_cache_retention : null,
    forwardedInputCount: Array.isArray(activePayload?.input) ? activePayload.input.length : -1,
    forwardedInputRoles: Array.isArray(activePayload?.input) ? activePayload.input.map((x: any) => String(x?.role ?? "")) : [],
    forwardedReductionChangedItems: reductionApplied.changedItems,
    forwardedReductionChangedBlocks: reductionApplied.changedBlocks,
    forwardedReductionSavedChars: reductionApplied.savedChars,
    forwardedReductionReport: reductionApplied.report ?? null,
    afterCallReduction: afterCallReduction ?? null,
    memoryFaultAutoReplayCount,
    forwardedDeveloperChars: Array.isArray(activePayload?.input) && activePayload.input.length > 0 && String(activePayload.input[0]?.role) === "developer" && typeof activePayload.input[0]?.content === "string"
      ? String(activePayload.input[0].content).length
      : 0,
    payload: activePayload,
  };
  await helpers.appendJsonl(cfg.debugTapPath, forwardedRecord);
  await helpers.appendForwardedInputDump(cfg.stateDir, resolvedSessionId, forwardedRecord);

  if (!cfg.debugTapProviderTraffic) return;
  let parsedResponse: any = null;
  try {
    parsedResponse = JSON.parse(txt);
  } catch {}
  const responseView = responseEnvelope ?? null;
  const debugRecord = {
    at: new Date().toISOString(),
    stage: "proxy_outbound",
    model,
    upstreamModel,
    status: upstreamRespFinal.status,
    transport: upstreamRespFinal.transport,
    responseId: responseView?.metadata?.responseId ?? (typeof parsedResponse?.id === "string" ? parsedResponse.id : typeof parsedResponse?.response?.id === "string" ? parsedResponse.response.id : null),
    previousResponseId: responseView?.metadata?.previousResponseId ?? (typeof parsedResponse?.previous_response_id === "string" ? parsedResponse.previous_response_id : typeof parsedResponse?.response?.previous_response_id === "string" ? parsedResponse.response.previous_response_id : null),
    promptCacheKey: responseView?.metadata?.promptCacheKey ?? (typeof parsedResponse?.prompt_cache_key === "string" ? parsedResponse.prompt_cache_key : typeof parsedResponse?.response?.prompt_cache_key === "string" ? parsedResponse.response.prompt_cache_key : null),
    promptCacheRetention: responseView?.metadata?.promptCacheRetention ?? (typeof parsedResponse?.prompt_cache_retention === "string" ? parsedResponse.prompt_cache_retention : typeof parsedResponse?.response?.prompt_cache_retention === "string" ? parsedResponse.response.prompt_cache_retention : null),
    usage: responseView?.usage ?? parsedResponse?.usage ?? parsedResponse?.response?.usage ?? null,
    afterCallReduction,
    responseText: txt,
    memoryFaultAutoReplayCount,
  };
  await mkdir(dirname(cfg.debugTapPath), { recursive: true });
  await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
}
