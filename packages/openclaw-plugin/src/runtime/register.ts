/* eslint-disable @typescript-eslint/no-explicit-any */
import { installLlmHookTap } from "../trace/hooks.js";
import { createSessionTopologyManager } from "../session/topology.js";
import { loadRecentTurnBindingsFromState, persistRecentTurnBindingsToState } from "../session/turn-bindings.js";
import { maybeRegisterProxyProvider } from "../proxy/provider.js";
import { startEmbeddedResponsesProxy } from "../proxy/runtime.js";
import { registerMemoryFaultRecoverTool } from "../recovery/tool.js";

function logTaskStateMonitor(
  ctx: any,
  logger: { info: (message: string) => void },
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): void {
  const taskState = asRecord(asRecord(asRecord(ctx.metadata?.policy)?.decisions)?.taskState);
  if (!taskState || taskState.enabled !== true || taskState.attempted !== true) return;

  const transitions = Array.isArray(taskState.transitions)
    ? taskState.transitions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const rejected = Array.isArray(taskState.rejectedUpdates)
    ? taskState.rejectedUpdates
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  const touchedTaskIds = Array.isArray(taskState.touchedTaskIds)
    ? taskState.touchedTaskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const note = typeof taskState.note === "string" ? taskState.note.trim() : "";

  if (transitions.length === 0 && rejected.length === 0 && !note) return;

  const transitionText =
    transitions.length > 0
      ? transitions
          .slice(0, 8)
          .map((item) => {
            const taskId = typeof item.taskId === "string" ? item.taskId : "task";
            const from = typeof item.from === "string" && item.from.trim().length > 0 ? item.from : "new";
            const to = typeof item.to === "string" ? item.to : "unknown";
            return `${taskId}:${from}->${to}`;
          })
          .join(", ")
      : "none";
  const rejectedText =
    rejected.length > 0
      ? rejected
          .slice(0, 8)
          .map((item) => {
            const taskId = typeof item.taskId === "string" ? item.taskId : "task";
            const from = typeof item.from === "string" && item.from.trim().length > 0 ? item.from : "new";
            const to = typeof item.to === "string" ? item.to : "unknown";
            const reason = typeof item.reason === "string" ? item.reason : "rejected";
            return `${taskId}:${from}->${to}(${reason})`;
          })
          .join(", ")
      : "none";
  logger.info(
    `[ecoclaw/task-state] session=${ctx.sessionId} applied=${taskState.applied === true} touched=${touchedTaskIds.length} transitions=[${transitionText}] rejected=[${rejectedText}]${note ? ` note=${note}` : ""}`,
  );
}

function logEvictionPlanMonitor(
  ctx: any,
  logger: { info: (message: string) => void },
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): void {
  const eviction = asRecord(asRecord(asRecord(ctx.metadata?.policy)?.decisions)?.eviction);
  if (!eviction || eviction.enabled !== true) return;
  const instructions = Array.isArray(eviction.instructions)
    ? eviction.instructions
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (instructions.length === 0) return;
  const taskIds = Array.from(
    new Set(
      instructions.flatMap((item) => {
        const params = asRecord(item.parameters);
        const taskId =
          typeof params?.taskId === "string" && params.taskId.trim().length > 0 ? [params.taskId.trim()] : [];
        return taskId;
      }),
    ),
  );
  logger.info(
    `[ecoclaw/eviction-plan] session=${ctx.sessionId} instructions=${instructions.length} tasks=${taskIds.length > 0 ? taskIds.join(", ") : "unknown"} policy=${typeof eviction.policy === "string" ? eviction.policy : "unknown"}`,
  );
}

export function applyPolicyMonitors(
  ctx: any,
  logger: { info: (message: string) => void },
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): void {
  logTaskStateMonitor(ctx, logger, asRecord);
  logEvictionPlanMonitor(ctx, logger, asRecord);
}

export async function registerRuntime(api: any, cfg: any, logger: any, deps: any): Promise<void> {
  registerMemoryFaultRecoverTool(api, cfg, logger);

  const topology = createSessionTopologyManager();
  const recentTurnBindings: Array<{
    userMessage: string;
    matchKey: string;
    sessionKey: string;
    upstreamSessionId?: string;
    at: number;
  }> = [];
  const rememberTurnBinding = (userMessage: string, sessionKey: string, upstreamSessionId?: string) => {
    const normalizedMessage = String(userMessage ?? "").trim();
    const matchKey = deps.normalizeTurnBindingMessage(normalizedMessage);
    const normalizedSessionKey = String(sessionKey ?? "").trim();
    if (!normalizedMessage || !matchKey || !normalizedSessionKey) return;
    recentTurnBindings.push({
      userMessage: normalizedMessage,
      matchKey,
      sessionKey: normalizedSessionKey,
      upstreamSessionId: String(upstreamSessionId ?? "").trim() || undefined,
      at: Date.now(),
    });
    while (recentTurnBindings.length > 128) recentTurnBindings.shift();
    if (cfg.stateDir) {
      persistRecentTurnBindingsToState(cfg.stateDir, recentTurnBindings);
    }
  };

  const resolveTurnBinding = (userMessage: string) => {
    const normalizedMessage = deps.normalizeTurnBindingMessage(String(userMessage ?? "").trim());
    if (!normalizedMessage) return null;
    const persistedCandidates = cfg.stateDir
      ? loadRecentTurnBindingsFromState(cfg.stateDir, deps.normalizeTurnBindingMessage)
      : [];
    const candidates = [...recentTurnBindings, ...persistedCandidates];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      if (candidate.matchKey !== normalizedMessage) continue;
      if (Date.now() - candidate.at > 30 * 60 * 1000) continue;
      return candidate;
    }
    return null;
  };

  const resolveBoundUpstreamSessionId = (userMessage: string): string | undefined => {
    const binding = resolveTurnBinding(userMessage);
    const upstreamSessionId = String(binding?.upstreamSessionId ?? "").trim();
    return upstreamSessionId || undefined;
  };

  const resolveSessionIdForPayload = (payload: any): string | undefined => {
    const promptSessionId = resolveBoundUpstreamSessionId(String(payload?.prompt ?? ""));
    if (promptSessionId) return promptSessionId;
    const lastUser = deps.findLastUserItem(payload?.input);
    return resolveBoundUpstreamSessionId(deps.extractItemText(lastUser?.userItem));
  };

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
      const startedRuntime = await startEmbeddedResponsesProxy(cfg, logger, resolveSessionIdForPayload, deps.proxyRuntimeHelpers);
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
    })().catch((err) => {
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
    const sessionKey = deps.extractSessionKey(event);
    const upstreamSessionId = deps.extractOpenClawSessionId(event);
    if (!sessionKey || !upstreamSessionId) return;
    topology.bindUpstreamSession(sessionKey, upstreamSessionId);
    if (deps.debugEnabled) {
      logger.debug(
        `[plugin-runtime] session_start synced sessionKey=${sessionKey} openclawSessionId=${upstreamSessionId}`,
      );
    }
  });

  deps.hookOn(api, "message_received", async (event: any) => {
    const sessionKey = deps.extractSessionKey(event);
    const upstreamSessionId = deps.extractOpenClawSessionId(event) || topology.getUpstreamSessionId(sessionKey) || undefined;
    const userMessage = deps.extractLastUserMessage(event);
    if (userMessage.trim()) rememberTurnBinding(userMessage, sessionKey, upstreamSessionId);
    if (!deps.debugEnabled) return;
    logger.debug(`[plugin-runtime] message_received session=${sessionKey}`);
  });

  deps.hookOn(api, "llm_input", async (event: any) => {
    const userMessage = deps.extractLastUserMessage(event);
    const upstreamSessionId = deps.extractOpenClawSessionId(event);
    const sessionKey = deps.extractSessionKey(event);
    if (userMessage.trim() && sessionKey.trim()) {
      rememberTurnBinding(userMessage, sessionKey, upstreamSessionId || undefined);
      if (upstreamSessionId) topology.bindUpstreamSession(sessionKey, upstreamSessionId);
    }
    if (cfg.stateDir && upstreamSessionId) {
      const messages = Array.isArray(event?.messages) ? event.messages : [];
      const transcriptSync = await deps.syncRawSemanticTurnsFromTranscript(cfg.stateDir, upstreamSessionId, {
        contentToText: deps.contentToText,
        contextSafeRecovery: deps.contextSafeRecovery,
        memoryFaultRecoverToolName: deps.memoryFaultRecoverToolName,
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
      id: "ecoclaw-runtime",
      start: () => {
        void ensureProxyReady();
        logger.info("[plugin-runtime] Plugin active.");
        if (proxyRuntime?.baseUrl) {
          logger.info(`[plugin-runtime] Embedded proxy active at ${proxyRuntime.baseUrl}`);
        } else {
          logger.info("[plugin-runtime] Embedded proxy unavailable; ecoclaw provider was not registered.");
        }
        logger.info("[plugin-runtime] TokenPilot runtime active. Use explicit model key: ecoclaw/<model> (example: ecoclaw/gpt-5.4).");
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
