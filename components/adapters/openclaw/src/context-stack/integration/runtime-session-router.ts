/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  createSessionTopologyManager,
} from "../../session/topology.js";
import {
  loadRecentTurnBindingsFromState,
  persistRecentTurnBindingsToState,
} from "../../session/turn-bindings.js";
import { extractScopedSessionKey } from "../../session/scoped-session-key.js";
import { deriveCommandScopeKeys, persistCommandScopeBindings } from "../../session/command-scope-map.js";

type RecentTurnBinding = {
  userMessage: string;
  matchKey: string;
  sessionKey: string;
  upstreamSessionId?: string;
  at: number;
};

export function createRuntimeSessionRouter(params: {
  cfg: any;
  deps: any;
}) {
  const { cfg, deps } = params;
  const topology = createSessionTopologyManager();
  const recentTurnBindings: RecentTurnBinding[] = [];

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

  const rememberScopedTurnBinding = (event: any, userMessage: string, upstreamSessionId?: string) => {
    const scopedSessionKey = extractScopedSessionKey(event);
    if (!scopedSessionKey) return;
    rememberTurnBinding(userMessage, scopedSessionKey, upstreamSessionId);
  };

  const rememberCommandScopeBinding = (event: any, userMessage: string, upstreamSessionId?: string) => {
    const normalizedSessionId = String(upstreamSessionId ?? "").trim();
    if (!cfg.stateDir || !normalizedSessionId) return;
    const entries = deriveCommandScopeKeys(event, userMessage).map((scopeKey) => ({
      scopeKey,
      sessionId: normalizedSessionId,
      at: Date.now(),
    }));
    if (entries.length === 0) return;
    persistCommandScopeBindings(cfg.stateDir, entries);
  };

  const readExplicitPayloadSessionId = (payload: any): string | undefined => {
    const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
    const directCandidates = [
      payload?.session_id,
      payload?.sessionId,
      payload?.openclawSessionId,
      payload?.tokenpilotSessionId,
      payload?.conversation_id,
      payload?.conversationId,
      metadata?.session_id,
      metadata?.sessionId,
      metadata?.openclawSessionId,
      metadata?.tokenpilotSessionId,
      metadata?.conversation_id,
      metadata?.conversationId,
    ];
    for (const candidate of directCandidates) {
      const value = String(candidate ?? "").trim();
      if (value) return value;
    }
    return undefined;
  };

  const hasContinuationHints = (payload: any): boolean => {
    const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : null;
    const candidates = [
      payload?.previous_response_id,
      payload?.previousResponseId,
      payload?.prompt_cache_key,
      payload?.promptCacheKey,
      metadata?.previous_response_id,
      metadata?.previousResponseId,
      metadata?.prompt_cache_key,
      metadata?.promptCacheKey,
    ];
    for (const candidate of candidates) {
      if (String(candidate ?? "").trim()) return true;
    }
    return false;
  };

  const resolveTurnBinding = (userMessage: string): RecentTurnBinding | null => {
    const normalizedMessage = deps.normalizeTurnBindingMessage(String(userMessage ?? "").trim());
    if (!normalizedMessage) return null;
    const persistedCandidates = cfg.stateDir
      ? loadRecentTurnBindingsFromState(cfg.stateDir, deps.normalizeTurnBindingMessage)
      : [];
    const candidates = [...recentTurnBindings, ...persistedCandidates];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      if (Date.now() - candidate.at > 30 * 60 * 1000) continue;
      if (candidate.matchKey === normalizedMessage) return candidate;
    }
    return null;
  };

  const resolveBoundUpstreamSessionId = (userMessage: string): string | undefined => {
    const binding = resolveTurnBinding(userMessage);
    const upstreamSessionId = String(binding?.upstreamSessionId ?? "").trim();
    return upstreamSessionId || undefined;
  };

  const resolveSessionIdForPayload = (payload: any): string | undefined => {
    const explicitSessionId = readExplicitPayloadSessionId(payload);
    if (explicitSessionId) return explicitSessionId;
    const promptSessionId = resolveBoundUpstreamSessionId(String(payload?.prompt ?? ""));
    if (promptSessionId) return promptSessionId;
    const lastUser = deps.findLastUserItem(payload?.input);
    const userBoundSessionId = resolveBoundUpstreamSessionId(deps.extractItemText(lastUser?.userItem));
    if (userBoundSessionId) return userBoundSessionId;
    if (!hasContinuationHints(payload)) return undefined;
    return topology.getLatestUpstreamSessionId() ?? undefined;
  };

  const rememberWorkspaceHint = (
    sessionKey: string | undefined,
    upstreamSessionId: string | undefined,
    messages: any[],
  ) => {
    const workspaceDir = deps.extractWorkspaceDirFromMessages?.(messages, deps.contentToText);
    if (!workspaceDir) return;
    deps.rememberWorkspaceHint?.(sessionKey, upstreamSessionId, workspaceDir);
  };

  const rememberUserMessageBinding = (event: any, userMessage: string, upstreamSessionId?: string) => {
    const sessionKey = deps.extractSessionKey(event);
    if (!userMessage.trim() || !sessionKey.trim()) return;
    rememberTurnBinding(userMessage, sessionKey, upstreamSessionId);
    rememberScopedTurnBinding(event, userMessage, upstreamSessionId);
    rememberCommandScopeBinding(event, userMessage, upstreamSessionId);
    if (upstreamSessionId) topology.bindUpstreamSession(sessionKey, upstreamSessionId);
  };

  const bindSessionStart = (event: any): { sessionKey: string; upstreamSessionId: string } | null => {
    const sessionKey = deps.extractSessionKey(event);
    const upstreamSessionId = deps.extractOpenClawSessionId(event);
    if (!sessionKey || !upstreamSessionId) return null;
    topology.bindUpstreamSession(sessionKey, upstreamSessionId);
    return { sessionKey, upstreamSessionId };
  };

  return {
    topology,
    rememberUserMessageBinding,
    rememberWorkspaceHint,
    resolveSessionIdForPayload,
    bindSessionStart,
  };
}
