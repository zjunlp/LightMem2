import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl, readRecentJsonlEntries } from "./file-store.js";
import { readCachedInputTokens } from "./cache-usage.js";
import {
  extractStablePrefixContract,
  fingerprintStablePrefixEnvelope,
  serializeStablePrefixContract,
} from "@tokenpilot/stabilizer";
import {
  auditStablePrefixEntropy,
  diffStablePrefixSerialized,
} from "@tokenpilot/stabilizer";
import type { HostRequestEnvelope } from "../model/host-request.js";

export type CacheAuditBaselineKind = "identity" | "request_key" | "session" | "none";

export type CacheAuditRecord = {
  at: string;
  sessionId: string;
  model: string;
  stream: boolean;
  stablePrefixFingerprint: string;
  stablePrefix: ReturnType<typeof serializeStablePrefixContract>;
  entropyFindings: ReturnType<typeof auditStablePrefixEntropy>;
  driftReasons: ReturnType<typeof diffStablePrefixSerialized>;
  originalRequestPromptCacheKey: string | null;
  requestPromptCacheKey: string | null;
  responsePromptCacheKey: string | null;
  cachedInputTokens: number;
  usage: Record<string, unknown> | null;
  status: number;
  baselineKind?: CacheAuditBaselineKind;
};

export type CacheAuditSnapshot = Omit<
  CacheAuditRecord,
  "at" | "responsePromptCacheKey" | "cachedInputTokens" | "usage" | "status"
>;

export type CacheAuditSummary = {
  totalRecords: number;
  /**
   * Warm-cache identity is requestPromptCacheKey + stablePrefixFingerprint when available,
   * otherwise sessionId + stablePrefixFingerprint.
   * responsePromptCacheKey is intentionally excluded because some providers rewrite it.
   */
  warmCandidates: number;
  warmHits: number;
  warmMisses: number;
  hitRatePercent: number;
  latestSessionId?: string;
  latestFingerprint?: string;
  topEntropyKinds: Array<{ key: string; count: number }>;
  topDriftKeys: Array<{ key: string; count: number }>;
  /**
   * Compatibility signal only: upstream accepted the request but returned a different
   * responsePromptCacheKey. This does not affect warm-hit classification.
   */
  responsePromptCacheKeyRewriteCount: number;
  /**
   * Back-compat alias for responsePromptCacheKeyRewriteCount.
   * Keep until all downstream surfaces stop reading the old name.
   */
  promptCacheKeyMismatchCount: number;
};

function cacheAuditPath(stateDir: string): string {
  return join(stateDir, "cache-audit.jsonl");
}

function cacheAuditSessionPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "cache-audit-sessions", `${encodeURIComponent(sessionId)}.jsonl`);
}

function isCacheAuditRecord(value: unknown): value is CacheAuditRecord {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as Record<string, unknown>).sessionId === "string"
    && typeof (value as Record<string, unknown>).stablePrefixFingerprint === "string",
  );
}

function cacheIdentity(record: {
  sessionId: string;
  stablePrefixFingerprint: string;
  requestPromptCacheKey: string | null;
}): string | null {
  const fingerprint = record.stablePrefixFingerprint.trim();
  if (!fingerprint) return null;
  const requestPromptCacheKey = record.requestPromptCacheKey?.trim();
  if (requestPromptCacheKey) {
    return `prompt_cache_key:${requestPromptCacheKey}::fingerprint:${fingerprint}`;
  }
  const sessionId = record.sessionId.trim();
  if (sessionId) {
    return `session:${sessionId}::fingerprint:${fingerprint}`;
  }
  return null;
}

function topCounts(counts: Map<string, number>, limit = 5): Array<{ key: string; count: number }> {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export async function readRecentCacheAuditRecords<T extends CacheAuditRecord>(
  stateDir: string,
  limit = 32,
): Promise<T[]> {
  return readRecentJsonlEntries<T>(
    cacheAuditPath(stateDir),
    limit,
    (value): value is T => isCacheAuditRecord(value),
  );
}

export async function readRecentCacheAuditRecordsForSession<T extends CacheAuditRecord>(
  stateDir: string,
  sessionId: string,
  limit = 32,
): Promise<T[]> {
  const target = String(sessionId ?? "").trim();
  if (!target) return [];
  const sessionRecords = await readRecentJsonlEntries<T>(
    cacheAuditSessionPath(stateDir, target),
    Math.max(1, limit),
    (value): value is T => isCacheAuditRecord(value),
  );
  if (sessionRecords.length > 0) return sessionRecords;
  const records = await readRecentJsonlEntries<T>(
    cacheAuditPath(stateDir),
    Number.MAX_SAFE_INTEGER,
    (value): value is T => isCacheAuditRecord(value),
  );
  return records.filter((record) => record.sessionId === target).slice(0, Math.max(1, limit));
}

export function summarizeCacheAudit<T extends CacheAuditRecord>(
  records: T[],
): CacheAuditSummary {
  const ordered = records.slice().reverse();
  const seenCacheIdentities = new Set<string>();
  let warmCandidates = 0;
  let warmHits = 0;
  let warmMisses = 0;
  let promptCacheKeyMismatchCount = 0;
  const entropyCounts = new Map<string, number>();
  const driftCounts = new Map<string, number>();

  for (const record of ordered) {
    const identity = cacheIdentity(record);
    if (identity && seenCacheIdentities.has(identity)) {
      warmCandidates += 1;
      if (record.cachedInputTokens > 0) warmHits += 1;
      else warmMisses += 1;
    }
    if (identity) seenCacheIdentities.add(identity);
  }

  for (const record of ordered) {
    if (
      record.requestPromptCacheKey
      && record.responsePromptCacheKey
      && record.requestPromptCacheKey !== record.responsePromptCacheKey
    ) {
      promptCacheKeyMismatchCount += 1;
    }
    for (const finding of record.entropyFindings ?? []) {
      entropyCounts.set(finding.kind, (entropyCounts.get(finding.kind) ?? 0) + 1);
    }
    for (const reason of record.driftReasons ?? []) {
      driftCounts.set(reason.key, (driftCounts.get(reason.key) ?? 0) + 1);
    }
  }

  const denominator = warmHits + warmMisses;
  const latest = ordered[ordered.length - 1];
  return {
    totalRecords: ordered.length,
    warmCandidates,
    warmHits,
    warmMisses,
    hitRatePercent: denominator > 0 ? Math.round((warmHits / denominator) * 1000) / 10 : 0,
    latestSessionId: latest?.sessionId,
    latestFingerprint: latest?.stablePrefixFingerprint,
    topEntropyKinds: topCounts(entropyCounts),
    topDriftKeys: topCounts(driftCounts),
    responsePromptCacheKeyRewriteCount: promptCacheKeyMismatchCount,
    promptCacheKeyMismatchCount,
  };
}

export function buildCacheAuditSnapshot(params: {
  envelope: HostRequestEnvelope;
  sessionId: string;
  model: string;
  stream: boolean;
  originalRequestPromptCacheKey?: string | null;
  requestPromptCacheKey?: string | null;
}): CacheAuditSnapshot {
  const stablePrefixContract = extractStablePrefixContract(params.envelope);
  const serialized = serializeStablePrefixContract(stablePrefixContract);
  return {
    sessionId: params.sessionId,
    model: params.model,
    stream: params.stream,
    stablePrefixFingerprint: fingerprintStablePrefixEnvelope(params.envelope),
    stablePrefix: serialized,
    entropyFindings: auditStablePrefixEntropy(serialized),
    driftReasons: [],
    originalRequestPromptCacheKey:
      typeof params.originalRequestPromptCacheKey === "string" && params.originalRequestPromptCacheKey.trim()
        ? params.originalRequestPromptCacheKey
        : null,
    requestPromptCacheKey: typeof params.requestPromptCacheKey === "string" && params.requestPromptCacheKey.trim()
      ? params.requestPromptCacheKey
      : null,
  };
}

export async function appendCacheAuditRecord<T extends CacheAuditRecord>(params: {
  stateDir: string;
  snapshot: CacheAuditSnapshot;
  responsePromptCacheKey?: string | null;
  usage?: Record<string, unknown> | null;
  status: number;
}): Promise<T> {
  await mkdir(params.stateDir, { recursive: true });
  const previousEntries = await readRecentCacheAuditRecords<T>(params.stateDir, 32);
  const identity = cacheIdentity(params.snapshot);
  const previousByIdentity = previousEntries.find((entry) => {
    if (!identity) return false;
    return cacheIdentity(entry) === identity;
  });
  const normalizedRequestPromptCacheKey = params.snapshot.requestPromptCacheKey?.trim() || "";
  const previousByRequestPromptCacheKey = normalizedRequestPromptCacheKey
    ? previousEntries.find((entry) => entry.requestPromptCacheKey?.trim() === normalizedRequestPromptCacheKey)
    : undefined;
  const previousBySession = previousEntries.find((entry) => entry.sessionId === params.snapshot.sessionId);
  const previous = previousByIdentity
    ?? previousByRequestPromptCacheKey
    ?? (normalizedRequestPromptCacheKey ? undefined : previousBySession);
  const baselineKind: CacheAuditBaselineKind =
    previousByIdentity
      ? "identity"
      : previousByRequestPromptCacheKey
        ? "request_key"
        : previous
          ? "session"
          : "none";
  const record = {
    at: new Date().toISOString(),
    ...params.snapshot,
    driftReasons: previous
      ? diffStablePrefixSerialized(previous.stablePrefix, params.snapshot.stablePrefix)
      : [],
    responsePromptCacheKey:
      typeof params.responsePromptCacheKey === "string" && params.responsePromptCacheKey.trim()
        ? params.responsePromptCacheKey
        : null,
    cachedInputTokens: readCachedInputTokens(params.usage),
    usage: params.usage ?? null,
    status: params.status,
    baselineKind,
  } satisfies CacheAuditRecord;
  await Promise.all([
    appendJsonl(cacheAuditPath(params.stateDir), record),
    appendJsonl(cacheAuditSessionPath(params.stateDir, params.snapshot.sessionId), record),
  ]);
  return record as T;
}
