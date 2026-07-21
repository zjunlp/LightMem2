/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  registerMemoryFaultRecoverTool,
} from "../page-in-api.js";
import { installLlmHookTap } from "./trace-hooks.js";
import { startEmbeddedResponsesProxy } from "./proxy-runtime.js";
import { maybeRegisterProxyProvider } from "./proxy-provider.js";
import { applyPolicyMonitors } from "./runtime-policy-monitors.js";
import { createRuntimeSessionRouter } from "./runtime-session-router.js";
import { upsertOpenClawSessionSummary } from "../../session/session-summary.js";

export async function registerRuntime(api: any, cfg: any, logger: any, deps: any): Promise<void> {
  registerMemoryFaultRecoverTool(api, cfg, logger);
  const sessionRouter = createRuntimeSessionRouter({ cfg, deps });

  let proxyRuntime: Awaited<ReturnType<typeof startEmbeddedResponsesProxy>> | null = null;
  let proxyInitDone = false;
  let proxyInitPromise: Promise<void> | null = null;
  let proxyLifecycleEpoch = 0;

  const ensureProxyReady = async (): Promise<void> => {
    if (proxyInitDone) return;
    if (proxyInitPromise) return proxyInitPromise;
    const ensureEpoch = proxyLifecycleEpoch;
    proxyInitPromise = (async () => {
      const g = globalThis as any;
      const existing = g.__runtime_optimizer_embedded_proxy_runtime__;
      if (existing && existing.baseUrl && existing.upstream) {
        if (ensureEpoch !== proxyLifecycleEpoch) return;
        proxyRuntime = existing;
        proxyInitDone = true;
        return;
      }
      const startedRuntime = await startEmbeddedResponsesProxy(
        cfg,
        logger,
        sessionRouter.resolveSessionIdForPayload,
        deps.proxyRuntimeHelpers,
      );
      if (!startedRuntime) return;
      if (ensureEpoch !== proxyLifecycleEpoch) {
        await startedRuntime.close().catch(() => undefined);
        return;
      }
      proxyRuntime = startedRuntime;
      g.__runtime_optimizer_embedded_proxy_runtime__ = startedRuntime;
      deps.maybeRegisterProxyProvider(api, cfg, logger, startedRuntime.baseUrl, startedRuntime.upstream);
      await deps.ensureExplicitProxyModelsInConfig(startedRuntime.baseUrl, startedRuntime.upstream, logger);
      proxyInitDone = true;
    })().catch((err: unknown) => {
      proxyInitDone = false;
      logger.warn(`[plugin-runtime] embedded proxy init failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      proxyInitPromise = null;
    });
    return proxyInitPromise;
  };

  deps.installLlmHookTap(api, cfg, logger, {
    hookOn: deps.hookOn,
    extractTurnObservations: deps.extractTurnObservations,
    contentToText: deps.contentToText,
    contextSafeRecovery: deps.contextSafeRecovery,
    memoryFaultRecoverToolName: deps.memoryFaultRecoverToolName,
    extractSessionKey: deps.extractSessionKey,
    extractLastUserMessage: deps.extractLastUserMessage,
  });

  deps.hookOn(api, "session_start", (event: any) => {
    const binding = sessionRouter.bindSessionStart(event);
    if (!binding) return;
    if (deps.debugEnabled) {
      logger.debug(
        `[plugin-runtime] session_start synced sessionKey=${binding.sessionKey} openclawSessionId=${binding.upstreamSessionId}`,
      );
    }
  });

  deps.hookOn(api, "message_received", async (event: any) => {
    const sessionKey = deps.extractSessionKey(event);
    const upstreamSessionId =
      deps.extractOpenClawSessionId(event) || sessionRouter.topology.getUpstreamSessionId(sessionKey) || undefined;
    const userMessage = deps.extractLastUserMessage(event);
    if (userMessage.trim()) {
      sessionRouter.rememberUserMessageBinding(event, userMessage, upstreamSessionId);
    }
    if (!deps.debugEnabled) return;
    logger.debug(`[plugin-runtime] message_received session=${sessionKey}`);
  });

  deps.hookOn(api, "llm_input", async (event: any) => {
    const userMessage = deps.extractLastUserMessage(event);
    const upstreamSessionId = deps.extractOpenClawSessionId(event);
    const sessionKey = deps.extractSessionKey(event);
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    sessionRouter.rememberWorkspaceHint(sessionKey, upstreamSessionId || undefined, messages);
    sessionRouter.rememberUserMessageBinding(event, userMessage, upstreamSessionId || undefined);
    if (cfg.stateDir && upstreamSessionId) {
      const transcriptSync = await deps.syncRawSemanticTurnsFromTranscript(cfg.stateDir, upstreamSessionId, {
        contentToText: deps.contentToText,
        contextSafeRecovery: deps.contextSafeRecovery,
        memoryFaultRecoverToolName: deps.memoryFaultRecoverToolName,
      });
      await upsertOpenClawSessionSummary(cfg.stateDir, upstreamSessionId, {
        sessionKey,
        turnCount: transcriptSync.turnCount,
        updatedAt: new Date().toISOString(),
      });
      await deps.appendTaskStateTrace(cfg.stateDir, {
        stage: "llm_input_received",
        sessionId: upstreamSessionId,
        upstreamSessionId: upstreamSessionId || null,
        messageCount: messages.length,
        hasUserMessage: userMessage.trim().length > 0,
        transcriptTurnCount: transcriptSync.turnCount,
        transcriptUpdatedTurnSeqs: transcriptSync.updatedTurnSeqs,
      });
    }
    if (!deps.debugEnabled) return;
    logger.debug(`[plugin-runtime] llm_input prompt-bound session=${upstreamSessionId || "pending-session"} openclawSessionId=${upstreamSessionId || "-"}`);
  });

  deps.hookOn(api, "llm_output", async (event: any) => {
    const upstreamSessionId = deps.extractOpenClawSessionId(event);
    if (!cfg.stateDir || !upstreamSessionId) return;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const transcriptSync = await deps.syncRawSemanticTurnsFromTranscript(cfg.stateDir, upstreamSessionId, {
      contentToText: deps.contentToText,
      contextSafeRecovery: deps.contextSafeRecovery,
      memoryFaultRecoverToolName: deps.memoryFaultRecoverToolName,
    });
    await upsertOpenClawSessionSummary(cfg.stateDir, upstreamSessionId, {
      turnCount: transcriptSync.turnCount,
      updatedAt: new Date().toISOString(),
    });
    await deps.appendTaskStateTrace(cfg.stateDir, {
      stage: "llm_output_received",
      sessionId: upstreamSessionId,
      upstreamSessionId: upstreamSessionId || null,
      messageCount: messages.length,
      transcriptTurnCount: transcriptSync.turnCount,
      transcriptUpdatedTurnSeqs: transcriptSync.updatedTurnSeqs,
    });
  });

  if (typeof api.registerService === "function") {
    api.registerService({
      id: "tokenpilot-runtime",
      start: () => {
        void ensureProxyReady();
        logger.info("[plugin-runtime] Plugin active.");
        if (proxyRuntime?.baseUrl) {
          logger.info(`[plugin-runtime] Embedded proxy active at ${proxyRuntime.baseUrl}`);
        } else {
          logger.info("[plugin-runtime] Embedded proxy unavailable; tokenpilot provider was not registered.");
        }
        logger.info("[plugin-runtime] TokenPilot runtime active. Use explicit model key: tokenpilot/<model> (example: tokenpilot/gpt-5.4).");
        logger.info(`[plugin-runtime] State dir=${cfg.stateDir} debugTap=${cfg.debugTapProviderTraffic ? "on" : "off"}`);
      },
      stop: () => {
        proxyLifecycleEpoch += 1;
        const stopEpoch = proxyLifecycleEpoch;
        if (proxyRuntime) {
          void proxyRuntime.close().catch((err) => {
            logger.warn(`[plugin-runtime] embedded proxy stop failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          const g = globalThis as any;
          if (g.__runtime_optimizer_embedded_proxy_runtime__ === proxyRuntime) delete g.__runtime_optimizer_embedded_proxy_runtime__;
          proxyRuntime = null;
          proxyInitDone = false;
        }
        if (proxyInitPromise) {
          void proxyInitPromise.then(() => {
            if (stopEpoch !== proxyLifecycleEpoch) return;
            const g = globalThis as any;
            const runtime = g.__runtime_optimizer_embedded_proxy_runtime__;
            if (runtime && runtime !== proxyRuntime) {
              void runtime.close().catch(() => undefined);
              if (g.__runtime_optimizer_embedded_proxy_runtime__ === runtime) delete g.__runtime_optimizer_embedded_proxy_runtime__;
            }
          }).catch(() => undefined);
        }
        logger.info("[plugin-runtime] Plugin stopped.");
      },
    });
  }
}
