/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir } from "node:fs/promises";
import {
  buildGatewayForwardHeaders,
  countTextWithPreciseTokens,
  createSseJsonStreamObserver,
  createStaticStatePathResolver,
  forwardGatewayRequest,
  type HostGatewayForwarder,
  type HostGatewayStreamObserver,
  recordUxEffect,
  sendJsonResponse,
  startHostGatewayRuntimeServer,
  setForwardResponseHeaders,
} from "@tokenpilot/host-adapter";
import {
  prepareObservedBeforeCall,
} from "@tokenpilot/product-surface";
import { configureStatePathResolver } from "@tokenpilot/artifact-store";
import type { TokenPilotClaudeCodeConfig } from "./config.js";
import { proxyBaseUrlForPort } from "./config.js";
import type { TokenPilotClaudeCodeLogger } from "./logger.js";
import { createClaudeMessagesPayloadCodec } from "./messages-codec.js";
import { reduceClaudeRequestEnvelope, type ClaudeReductionSummary } from "./reduction.js";
import {
  appendClaudeCodeRecentTurnBinding,
  upsertClaudeCodeSessionSnapshot,
} from "./session-state.js";
import { prepareClaudeStablePrefix } from "./stable-prefix.js";
import {
  buildStabilityVisualSnapshotFromEnvelopes,
  canonicalizeEnvelopeTools,
} from "@tokenpilot/stabilizer";
import { appendClaudeCodeTrace } from "./trace.js";
import { createClaudeCodeGatewayForwarder, resolveClaudeCodeUpstream } from "./upstream.js";
import { appendClaudeCodeCacheAuditRecord, buildClaudeCodeCacheAuditSnapshot } from "./cache-audit.js";
import { buildAnthropicGatewayModelList, mapClaudeVisibleModelToUpstreamModel } from "./provider-profile.js";
import { resolveLatestClaudeCodeSessionId } from "./session-state.js";
import { initializeClaudeCodeTokenPilotPreset } from "./preset.js";

export type ClaudeCodeGatewayRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

function isSyntheticClaudeSessionId(sessionId: string): boolean {
  return sessionId.startsWith("claude-synth-");
}

async function resolveObservedClaudeSessionId(stateDir: string, sessionId: string): Promise<string> {
  if (!isSyntheticClaudeSessionId(sessionId)) {
    return sessionId;
  }
  const latestSessionId = await resolveLatestClaudeCodeSessionId(stateDir);
  if (latestSessionId && !isSyntheticClaudeSessionId(latestSessionId)) {
    return latestSessionId;
  }
  return sessionId;
}

function normalizeRequestHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(headers));
}

function countAnthropicMessagePayloadText(payload: unknown): string {
  const root = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const system = typeof root.system === "string" ? root.system : "";
  const messagesText = Array.isArray(root.messages)
    ? root.messages
      .map((message) => {
        const item = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : {};
        const content = item.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((block) => {
            const entry = block && typeof block === "object" && !Array.isArray(block)
              ? block as Record<string, unknown>
              : {};
            if (typeof entry.text === "string") return entry.text;
            if (typeof entry.content === "string") return entry.content;
            if (typeof entry.input === "string") return entry.input;
            if (typeof entry.output === "string") return entry.output;
            return "";
          })
          .filter(Boolean)
          .join("\n");
      })
      .filter(Boolean)
      .join("\n")
    : "";
  return [system, messagesText].filter(Boolean).join("\n");
}

async function recordClaudeRequestReductionUx(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  originalRequestText: string;
  reducedRequestText: string;
}): Promise<void> {
  const beforeCount = countTextWithPreciseTokens(params.model, params.originalRequestText);
  const afterCount = countTextWithPreciseTokens(params.model, params.reducedRequestText);
  const countMode = beforeCount.mode === "openai_tokens" && afterCount.mode === "openai_tokens"
    ? "openai_tokens"
    : "chars";
  const savedCount = countMode === "chars"
    ? Math.max(0, params.originalRequestText.length - params.reducedRequestText.length)
    : Math.max(0, beforeCount.count - afterCount.count);
  if (savedCount <= 0) return;
  await recordUxEffect(params.stateDir, {
    at: new Date().toISOString(),
    sessionId: params.sessionId,
    model: params.model,
    countMode,
    beforeCount: countMode === "chars" ? params.originalRequestText.length : beforeCount.count,
    afterCount: countMode === "chars" ? params.reducedRequestText.length : afterCount.count,
    savedCount,
    details: {
      requestSavedCount: savedCount,
    },
  });
}

function extractWorkspaceHint(envelope: {
  instructions?: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadataHint = typeof envelope.metadata?.workspaceHint === "string"
    ? envelope.metadata.workspaceHint.trim()
    : "";
  if (metadataHint) return metadataHint;
  const instructions = typeof envelope.instructions === "string" ? envelope.instructions : "";
  const match = instructions.match(/Your working directory is:\s*(.+)/);
  const raw = match?.[1]?.trim() ?? "";
  return raw && raw !== "<WORKDIR>" ? raw : undefined;
}

async function recordClaudeGatewayTurn(params: {
  stateDir: string;
  sessionId: string;
  model: string;
  responseId?: string;
  previousResponseId?: string;
  disclosedReadPaths?: string[];
  requestChars: number;
  responseChars: number;
  assistantChars: number;
  reductionSavedChars: number;
  stablePrefixApplied: boolean;
  reductionApplied: boolean;
  stream: boolean;
  workspaceHint?: string;
}): Promise<void> {
  const updatedAt = new Date().toISOString();
  await upsertClaudeCodeSessionSnapshot(params.stateDir, params.sessionId, {
    latestResponseId: params.responseId,
    previousResponseId: params.previousResponseId,
    latestModel: params.model,
    workspaceHint: params.workspaceHint,
    disclosedReadPaths: params.disclosedReadPaths,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
  });
  await appendClaudeCodeRecentTurnBinding(params.stateDir, {
    sessionId: params.sessionId,
    responseId: params.responseId,
    previousResponseId: params.previousResponseId,
    model: params.model,
    requestChars: params.requestChars,
    responseChars: params.responseChars,
    assistantChars: params.assistantChars,
    reductionSavedChars: params.reductionSavedChars,
    stablePrefixApplied: params.stablePrefixApplied,
    reductionApplied: params.reductionApplied,
    stream: params.stream,
    updatedAt,
  });
}

export async function startClaudeCodeGatewayRuntime(params: {
  config: TokenPilotClaudeCodeConfig;
  logger: TokenPilotClaudeCodeLogger;
  forwarder?: HostGatewayForwarder;
  streamObserver?: HostGatewayStreamObserver;
}): Promise<ClaudeCodeGatewayRuntime> {
  initializeClaudeCodeTokenPilotPreset();
  const { config, logger } = params;
  if (!config.enabled) {
    throw new Error("TokenPilot Claude Code adapter is disabled by config");
  }

  configureStatePathResolver(createStaticStatePathResolver({
    hostId: "claude-code",
    displayName: "Claude Code",
    stateDir: config.stateDir,
    namespaceDir: "tokenpilot",
  }));

  await mkdir(config.stateDir, { recursive: true });
  const upstream = resolveClaudeCodeUpstream(config);
  const codec = createClaudeMessagesPayloadCodec();
  const forwarder = params.forwarder ?? createClaudeCodeGatewayForwarder(config);
  const streamObserver = params.streamObserver ?? createSseJsonStreamObserver({
    responseIdPaths: [["message", "id"], ["id"]],
    usagePaths: [["usage"]],
  });

  const runtime = await startHostGatewayRuntimeServer({
    port: config.proxyPort,
    requestPath: "/v1/messages",
    basePath: "/v1",
    healthPayload: {
      ok: true,
      adapter: "tokenpilot-claude-code",
      upstream: upstream.baseUrl,
      stateDir: config.stateDir,
    },
    async handleRoute({ req, res, pathname, readBody }) {
      const inboundHeaders = normalizeRequestHeaders(req.headers);
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;

      if (req.method === "GET" && pathname === "/v1/models") {
        const upstreamResp = await forwardGatewayRequest({
          upstream,
          method: "GET",
          requestPath: "/v1/models",
          inboundAuthorization: authorization,
          inboundHeaders,
        });
        if (upstreamResp.status === 404) {
          sendJsonResponse(res, 200, buildAnthropicGatewayModelList(config));
          return true;
        }
        const text = await upstreamResp.text();
        setForwardResponseHeaders(res, Object.fromEntries(upstreamResp.headers.entries()), "application/json; charset=utf-8");
        res.statusCode = upstreamResp.status;
        res.end(text);
        return true;
      }

      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        const body = await readBody();
        const payload = JSON.parse(body);
        const upstreamPayload = {
          ...payload,
          model: typeof payload?.model === "string"
            ? mapClaudeVisibleModelToUpstreamModel(config, payload.model)
            : payload?.model,
        };
        const upstreamResp = await forwardGatewayRequest({
          upstream,
          method: "POST",
          requestPath: "/v1/messages/count_tokens",
          payload: upstreamPayload,
          inboundAuthorization: authorization,
          inboundHeaders,
        });

        if (upstreamResp.status !== 404) {
          const text = await upstreamResp.text();
          setForwardResponseHeaders(res, Object.fromEntries(upstreamResp.headers.entries()), "application/json; charset=utf-8");
          res.statusCode = upstreamResp.status;
          res.end(text);
          return true;
        }

        const countText = countAnthropicMessagePayloadText(payload);
        const model = typeof payload?.model === "string" && payload.model.trim()
          ? payload.model
          : "claude-sonnet-4-6";
        const tokenCount = countTextWithPreciseTokens(model, countText);
        sendJsonResponse(res, 200, {
          input_tokens: tokenCount.count,
        });
        return true;
      }

      return false;
    },
    async handleRequest({ req, res, body }) {
      let payload = JSON.parse(body);
      let envelope = codec.decodeRequest(payload, {
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      const originalRequestText = typeof envelope.metadata?.inputText === "string"
        ? envelope.metadata.inputText
        : "";
      if (envelope.model.startsWith("tokenpilot/")) {
        envelope = {
          ...envelope,
          model: envelope.model.slice("tokenpilot/".length),
        };
      }
      envelope = {
        ...envelope,
        model: mapClaudeVisibleModelToUpstreamModel(config, envelope.model),
      };
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const sessionId = await resolveObservedClaudeSessionId(config.stateDir, envelope.session.sessionId);
      const model = envelope.model;
      const workspaceHint = extractWorkspaceHint(envelope);
      const prepared = await prepareObservedBeforeCall<ClaudeReductionSummary>({
        envelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix(nextEnvelope) {
          return prepareClaudeStablePrefix(canonicalizeEnvelopeTools(nextEnvelope), config);
        },
        async applyBeforeCallReduction({ envelope: nextEnvelope, codec: nextCodec }) {
          return reduceClaudeRequestEnvelope({
            envelope: nextEnvelope,
            codec: nextCodec,
            config,
          });
        },
        observability: {
          stateDir: config.stateDir,
          sessionId,
          model,
          recordUxEffectNow: false,
          buildStability({ originalEnvelope, prepared }) {
            return prepared.diagnostics.stablePrefixApplied === true
              ? buildStabilityVisualSnapshotFromEnvelopes({
                sessionId,
                model,
                upstreamModel: model,
                originalEnvelope,
                preparedEnvelope: prepared.envelope,
                dynamicContextTarget: config.hooks.dynamicContextTarget,
                getDeveloperText(envelope) {
                  return typeof envelope.instructions === "string" ? envelope.instructions : "";
                },
              })
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
                segments: (reductionSummary.visualSegments ?? []).map((segment) => ({
                  segmentId: segment.segmentId,
                  itemIndex: segment.messageIndex,
                  field: segment.field === "text" ? "content" : segment.field,
                  blockIndex: segment.blockIndex,
                  toolName: segment.toolName,
                  savedChars: segment.savedChars,
                  beforeText: segment.beforeText,
                  afterText: segment.afterText,
                  report: segment.report,
                })),
              }
              : undefined;
          },
        },
      });
      const reductionSummary = prepared.reductionSummary;
      payload = codec.encodeRequest(prepared.envelope);
      const reducedRequestText = typeof prepared.envelope.metadata?.inputText === "string"
        ? prepared.envelope.metadata.inputText
        : "";
      const cacheAuditSnapshot = buildClaudeCodeCacheAuditSnapshot({
        envelope: prepared.envelope,
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        originalRequestPromptCacheKey:
          typeof prepared.envelope.metadata?.originalPromptCacheKey === "string"
            ? prepared.envelope.metadata.originalPromptCacheKey
            : null,
        requestPromptCacheKey:
          typeof prepared.envelope.metadata?.frameworkStablePromptCacheKey === "string"
            ? prepared.envelope.metadata.frameworkStablePromptCacheKey
            : typeof prepared.envelope.metadata?.promptCacheKey === "string"
              ? prepared.envelope.metadata.promptCacheKey
            : null,
      });

      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_before_call",
        sessionId,
        model: prepared.envelope.model,
        stream: prepared.envelope.stream,
        requestChars: body.length,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        reductionChangedBlocks: reductionSummary?.changedBlocks ?? 0,
        reductionChangedMessages: reductionSummary?.changedMessages ?? 0,
        reductionSkippedReason: reductionSummary?.skippedReason ?? null,
        reductionPassEffects: reductionSummary?.passEffects ?? [],
      });

      if (prepared.envelope.stream) {
        const upstreamResp = await forwarder.requestStream({
          upstream,
          payload,
          inboundAuthorization: authorization,
          inboundHeaders: normalizeRequestHeaders(req.headers),
        });
        res.statusCode = upstreamResp.status;
        setForwardResponseHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        const chunks: Buffer[] = [];
        upstreamResp.stream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          chunks.push(buffer);
          res.write(buffer);
        });
        upstreamResp.stream.once("end", async () => {
          const rawStreamText = Buffer.concat(chunks).toString("utf8");
          const snapshot = streamObserver.snapshot(rawStreamText);
          const responseId = typeof snapshot.metadata?.responseId === "string" ? snapshot.metadata.responseId : undefined;
          const previousResponseId =
            typeof snapshot.metadata?.previousResponseId === "string" ? snapshot.metadata.previousResponseId : undefined;
          await recordClaudeRequestReductionUx({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            originalRequestText,
            reducedRequestText,
          });
          await appendClaudeCodeCacheAuditRecord({
            stateDir: config.stateDir,
            snapshot: cacheAuditSnapshot,
            responsePromptCacheKey: null,
            usage: snapshot.usage ?? null,
            status: upstreamResp.status,
          });
          await appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            assistantChars: snapshot.assistantText.length,
            responseChars: rawStreamText.length,
          });
          await recordClaudeGatewayTurn({
            stateDir: config.stateDir,
            sessionId,
            model: prepared.envelope.model,
            responseId,
            previousResponseId,
            disclosedReadPaths: reductionSummary?.disclosedReadPaths,
            requestChars: body.length,
            responseChars: rawStreamText.length,
            assistantChars: snapshot.assistantText.length,
            reductionSavedChars: reductionSummary?.savedChars ?? 0,
            stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
            reductionApplied: prepared.diagnostics.reductionApplied === true,
            stream: true,
            workspaceHint,
          });
          res.end();
        });
        upstreamResp.stream.once("error", (error) => {
          logger.error(error instanceof Error ? error.message : String(error));
          void appendClaudeCodeTrace(config.stateDir, {
            stage: "gateway_after_call",
            sessionId,
            model: prepared.envelope.model,
            stream: true,
            status: upstreamResp.status,
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.destroyed) {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        return;
      }

      const upstreamResp = await forwarder.request({
        upstream,
        payload,
        inboundAuthorization: authorization,
        inboundHeaders: normalizeRequestHeaders(req.headers),
      });
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.statusCode = upstreamResp.status;
      let assistantChars = 0;
      let responseId: string | undefined;
      let previousResponseId: string | undefined;
      let responsePromptCacheKey: string | undefined;
      let decodedUsage: Record<string, unknown> | null = null;
      try {
        const decoded = codec.decodeResponse(JSON.parse(upstreamResp.text), prepared.envelope);
        assistantChars = decoded.assistantText?.length ?? 0;
        responseId = typeof decoded.metadata?.responseId === "string" ? decoded.metadata.responseId : undefined;
        previousResponseId =
          typeof decoded.metadata?.previousResponseId === "string" ? decoded.metadata.previousResponseId : undefined;
        responsePromptCacheKey =
          typeof decoded.metadata?.promptCacheKey === "string" ? decoded.metadata.promptCacheKey : undefined;
        decodedUsage = decoded.usage ?? null;
      } catch {
        assistantChars = 0;
      }
      await recordClaudeRequestReductionUx({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        originalRequestText,
        reducedRequestText,
      });
      await appendClaudeCodeCacheAuditRecord({
        stateDir: config.stateDir,
        snapshot: cacheAuditSnapshot,
        responsePromptCacheKey,
        usage: decodedUsage,
        status: upstreamResp.status,
      });
      await appendClaudeCodeTrace(config.stateDir, {
        stage: "gateway_after_call",
        sessionId,
        model: prepared.envelope.model,
        stream: false,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
        assistantChars,
      });
      await recordClaudeGatewayTurn({
        stateDir: config.stateDir,
        sessionId,
        model: prepared.envelope.model,
        responseId,
        previousResponseId,
        disclosedReadPaths: reductionSummary?.disclosedReadPaths,
        requestChars: body.length,
        responseChars: upstreamResp.text.length,
        assistantChars,
        reductionSavedChars: reductionSummary?.savedChars ?? 0,
        stablePrefixApplied: prepared.diagnostics.stablePrefixApplied === true,
        reductionApplied: prepared.diagnostics.reductionApplied === true,
        stream: false,
        workspaceHint,
      });
      res.end(upstreamResp.text);
    },
    async handleError({ error, res }) {
      logger.error(error instanceof Error ? error.message : String(error));
      sendJsonResponse(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return {
    baseUrl: proxyBaseUrlForPort(config.proxyPort),
    close: runtime.close,
  };
}
