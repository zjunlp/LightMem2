/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";
import type { UpstreamConfig, UpstreamHttpResponse } from "../../proxy/upstream.js";

function extractItemText(item: any, extractInputText: (input: any) => string): string {
  if (!item || typeof item !== "object") return "";
  return extractInputText([item]).trim();
}

function findLastUserItem(input: any): { userIndex: number; userItem: any | null } | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role) === "user") {
      return { userIndex: i, userItem: item };
    }
  }
  return null;
}

export async function startEmbeddedResponsesProxy(
  cfg: any,
  logger: any,
  resolveSessionIdForPayload: ((payload: any) => string | undefined) | undefined,
  helpers: any,
): Promise<{ baseUrl: string; upstream: UpstreamConfig; close: () => Promise<void> } | null> {
  if (!cfg.proxyAutostart) return null;
  let upstream: UpstreamConfig | null = null;
  if (cfg.proxyBaseUrl && cfg.proxyApiKey) {
    const detected = await helpers.detectUpstreamConfig(logger);
    upstream = {
      providerId: detected?.providerId ?? "configured",
      baseUrl: cfg.proxyBaseUrl.replace(/\/+$/, ""),
      apiKey: cfg.proxyApiKey,
      models: detected?.models ?? [],
    };
    logger.info(`[plugin-runtime] proxy using configured upstream: ${upstream.baseUrl}`);
  } else {
    upstream = await helpers.detectUpstreamConfig(logger);
  }
  if (!upstream) {
    logger.warn("[plugin-runtime] no upstream provider discovered; proxy disabled.");
    return null;
  }

  const policyModule = helpers.createPolicyModule(helpers.buildPolicyModuleConfigFromPluginConfig(cfg));
  const reductionPassOptions = cfg.reduction.passOptions ?? {};

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      const model = String(payload?.model ?? "");
      const upstreamModel = helpers.normalizeProxyModelId(model);
      if (upstreamModel && upstreamModel !== model) {
        payload.model = upstreamModel;
      }
      const proxyPureForward = cfg.proxyMode.pureForward;
      const reductionTriggerMinChars = Math.max(256, cfg.reduction.triggerMinChars ?? 2200);
      const reductionMaxToolChars = Math.max(256, cfg.reduction.maxToolChars ?? 1200);
      const resolvedSessionId = String(resolveSessionIdForPayload?.(payload) ?? "proxy-session").trim() || "proxy-session";
      if (!proxyPureForward && cfg.modules.reduction) {
        helpers.injectMemoryFaultProtocolInstructions(payload);
      }
      const instructions = helpers.normalizeText(String(payload?.instructions ?? ""));
      const devAndUser = !proxyPureForward ? helpers.findDeveloperAndPrimaryUser(payload?.input) : null;
      const firstTurnCandidate = Boolean(devAndUser);
      const rootPromptRewrite = devAndUser && !proxyPureForward
        ? helpers.rewriteRootPromptForStablePrefix(devAndUser.developerText)
        : null;
      const developerCanonicalText = helpers.normalizeText(rootPromptRewrite?.canonicalPromptText ?? devAndUser?.developerText ?? "");
      const developerForwardedText = helpers.normalizeText(rootPromptRewrite?.forwardedPromptText ?? devAndUser?.developerText ?? "");
      const originalPromptCacheKey = typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
        ? String(payload.prompt_cache_key)
        : "";
      if (!proxyPureForward && devAndUser && rootPromptRewrite && Array.isArray(payload?.input) && devAndUser.developerIndex >= 0) {
        payload.input[devAndUser.developerIndex] = {
          ...(devAndUser.developerItem ?? payload.input[devAndUser.developerIndex]),
          role: "developer",
          content: rootPromptRewrite.forwardedPromptText,
        };
        if (rootPromptRewrite.dynamicContextText && devAndUser.userIndex >= 0) {
          payload.input[devAndUser.userIndex] = {
            ...(devAndUser.userItem ?? payload.input[devAndUser.userIndex]),
            role: "user",
            content: helpers.prependTextToContent(
              (devAndUser.userItem ?? payload.input[devAndUser.userIndex])?.content,
              rootPromptRewrite.dynamicContextText,
            ),
          };
        }
      }
      const stableRewrite = !proxyPureForward
        ? helpers.rewritePayloadForStablePrefix(payload, model)
        : {
          promptCacheKey: typeof payload?.prompt_cache_key === "string" && payload.prompt_cache_key.trim().length > 0
            ? String(payload.prompt_cache_key)
            : "",
          userContentRewrites: 0,
          senderMetadataBlocksBefore: 0,
          senderMetadataBlocksAfter: 0,
        };
      if (!proxyPureForward && cfg.stateDir) {
        await helpers.appendTaskStateTrace(cfg.stateDir, {
          stage: "stable_prefix_rewrite",
          sessionId: resolvedSessionId,
          model,
          promptCacheKey: stableRewrite.promptCacheKey,
          inputItemCount: Array.isArray(payload?.input) ? payload.input.length : 0,
          inputChars: helpers.estimatePayloadInputChars(payload?.input),
          userContentRewrites: stableRewrite.userContentRewrites,
          senderMetadataBlocksBefore: stableRewrite.senderMetadataBlocksBefore,
          senderMetadataBlocksAfter: stableRewrite.senderMetadataBlocksAfter,
        });
      }
      const beforeReductionInputCount = Array.isArray(payload?.input) ? payload.input.length : 0;
      const beforeReductionInputChars = helpers.estimatePayloadInputChars(payload?.input);
      const reductionApplied = !proxyPureForward && cfg.modules.reduction
        ? await (() => {
          if (cfg.stateDir) {
            void helpers.appendTaskStateTrace(cfg.stateDir, {
              stage: "proxy_reduction_session_resolved",
              resolvedSessionId,
              promptPreview: String(payload?.prompt ?? "").slice(0, 160),
            });
          }
          return helpers.applyProxyReductionToInput(
            payload,
            {
              sessionId: resolvedSessionId,
              logger,
              engine: cfg.reduction.engine,
              triggerMinChars: cfg.reduction.triggerMinChars,
              maxToolChars: cfg.reduction.maxToolChars,
              passToggles: cfg.reduction.passes,
              passOptions: {
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
              beforeCallModules: {
                policy: policyModule,
              },
              cfg,
            },
            {
              applyPolicyBeforeCall: helpers.applyPolicyBeforeCall,
              buildLayeredReductionContext: (
                payload: any,
                triggerMinChars: number,
                sessionId: string,
                passToggles: any,
                passOptions: any,
                segmentAnchorByCallId: any,
                orderedTurnAnchors: any,
              ) => helpers.buildLayeredReductionContext(
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
                segmentAnchorByCallId,
                orderedTurnAnchors,
              ),
              isReductionPassEnabled: helpers.isReductionPassEnabled,
              loadOrderedTurnAnchors: (stateDir: string, sessionId: string) =>
                helpers.loadOrderedTurnAnchors(stateDir, sessionId, helpers.dedupeStrings),
              loadSegmentAnchorByCallId: (stateDir: string, sessionId: string) =>
                helpers.loadSegmentAnchorByCallId(stateDir, sessionId, {
                  dedupeStrings: helpers.dedupeStrings,
                  syncRawSemanticTurnsFromTranscript: async (dir: string, sid: string) => {
                    await helpers.syncRawSemanticTurnsFromTranscript(dir, sid, {
                      contentToText: helpers.contentToText,
                      contextSafeRecovery: helpers.contextSafeRecovery,
                      memoryFaultRecoverToolName: helpers.MEMORY_FAULT_RECOVER_TOOL_NAME,
                    });
                  },
                }),
              makeLogger: helpers.makeLogger,
            },
          );
        })()
        : {
          changedItems: 0,
          changedBlocks: 0,
          savedChars: 0,
          diagnostics: {
            engine: "layered",
            inputItems: Array.isArray(payload?.input) ? payload.input.length : 0,
            toolLikeItems: 0,
            candidateBlocks: 0,
            overThresholdBlocks: 0,
            triggerMinChars: reductionTriggerMinChars,
            maxToolChars: reductionMaxToolChars,
            instructionCount: 0,
            passCount: 0,
            skippedReason: proxyPureForward ? "proxy_pure_forward" : "module_disabled",
          },
        };
      if (cfg.stateDir) {
        await helpers.appendTaskStateTrace(cfg.stateDir, {
          stage: "proxy_before_call_rewrite",
          sessionId: resolvedSessionId,
          model,
          proxyPureForward,
          inputItemCountBefore: beforeReductionInputCount,
          inputItemCountAfter: Array.isArray(payload?.input) ? payload.input.length : 0,
          inputCharsBefore: beforeReductionInputChars,
          inputCharsAfter: helpers.estimatePayloadInputChars(payload?.input),
          reductionChangedItems: reductionApplied.changedItems,
          reductionChangedBlocks: reductionApplied.changedBlocks,
          reductionSavedChars: reductionApplied.savedChars,
          reductionSkippedReason: reductionApplied.diagnostics?.skippedReason ?? null,
          reductionCandidates: reductionApplied.diagnostics?.candidateBlocks ?? 0,
          reductionOverThreshold: reductionApplied.diagnostics?.overThresholdBlocks ?? 0,
        });
      }
      if (!proxyPureForward && cfg.modules.reduction) {
        payload.__ecoclaw_reduction_applied = true;
      }
      helpers.stripInternalPayloadMarkers(payload);
      logger.info(`[plugin-runtime] proxy request model=${model || "unknown"} upstreamModel=${upstreamModel || "unknown"} instrChars=${instructions.length} cacheKey=${stableRewrite.promptCacheKey} userContentRewrites=${stableRewrite.userContentRewrites} senderBlocks=${stableRewrite.senderMetadataBlocksBefore}->${stableRewrite.senderMetadataBlocksAfter} reductionEngine=${proxyPureForward ? "proxy_pure_forward" : cfg.reduction.engine} reductionItems=${reductionApplied.changedItems} reductionBlocks=${reductionApplied.changedBlocks} reductionSavedChars=${reductionApplied.savedChars} reductionCandidates=${reductionApplied.diagnostics?.candidateBlocks ?? 0} reductionOverThreshold=${reductionApplied.diagnostics?.overThresholdBlocks ?? 0} reductionPersistedSkipped=${reductionApplied.diagnostics?.persistedSkippedItems ?? 0} reductionSkipped=${reductionApplied.diagnostics?.skippedReason ?? "none"}`);
      {
        const requestAt = new Date().toISOString();
        const requestId = createHash("sha1").update(JSON.stringify([
          requestAt,
          model,
          upstreamModel,
          stableRewrite.promptCacheKey,
          payload?.previous_response_id ?? "",
          Array.isArray(payload?.input) ? payload.input.length : -1,
        ])).digest("hex").slice(0, 16);
        const proxyLogPath = join(cfg.stateDir, "ecoclaw", "proxy-requests.jsonl");
        const logRecord = {
          at: requestAt,
          requestId,
          stage: "proxy_inbound",
          sessionId: resolvedSessionId,
          model,
          upstreamModel,
          upstreamBaseUrl: upstream.baseUrl,
          instructionsLength: instructions.length,
          instructions: String(payload?.instructions ?? ""),
          inputItemCount: Array.isArray(payload?.input) ? payload.input.length : -1,
          input: payload?.input,
          tools: payload?.tools,
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
      if (cfg.debugTapProviderTraffic) {
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_inbound",
          sessionId: resolvedSessionId,
          model,
          upstreamModel,
          instructionsChars: instructions.length,
          inputChars: helpers.normalizeText(helpers.extractInputText(payload?.input)).length,
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
          payload,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      payload.prompt_cache_retention = "24h";
      let activePayload = payload;
      let upstreamResp: UpstreamHttpResponse | null = null;
      let txt = "";
      let parsedResponseForMirror: any = null;
      let responseContentType = "";
      let memoryFaultAutoReplayCount = 0;
      upstreamResp = await helpers.requestUpstreamResponses(upstream, activePayload, logger, cfg.stateDir);
      const upstreamRespNonNull = upstreamResp!;
      txt = upstreamRespNonNull.text;
      const beforeAfterCallTextChars = txt.length;
      responseContentType = upstreamRespNonNull.headers["content-type"] ?? "";
      try {
        parsedResponseForMirror = JSON.parse(txt);
      } catch {
        parsedResponseForMirror = null;
      }
      const upstreamRespFinal = upstreamRespNonNull;
      let afterCallReduction: any = null;
      if (!proxyPureForward && cfg.modules.reduction && cfg.reduction.engine === "layered") {
        if (parsedResponseForMirror) {
          try {
            afterCallReduction = await helpers.applyLayeredReductionAfterCall(
              activePayload,
              parsedResponseForMirror,
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
              {
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
              },
            );
            if (afterCallReduction.changed) {
              txt = JSON.stringify(parsedResponseForMirror);
            }
            afterCallReduction = { ...afterCallReduction, mode: "json" };
          } catch {
            afterCallReduction = { changed: false, savedChars: 0, passCount: 0, skippedReason: "after_call_error", mode: "json" };
          }
        } else if (helpers.isSseContentType(responseContentType)) {
          try {
            const sseResult = await helpers.applyLayeredReductionAfterCallToSse(
              activePayload,
              txt,
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
              {
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
              },
            );
            txt = sseResult.text;
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
      {
        const parsedResponse = parsedResponseForMirror;
        const responseAt = new Date().toISOString();
        const responseRequestId = createHash("sha1").update(JSON.stringify([
          responseAt,
          model,
          upstreamModel,
          activePayload?.prompt_cache_key ?? "",
          parsedResponse?.id ?? "",
          upstreamRespFinal.status,
        ])).digest("hex").slice(0, 16);
        const proxyRespLogPath = join(cfg.stateDir, "ecoclaw", "proxy-responses.jsonl");
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
          responseId: parsedResponse?.id ?? null,
          previousResponseId: parsedResponse?.previous_response_id ?? null,
          responsePromptCacheKey: parsedResponse?.prompt_cache_key ?? null,
          responsePromptCacheRetention: parsedResponse?.prompt_cache_retention ?? null,
          usage: parsedResponse?.usage ?? null,
          afterCallReduction: afterCallReduction ?? null,
          memoryFaultAutoReplayCount,
        };
        await mkdir(dirname(proxyRespLogPath), { recursive: true });
        await appendFile(proxyRespLogPath, `${JSON.stringify(respRecord)}\n`, "utf8");
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
            responseId: parsedResponse?.id ?? "",
            responseReductionChanged: Boolean(afterCallReduction?.changed),
            responseReductionSavedChars: Number(afterCallReduction?.savedChars ?? 0),
            memoryFaultAutoReplayCount,
          },
        });
      }
      {
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
      }
      if (cfg.debugTapProviderTraffic) {
        let parsedResponse: any = null;
        try {
          parsedResponse = JSON.parse(txt);
        } catch {}
        const debugRecord = {
          at: new Date().toISOString(),
          stage: "proxy_outbound",
          model,
          upstreamModel,
          status: upstreamRespFinal.status,
          transport: upstreamRespFinal.transport,
          responseId: typeof parsedResponse?.id === "string" ? parsedResponse.id : typeof parsedResponse?.response?.id === "string" ? parsedResponse.response.id : null,
          previousResponseId: typeof parsedResponse?.previous_response_id === "string" ? parsedResponse.previous_response_id : typeof parsedResponse?.response?.previous_response_id === "string" ? parsedResponse.response.previous_response_id : null,
          promptCacheKey: typeof parsedResponse?.prompt_cache_key === "string" ? parsedResponse.prompt_cache_key : typeof parsedResponse?.response?.prompt_cache_key === "string" ? parsedResponse.response.prompt_cache_key : null,
          promptCacheRetention: typeof parsedResponse?.prompt_cache_retention === "string" ? parsedResponse.prompt_cache_retention : typeof parsedResponse?.response?.prompt_cache_retention === "string" ? parsedResponse.response.prompt_cache_retention : null,
          usage: parsedResponse?.usage ?? parsedResponse?.response?.usage ?? null,
          afterCallReduction,
          responseText: txt,
          memoryFaultAutoReplayCount,
        };
        await mkdir(dirname(cfg.debugTapPath), { recursive: true });
        await appendFile(cfg.debugTapPath, `${JSON.stringify(debugRecord)}\n`, "utf8");
      }
      res.statusCode = upstreamRespFinal.status;
      res.setHeader("content-type", upstreamRespFinal.headers["content-type"] ?? "application/json");
      res.end(txt);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.proxyPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${cfg.proxyPort}/v1`;
  logger.info(`[plugin-runtime] embedded responses proxy listening at ${baseUrl}`);
  return {
    baseUrl,
    upstream,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
