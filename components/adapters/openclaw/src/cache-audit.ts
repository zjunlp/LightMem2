import type { HostRequestEnvelope } from "@tokenpilot/host-adapter";
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

export type OpenClawCacheAuditRecord = CacheAuditRecord;
export type OpenClawCacheAuditSummary = CacheAuditSummary;

export async function readRecentOpenClawCacheAuditRecords(
  stateDir: string,
  limit = 32,
): Promise<OpenClawCacheAuditRecord[]> {
  return readRecentCacheAuditRecords<OpenClawCacheAuditRecord>(stateDir, limit);
}

export async function readRecentOpenClawCacheAuditRecordsForSession(
  stateDir: string,
  sessionId: string,
  limit = 32,
): Promise<OpenClawCacheAuditRecord[]> {
  return readRecentCacheAuditRecordsForSession<OpenClawCacheAuditRecord>(stateDir, sessionId, limit);
}

export function summarizeOpenClawCacheAudit(
  records: OpenClawCacheAuditRecord[],
): OpenClawCacheAuditSummary {
  return summarizeCacheAudit(records);
}

export function buildOpenClawCacheAuditSnapshot(params: {
  envelope: HostRequestEnvelope;
  sessionId: string;
  model: string;
  stream: boolean;
  originalRequestPromptCacheKey?: string | null;
  requestPromptCacheKey?: string | null;
}): CacheAuditSnapshot {
  return buildCacheAuditSnapshot(params);
}

export async function appendOpenClawCacheAuditRecord(params: {
  stateDir: string;
  snapshot: CacheAuditSnapshot;
  responsePromptCacheKey?: string | null;
  usage?: Record<string, unknown> | null;
  status: number;
}): Promise<OpenClawCacheAuditRecord> {
  return appendCacheAuditRecord<OpenClawCacheAuditRecord>(params);
}
