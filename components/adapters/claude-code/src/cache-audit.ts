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
} from "@tokenpilot/stabilizer";

export type ClaudeCodeCacheAuditRecord = CacheAuditRecord;
export type ClaudeCodeCacheAuditSummary = CacheAuditSummary;

export async function readRecentClaudeCodeCacheAuditRecords(
  stateDir: string,
  limit = 32,
): Promise<ClaudeCodeCacheAuditRecord[]> {
  return readRecentCacheAuditRecords<ClaudeCodeCacheAuditRecord>(stateDir, limit);
}

export async function readRecentClaudeCodeCacheAuditRecordsForSession(
  stateDir: string,
  sessionId: string,
  limit = 32,
): Promise<ClaudeCodeCacheAuditRecord[]> {
  return readRecentCacheAuditRecordsForSession<ClaudeCodeCacheAuditRecord>(stateDir, sessionId, limit);
}

export function summarizeClaudeCodeCacheAudit(
  records: ClaudeCodeCacheAuditRecord[],
): ClaudeCodeCacheAuditSummary {
  return summarizeCacheAudit(records);
}

export function buildClaudeCodeCacheAuditSnapshot(params: {
  envelope: HostRequestEnvelope;
  sessionId: string;
  model: string;
  stream: boolean;
  originalRequestPromptCacheKey?: string | null;
  requestPromptCacheKey?: string | null;
}): CacheAuditSnapshot {
  return buildCacheAuditSnapshot(params);
}

export async function appendClaudeCodeCacheAuditRecord(params: {
  stateDir: string;
  snapshot: CacheAuditSnapshot;
  responsePromptCacheKey?: string | null;
  usage?: Record<string, unknown> | null;
  status: number;
}): Promise<ClaudeCodeCacheAuditRecord> {
  return appendCacheAuditRecord<ClaudeCodeCacheAuditRecord>(params);
}
