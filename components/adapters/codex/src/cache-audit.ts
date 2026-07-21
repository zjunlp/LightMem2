import type { HostRequestEnvelope } from "@lightmem2/host-adapter";
import {
  appendCacheAuditRecord,
  buildCacheAuditSnapshot,
  readRecentCacheAuditRecords,
  readRecentCacheAuditRecordsForSession,
  summarizeCacheAudit,
  type CacheAuditRecord,
  type CacheAuditSnapshot,
  type CacheAuditSummary,
} from "@lightmem2/stabilizer";

export type CodexCacheAuditRecord = CacheAuditRecord;
export type CodexCacheAuditSummary = CacheAuditSummary;

export async function readRecentCodexCacheAuditRecords(
  stateDir: string,
  limit = 32,
): Promise<CodexCacheAuditRecord[]> {
  return readRecentCacheAuditRecords<CodexCacheAuditRecord>(stateDir, limit);
}

export async function readRecentCodexCacheAuditRecordsForSession(
  stateDir: string,
  sessionId: string,
  limit = 32,
): Promise<CodexCacheAuditRecord[]> {
  return readRecentCacheAuditRecordsForSession<CodexCacheAuditRecord>(stateDir, sessionId, limit);
}

export function summarizeCodexCacheAudit(
  records: CodexCacheAuditRecord[],
): CodexCacheAuditSummary {
  return summarizeCacheAudit(records);
}

export function buildCodexCacheAuditSnapshot(params: {
  envelope: HostRequestEnvelope;
  sessionId: string;
  model: string;
  stream: boolean;
  originalRequestPromptCacheKey?: string | null;
  requestPromptCacheKey?: string | null;
}): CacheAuditSnapshot {
  return buildCacheAuditSnapshot(params);
}

export async function appendCodexCacheAuditRecord(params: {
  stateDir: string;
  snapshot: CacheAuditSnapshot;
  responsePromptCacheKey?: string | null;
  usage?: Record<string, unknown> | null;
  status: number;
}): Promise<CodexCacheAuditRecord> {
  return appendCacheAuditRecord<CodexCacheAuditRecord>(params);
}
