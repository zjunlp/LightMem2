/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { mkdir } from "node:fs/promises";
import { prepareBeforeCall } from "@tokenpilot/host-adapter";
import type { TokenPilotCodexConfig } from "./config.js";
import {
  defaultCodexConfigPath,
  resolveUpstreamProvider,
} from "./config.js";
import type { TokenPilotCodexLogger } from "./logger.js";
import {
  createCodexResponsesPayloadCodec,
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
import { appendTrace } from "./trace.js";
import { recordCodexUxEffect } from "./ux-effects.js";

export type CodexProxyRuntime = {
  baseUrl: string;
  close(): Promise<void>;
};

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function setForwardHeaders(res: ServerResponse, headers: Record<string, string>, fallbackContentType: string): void {
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "content-encoding") continue;
    if (typeof value === "string" && value) res.setHeader(key, value);
  }
  if (!res.hasHeader("content-type")) res.setHeader("content-type", fallbackContentType);
}

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
  await mkdir(config.stateDir, { recursive: true });
  const upstream = await resolveUpstreamProvider(config, params.codexConfigPath ?? defaultCodexConfigPath());
  const codec = createCodexResponsesPayloadCodec();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, {
          ok: true,
          adapter: "tokenpilot-codex",
          upstream: upstream.name ?? config.upstreamProvider ?? "OpenAI",
          stateDir: config.stateDir,
        });
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const body = await readRequestBody(req);
      const payload = JSON.parse(body);
      normalizeResponsesInputForUpstream(payload?.input);
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
      let reductionSummary: CodexReductionSummary | undefined;
      const prepared = await prepareBeforeCall({
        envelope,
        config: { mode: "normal" },
        helpers: {
          prepareStablePrefix(nextEnvelope) {
            return prepareCodexStablePrefix(nextEnvelope, config);
          },
          async applyBeforeCallReduction(nextEnvelope) {
            const reduced = await reduceCodexRequestEnvelope({
              envelope: nextEnvelope,
              codec,
              config,
            });
            reductionSummary = reduced.summary;
            return reduced.envelope;
          },
        },
      });
      syncPayloadFromEnvelope(payload, prepared.envelope, codec);

      if (reductionSummary && reductionSummary.savedChars > 0) {
        await recordCodexUxEffect(config.stateDir, {
          at: new Date().toISOString(),
          sessionId,
          model,
          countMode: "chars",
          beforeCount: reductionSummary.beforeChars,
          afterCount: reductionSummary.afterChars,
          savedCount: reductionSummary.savedChars,
          details: {
            requestSavedCount: reductionSummary.savedChars,
          },
        });
      }

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
        setForwardHeaders(res, upstreamResp.headers, "text/event-stream; charset=utf-8");
        upstreamResp.stream.once("end", () => {
          void appendTrace(config.stateDir, {
            stage: "proxy_after_call",
            sessionId,
            model,
            status: upstreamResp.status,
            stream: true,
            completed: true,
          });
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
        });
        upstreamResp.stream.pipe(res);
        return;
      }

      const upstreamResp = await requestUpstreamResponses({ upstream, payload, inboundAuthorization: authorization });
      await appendTrace(config.stateDir, {
        stage: "proxy_after_call",
        sessionId,
        model,
        status: upstreamResp.status,
        responseChars: upstreamResp.text.length,
      });
      res.statusCode = upstreamResp.status;
      setForwardHeaders(res, upstreamResp.headers, "application/json; charset=utf-8");
      res.end(upstreamResp.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(message);
      sendJson(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.proxyPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const baseUrl = `http://127.0.0.1:${config.proxyPort}/v1`;
  logger.info(`proxy listening at ${baseUrl}; upstream=${upstream.baseUrl}`);
  return {
    baseUrl,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}
