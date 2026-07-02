/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdir } from "node:fs/promises";
import {
  createSseJsonStreamObserver,
  createStaticStatePathResolver,
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
import { configureStatePathResolver } from "@tokenpilot/runtime-core";
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
import { appendClaudeCodeTrace } from "./trace.js";
import { defaultClaudeCodeGatewayForwarder, resolveClaudeCodeUpstream } from "./upstream.js";

export type ClaudeCodeGatewayRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

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
  if (params.reductionSavedChars > 0) {
    await recordUxEffect(params.stateDir, {
      at: updatedAt,
      sessionId: params.sessionId,
      model: params.model,
      countMode: "chars",
      beforeCount: params.requestChars,
      afterCount: Math.max(0, params.requestChars - params.reductionSavedChars),
      savedCount: params.reductionSavedChars,
      details: {
        requestSavedCount: params.reductionSavedChars,
      },
    });
  }
}

export async function startClaudeCodeGatewayRuntime(params: {
  config: TokenPilotClaudeCodeConfig;
  logger: TokenPilotClaudeCodeLogger;
  forwarder?: HostGatewayForwarder;
  streamObserver?: HostGatewayStreamObserver;
}): Promise<ClaudeCodeGatewayRuntime> {
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
  const forwarder = params.forwarder ?? defaultClaudeCodeGatewayForwarder;
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
    async handleRequest({ req, res, body }) {
      let payload = JSON.parse(body);
      let envelope = codec.decodeRequest(payload, {
        headers: req.headers as Record<string, string | string[] | undefined>,
      });
      if (envelope.model.startsWith("tokenpilot/")) {
        envelope = {
          ...envelope,
          model: envelope.model.slice("tokenpilot/".length),
        };
      }
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const sessionId = envelope.session.sessionId;
      const model = envelope.model;
      const workspaceHint = extractWorkspaceHint(envelope);
      const prepared = await prepareObservedBeforeCall<ClaudeReductionSummary>({
        envelope,
        codec,
        config: { mode: "normal" },
        prepareStablePrefix(nextEnvelope) {
          return prepareClaudeStablePrefix(nextEnvelope, config);
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
              ? {
                originalEnvelope,
                dynamicContextTarget: "user",
                getDeveloperText(envelope) {
                  return typeof envelope.instructions === "string" ? envelope.instructions : "";
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
      });
      setForwardResponseHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.statusCode = upstreamResp.status;
      let assistantChars = 0;
      let responseId: string | undefined;
      let previousResponseId: string | undefined;
      try {
        const decoded = codec.decodeResponse(JSON.parse(upstreamResp.text), prepared.envelope);
        assistantChars = decoded.assistantText?.length ?? 0;
        responseId = typeof decoded.metadata?.responseId === "string" ? decoded.metadata.responseId : undefined;
        previousResponseId =
          typeof decoded.metadata?.previousResponseId === "string" ? decoded.metadata.previousResponseId : undefined;
      } catch {
        assistantChars = 0;
      }
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
