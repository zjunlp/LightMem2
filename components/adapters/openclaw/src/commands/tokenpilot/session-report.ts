import { readLatestUxEffect, readSessionUxAggregate } from "../../context-stack/integration/ux-effects.js";
import { extractScopedSessionKey } from "../../session/scoped-session-key.js";
import { resolveSessionIdFromCommandScope } from "../../session/command-scope-map.js";
import { loadRecentTurnBindingsFromState } from "../../session/turn-bindings.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  getNestedValue,
  readSessionModuleObservationSummary,
  renderSessionReport,
  toRecord,
} from "@tokenpilot/product-surface";
import {
  pluginConfigRecord,
  resolveStateDir,
} from "./host-config-adapter.js";
import { resolveOpenClawSessionsRegistryPath } from "../../context-stack/integration/openclaw-paths.js";
import { buildOpenClawSessionOverview, readOpenClawSessionSummary } from "../../session/session-summary.js";
import {
  readRecentOpenClawCacheAuditRecordsForSession,
  summarizeOpenClawCacheAudit,
} from "../../cache-audit.js";

function normalizeSessionRef(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function looksLikeUuidSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function looksLikeOpenClawSessionKey(value: string): boolean {
  return value.startsWith("agent:");
}

function readSessionIdFromRegistryEntry(entry: Record<string, unknown> | undefined): string | undefined {
  const direct = normalizeSessionRef(entry?.sessionId);
  if (looksLikeUuidSessionId(direct)) return direct;

  const sessionFile = normalizeSessionRef(entry?.sessionFile);
  if (sessionFile) {
    const fileBase = basename(sessionFile).replace(/\.jsonl$/i, "").trim();
    if (looksLikeUuidSessionId(fileBase)) return fileBase;
  }

  const systemPromptReport = toRecord(entry?.systemPromptReport);
  const nested = normalizeSessionRef(systemPromptReport?.sessionId);
  if (looksLikeUuidSessionId(nested)) return nested;
  return undefined;
}

function resolveOpenClawSessionIdFromSessionKey(sessionKey: string): string | undefined {
  const normalized = normalizeSessionRef(sessionKey);
  if (!looksLikeOpenClawSessionKey(normalized)) return undefined;
  const segments = normalized.split(":");
  const agentId = segments[1]?.trim();
  if (!agentId) return undefined;
  const registryPath = resolveOpenClawSessionsRegistryPath(agentId);
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    const registry = toRecord(parsed);
    if (!registry) return undefined;
    const directEntry = toRecord(registry[normalized]);
    const directSessionId = readSessionIdFromRegistryEntry(directEntry);
    if (directSessionId) return directSessionId;
    for (const value of Object.values(registry)) {
      const entry = toRecord(value);
      const systemPromptReport = toRecord(entry?.systemPromptReport);
      if (normalizeSessionRef(systemPromptReport?.sessionKey) !== normalized) continue;
      const sessionId = readSessionIdFromRegistryEntry(entry);
      if (sessionId) return sessionId;
    }
  } catch {
    // best effort
  }
  return undefined;
}

function resolveDirectSessionId(ctx: any): string | undefined {
  const directCandidates = [
    ctx?.sessionId,
    ctx?.session_id,
    ctx?.ctx?.SessionId,
    ctx?.ctx?.sessionId,
    ctx?.params?.sessionId,
    ctx?.params?.session_id,
    ctx?.params?.SessionId,
  ];
  for (const candidate of directCandidates) {
    const value = normalizeSessionRef(candidate);
    if (!value) continue;
    if (looksLikeOpenClawSessionKey(value)) {
      const mapped = resolveOpenClawSessionIdFromSessionKey(value);
      if (mapped) return mapped;
      continue;
    }
    if (looksLikeUuidSessionId(value)) return value;
  }

  const sessionKeyCandidates = [
    ctx?.sessionKey,
    ctx?.session_key,
    ctx?.SessionKey,
    ctx?.ctx?.SessionKey,
    ctx?.ctx?.CommandTargetSessionKey,
    ctx?.params?.sessionKey,
    ctx?.params?.session_key,
    ctx?.params?.SessionKey,
  ];
  for (const candidate of sessionKeyCandidates) {
    const value = normalizeSessionRef(candidate);
    if (!value) continue;
    const mapped = resolveOpenClawSessionIdFromSessionKey(value);
    if (mapped) return mapped;
  }
  return undefined;
}

function resolveScopedSessionId(stateDir: string, ctx: any): string | undefined {
  const mappedSessionId = resolveSessionIdFromCommandScope(stateDir, ctx, ctx?.commandBody);
  if (mappedSessionId) return mappedSessionId;

  const scopedSessionKey = extractScopedSessionKey(ctx);
  const bindings = loadRecentTurnBindingsFromState(stateDir, (text) => text);

  if (scopedSessionKey) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      if (binding.sessionKey !== scopedSessionKey) continue;
      const upstreamSessionId = String(binding.upstreamSessionId ?? "").trim();
      if (upstreamSessionId) return upstreamSessionId;
    }
  }

  const recentCutoff = Date.now() - 30 * 60 * 1000;
  for (let index = bindings.length - 1; index >= 0; index -= 1) {
    const binding = bindings[index];
    if (binding.at < recentCutoff) continue;
    const upstreamSessionId = String(binding.upstreamSessionId ?? "").trim();
    if (upstreamSessionId) return upstreamSessionId;
  }
  return undefined;
}

export async function handleReport(ctx: any, currentConfig: Record<string, unknown>): Promise<{ text: string }> {
  const stateDir = resolveStateDir(currentConfig);
  if (!stateDir) {
    return { text: "⚠️ TokenPilot stateDir is not configured." };
  }

  const latest = await readLatestUxEffect(stateDir);
  const directSessionId = resolveDirectSessionId(ctx);
  const scopedSessionKey = directSessionId ? undefined : extractScopedSessionKey(ctx);
  const scopedSessionId = directSessionId ? undefined : resolveScopedSessionId(stateDir, ctx);
  const sessionId = directSessionId ?? scopedSessionId ?? (scopedSessionKey ? undefined : latest?.sessionId);
  if (!sessionId) {
    return { text: scopedSessionKey ? "No TokenPilot savings recorded yet for current session." : "No TokenPilot session stats yet." };
  }

  const [aggregate, moduleSummary] = await Promise.all([
    readSessionUxAggregate(stateDir, sessionId),
    readSessionModuleObservationSummary(stateDir, sessionId),
  ]);
  if (!aggregate && !moduleSummary) {
    return { text: `No TokenPilot savings recorded yet for session ${sessionId}.` };
  }

  const pluginCfg = pluginConfigRecord(currentConfig);
  const detailsEnabled = getNestedValue(pluginCfg, ["ux", "details"]) === true;
  const summary = await readOpenClawSessionSummary(stateDir, sessionId);
  const cacheAuditRecords = await readRecentOpenClawCacheAuditRecordsForSession(stateDir, sessionId, 64);
  const cacheAuditSummary = cacheAuditRecords.length > 0
    ? summarizeOpenClawCacheAudit(cacheAuditRecords)
    : null;
  return {
    text: await renderSessionReport({
      stateDir,
      sessionId,
      detailsEnabled,
      cacheAuditSummary,
      moduleSummary,
      emptyMessage: moduleSummary
        ? "- no reduction savings recorded; module diagnostics are available below"
        : undefined,
      overview: buildOpenClawSessionOverview(sessionId, summary),
      readers: {
        readLatest: readLatestUxEffect,
        readAggregate: readSessionUxAggregate,
      },
    }),
  };
}
