/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import {
  findFirstMessageText,
  prepareObservedBeforeCall,
} from "@tokenpilot/product-surface";
import {
  createStaticStatePathResolver,
  sendJsonResponse,
  startHostGatewayRuntimeServer,
  setForwardResponseHeaders,
} from "@tokenpilot/host-adapter";
import { configureStatePathResolver } from "@tokenpilot/runtime-core";
import type { TokenPilotCodexConfig } from "./config.js";
import {
  defaultCodexConfigPath,
  resolveUpstreamProvider,
} from "./config.js";
import type { TokenPilotCodexLogger } from "./logger.js";
import {
  createCodexSessionResolver,
  createCodexResponsesPayloadCodec,
  extractResponsesInputText,
  syncPayloadFromEnvelope,
} from "./responses-codec.js";
import {
  type CodexReductionSummary,
  reduceCodexRequestEnvelope,
} from "./reduction.js";
import { prepareCodexStablePrefix } from "./stable-prefix.js";
import {
  requestUpstreamResponses,
  requestUpstreamResponsesStream,
} from "./upstream.js";
import {
  appendCodexRecentTurnBinding,
  indexCodexHostSessionAlias,
  indexCodexPromptCacheKeySession,
  indexCodexResponseSession,
  mergeCodexSessionSnapshot,
  resolveCodexSessionIdByPromptCacheKey,
  resolveCodexSessionIdByResponseId,
  upsertCodexSessionSnapshot,
} from "./session-state.js";
import { snapshotCodexResponsesStream } from "./stream-observer.js";
import { appendTrace } from "./trace.js";

export type CodexProxyRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

function normalizeResponsesInputForUpstream(input: any): void {
  if (!Array.isArray(input)) return;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    if (type === "function_call" && typeof item.arguments !== "string" && item.arguments != null) {
      item.arguments = JSON.stringify(item.arguments);
    }
    if (type === "function_call_output" && typeof item.output !== "string" && item.output != null) {
      item.output = JSON.stringify(item.output);
    }
  }
}

export async function startCodexResponsesProxy(params: {
  config: TokenPilotCodexConfig;
  logger: TokenPilotCodexLogger;
  codexConfigPath?: string;
}): Promise<CodexProxyRuntime> {
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Codex adapter is disabled by config");
  }
  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "codex",
    displayName: "Codex",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));
  await mkdir(config.stateDir, { recursive: true });
  const upstream = await resolveUpstreamProvider(config, params.codexConfigPath ?? defaultCodexConfigPath());
  const runtime = await startHostGatewayRuntimeServer({
    port: config.proxyPort,
    requestPath: "/v1/responses",
    basePath: "/v1",
    healthPayload: {
      ok: true,
      adapter: "tokenpilot-codex",
      upstream: upstream.name ?? config.upstreamProvider ?? "OpenAI",
      stateDir: config.stateDir,
    },
    async handleRequest({ req, res, body }) {
      const payload = JSON.parse(body);
      normalizeResponsesInputForUpstream(payload?.input);
      const inboundPromptCacheKey =
        typeof payload?.prompt_cache_key === "string" ? payload.prompt_cache_key.trim() : "";
      const mappedPreviousSessionId =
        typeof payload?.previous_response_id === "string"
          ? await resolveCodexSessionIdByResponseId(config.stateDir, payload.previous_response_id)
          : undefined;
      const mappedPromptCacheSessionId =
        !mappedPreviousSessionId && inboundPromptCacheKey
          ? await resolveCodexSessionIdByPromptCacheKey(config.stateDir, inboundPromptCacheKey)
          : undefined;
      const codec = createCodexResponsesPayloadCodec(
        createCodexSessionResolver({
          mappedPreviousSessionId: mappedPreviousSessionId ?? mappedPromptCacheSessionId,
        }),
      );
      let envelope = codec.decodeRequest(payload);
      const inboundModel = envelope.model;
      const model = inboundModel.startsWith("tokenpilot/")
        ? inboundModel.slice("tokenpilot/".length)
        : inboundModel;
      if (model !== inboundModel) {
        envelope = { ...envelope, model };
        syncPayloadFromEnvelope(payload, envelope, codec);
      }
      const sessionId = envelope.session.sessionId;
      if (inboundPromptCacheKey) {
        if (
          inboundPromptCacheKey !== sessionId
          && !inboundPromptCacheKey.startsWith("lightmem2-codex-")
        ) {
          await mergeCodexSessionSnapshot(config.stateDir, inboundPromptCacheKey, sessionId);
          await indexCodexHostSessionAlias(config.stateDir, inboundPromptCacheKey, sessionId);
        }
        await indexCodexPromptCacheKeySession(config.stateDir, inboundPromptCacheKey, sessionId);
      }
      const prepared = await prepareObservedBeforeCall<CodexReductionSummary>({
        envelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix(nextEnvelope) {
          return prepareCodexStablePrefix(nextEnvelope, config);
        },
        async applyBeforeCallReduction({ envelope: nextEnvelope, codec: nextCodec }) {
          return reduceCodexRequestEnvelope({
            envelope: nextEnvelope,
            codec: nextCodec,
            config,
          });
        },
        observability: {
          stateDir: config.stateDir,
          sessionId,
          model,
          buildStability({ originalEnvelope, prepared }) {
            return prepared.diagnostics.stablePrefixApplied === true
              ? {
                originalEnvelope,
                dynamicContextTarget: config.hooks.dynamicContextTarget,
                getDeveloperText(envelope) {
                  return findFirstMessageText(envelope, (message: any) => {
                    if (!message || typeof message !== "object" || message.role !== "system") return false;
                    const originalRole = message.metadata?.__codexOriginalRole;
                    return originalRole === "developer" || originalRole === "system";
                  });
                },
              }
              : undefined;
          },
          buildReduction(reductionSummary) {
            return reductionSummary.savedChars > 0
              ? {
                countMode: "chars",
                beforeCount: reductionSummary.beforeChars,
                afterCount: reductionSummary.afterChars,
                savedCount: reductionSummary.savedChars,
                details: {
                  requestSavedCount: reductionSummary.savedChars,
                },
                segments: reductionSummary.visualSegments ?? [],
              }
              : undefined;
          },
        },
      });
      const reductionSummary = prepared.reductionSummary;
      syncPayloadFromEnvelope(payload, prepared.envelope, codec);
      normalizeResponsesInputForUpstream(payload?.input);
      const requestText = extractResponsesInputText(payload?.input);

      await appendTrace(config.stateDir, {
        stage: "proxy_before_call",
        sessionId,
        model,
        stream: payload.stream === true,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        recoveryInjected: prepared.diagnostics.recoveryInjected === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedItems: reductionSummary?.changedItems ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
        promptCacheKey: prepared.envelope.metadata?.promptCacheKey ?? null,
      });

      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      if (payload.stream === true) {
        const upstreamResp = await requestUpstreamResponsesStream({ upstream, payload, inboundAuthorization: authorization });
        res.statusCode = upstreamResp.status;
        setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const streamChunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          streamChunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(streamChunks).toString("utf8");
          const snapshot = snapshotCodexResponsesStream(rawStreamText);
          try {
            await appendTrace(config.stateDir, {
              stage: "proxy_after_call",
              sessionId,
              model,
              status: upstreamResp.status,
              stream: true,
              completed: true,
              responseChars: rawStreamText.length,
              assistantChars: snapshot.assistantText.length,
              responseId: snapshot.responseId ?? null,
              previousResponseId: snapshot.previousResponseId ?? null,
            });
            await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
              latestResponseId: snapshot.responseId,
              previousResponseId: snapshot.previousResponseId,
              latestModel: model,
            });
            if (typeof snapshot.responseId === "string" && snapshot.responseId) {
              await indexCodexResponseSession(config.stateDir, snapshot.responseId, sessionId);
            }
            await appendCodexRecentTurnBinding(config.stateDir, {
              sessionId,
              responseId: snapshot.responseId,
              previousResponseId: snapshot.previousResponseId,
              model,
              requestChars: requestText.length,
              responseChars: rawStreamText.length,
              assistantChars: snapshot.assistantText.length,
              stream: true,
              updatedAt: new Date().toISOString(),
            });
            res.end();
          } catch (err) {
            void appendTrace(config.stateDir, {
              stage: "proxy_after_call",
              sessionId,
              model,
              status: upstreamResp.status,
              stream: true,
              completed: false,
              error: err instanceof Error ? err.message : String(err),
            });
            if (!res.destroyed) {
              res.destroy(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
        upstreamResp.stream.once("error", (err) => {
          void appendTrace(config.stateDir, {
            stage: "proxy_after_call",
            sessionId,
            model,
            status: upstreamResp.status,
            stream: true,
            completed: false,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!res.destroyed) {
            res.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        });
        return;
      }

      const upstreamResp = await requestUpstreamResponses({ upstream, payload, inboundAuthorization: authorization });
      let responseId: string | undefined;
      let previousResponseId: string | undefined;
      let assistantChars = 0;
      let toolCallCount = 0;
      try {
        const decoded = codec.decodeResponse(JSON.parse(upstreamResp.text), prepared.envelope);
        responseId = typeof decoded.metadata?.responseId === "string" ? decoded.metadata.responseId : undefined;
        previousResponseId = typeof decoded.metadata?.previousResponseId === "string" ? decoded.metadata.previousResponseId : undefined;
        assistantChars = decoded.assistantText?.length ?? 0;
        toolCallCount = decoded.toolCalls?.length ?? 0;
      } catch {
        // Some upstream error payloads may not match the expected Responses shape.
      }
      await upsertCodexSessionSnapshot(config.stateDir, sessionId, {
        latestResponseId: responseId,
        previousResponseId,
        latestModel: model,
      });
      if (typeof responseId === "string" && responseId) {
        await indexCodexResponseSession(config.stateDir, responseId, sessionId);
      }
      await appendCodexRecentTurnBinding(config.stateDir, {
        sessionId,
        responseId,
        previousResponseId,
        model,
        requestChars: requestText.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        toolCallCount,
        stream: false,
        updatedAt: new Date().toISOString(),
      });
      await appendTrace(config.stateDir, {
        stage: "proxy_after_call",
        sessionId,
        model,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
        responseId: responseId ?? null,
        previousResponseId: previousResponseId ?? null,
      });
      res.statusCode = upstreamResp.status;
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.end(upstreamResp.text);
    },
    async handleError({ error, res }) {
      const err = error;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      sendJsonResponse(res, 500, { error: message });
    },
  });

  const baseUrl = runtime.baseUrl;
  logger.info(`proxy listening at ${baseUrl}; upstream=${upstream.baseUrl}`);
  return {
    baseUrl,
    close: runtime.close,
  };
}
