/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer } from "node:http";
import type { UpstreamConfig } from "./upstream.js";
import { resolveProxyUpstream } from "./proxy-runtime-bootstrap.js";
import { prepareProxyRequest } from "./proxy-runtime-request.js";
import { handleNonStreamingProxyResponse, handleStreamingProxyResponse } from "./proxy-runtime-response.js";

export async function startEmbeddedResponsesProxy(
  cfg: any,
  logger: any,
  resolveSessionIdForPayload: ((payload: any) => string | undefined) | undefined,
  helpers: any,
): Promise<{ baseUrl: string; upstream: UpstreamConfig; close: () => Promise<void> } | null> {
  if (!cfg.proxyAutostart) return null;
  const upstream = await resolveProxyUpstream(cfg, logger, helpers);
  if (!upstream) {
    logger.warn("[plugin-runtime] no upstream provider discovered; proxy disabled.");
    return null;
  }
  logger.info(
    `[plugin-runtime] resolved upstream provider=${upstream.providerId} api=${upstream.apiFamily ?? "unknown"} baseUrl=${upstream.baseUrl}`,
  );

  const policyModule = helpers.createPolicyModule(helpers.buildPolicyModuleConfigFromPluginConfig(cfg, upstream));
  const reductionPassOptions = cfg.reduction.passOptions ?? {};
  const dynamicContextTarget = cfg.hooks.dynamicContextTarget === "user" ? "user" : "developer";

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
      const prepared = await prepareProxyRequest({
        cfg,
        logger,
        helpers,
        payload,
        upstream,
        resolveSessionIdForPayload,
        policyModule,
        reductionPassOptions,
        dynamicContextTarget,
      });
      const activePayload = prepared.payload;
      const isStreamingRequest = activePayload?.stream === true;
      if (isStreamingRequest) {
        await handleStreamingProxyResponse({
          cfg,
          res,
          helpers,
          logger,
          upstream,
          activePayload,
          requestEnvelope: prepared.requestEnvelope,
          payloadCodec: prepared.payloadCodec,
          resolvedSessionId: prepared.resolvedSessionId,
          model: prepared.model,
          upstreamModel: prepared.upstreamModel,
          proxyPureForward: prepared.proxyPureForward,
          originalInputText: prepared.originalInputText,
          afterReductionInputText: prepared.afterReductionInputText,
          beforeReductionCanonicalInput: prepared.beforeReductionCanonicalInput,
          afterReductionCanonicalInput: prepared.afterReductionCanonicalInput,
          reductionApplied: prepared.reductionApplied,
          cacheAuditSnapshot: prepared.cacheAuditSnapshot,
        });
        return;
      }
      await handleNonStreamingProxyResponse({
        cfg,
        res,
        helpers,
        logger,
        upstream,
        activePayload,
        requestEnvelope: prepared.requestEnvelope,
        payloadCodec: prepared.payloadCodec,
        resolvedSessionId: prepared.resolvedSessionId,
        model: prepared.model,
        upstreamModel: prepared.upstreamModel,
        proxyPureForward: prepared.proxyPureForward,
        originalInputText: prepared.originalInputText,
        afterReductionInputText: prepared.afterReductionInputText,
        beforeReductionCanonicalInput: prepared.beforeReductionCanonicalInput,
        afterReductionCanonicalInput: prepared.afterReductionCanonicalInput,
        reductionApplied: prepared.reductionApplied,
        reductionPassOptions: prepared.reductionPassOptions,
        reductionMaxToolChars: prepared.reductionMaxToolChars,
        reductionTriggerMinChars: prepared.reductionTriggerMinChars,
        cacheAuditSnapshot: prepared.cacheAuditSnapshot,
      });
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
