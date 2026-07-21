import {
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@tokenpilot/host-adapter";
import {
  buildBaseSessionOverview,
  resolveBaseSessionTopology,
  renderSessionReport,
  type ProductSurfaceSessionOverviewItem,
} from "@tokenpilot/product-surface";
import {
  readRecentClaudeCodeCacheAuditRecordsForSession,
  summarizeClaudeCodeCacheAudit,
} from "./cache-audit.js";
import {
  loadClaudeCodeRecentTurnBindings,
  loadClaudeCodeSessionSnapshot,
  resolveLatestClaudeCodeSessionId,
} from "./session-state.js";

export type ClaudeCodeSessionTopology = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
  responseChain: string[];
  latestModel?: string;
  workspaceHint?: string;
  lastHookEvent?: string;
  lastToolName?: string;
  lastToolInputChars?: number;
  lastToolOutputChars?: number;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  updatedAt?: string;
  turnCount: number;
};

export async function resolveClaudeCodeSessionTopology(
  stateDir: string,
  sessionRef?: string,
): Promise<ClaudeCodeSessionTopology | undefined> {
  const sessionId = (typeof sessionRef === "string" ? sessionRef.trim() || undefined : undefined)
    ?? await resolveLatestClaudeCodeSessionId(stateDir);
  if (!sessionId) return undefined;

  const [snapshot, bindings] = await Promise.all([
    loadClaudeCodeSessionSnapshot(stateDir, sessionId),
    loadClaudeCodeRecentTurnBindings(stateDir, sessionId, 12),
  ]);
  if (!snapshot && bindings.length === 0) return undefined;

  return resolveBaseSessionTopology({
    sessionId,
    snapshot,
    bindings,
    getSnapshotLatestResponseId: (value) => value?.latestResponseId,
    getBindingResponseId: (value) => value?.responseId,
    getSnapshotPreviousResponseId: (value) => value?.previousResponseId,
    getBindingPreviousResponseId: (value) => value?.previousResponseId,
    getSnapshotModel: (value) => value?.latestModel,
    getBindingModel: (value) => value?.model,
    getSnapshotWorkspaceHint: (value) => value?.workspaceHint,
    getSnapshotUpdatedAt: (value) => value?.updatedAt,
    getBindingUpdatedAt: (value) => value?.updatedAt,
    buildExtra: (value, latestBinding) => ({
      lastHookEvent: value?.lastHookEvent,
      lastToolName: value?.lastToolName,
      lastToolInputChars: value?.lastToolInputChars,
      lastToolOutputChars: value?.lastToolOutputChars,
      requestChars: value?.requestChars ?? latestBinding?.requestChars,
      responseChars: value?.responseChars ?? latestBinding?.responseChars,
      assistantChars: value?.assistantChars ?? latestBinding?.assistantChars,
      reductionSavedChars: value?.reductionSavedChars ?? latestBinding?.reductionSavedChars,
    }),
  });
}

export async function renderClaudeCodeSessionReport(stateDir: string, sessionRef?: string): Promise<string> {
  const topology = await resolveClaudeCodeSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Claude Code TokenPilot session data found.";

  const overview: ProductSurfaceSessionOverviewItem[] = buildBaseSessionOverview(topology, [
    { label: "Latest request chars", value: topology.requestChars ?? 0 },
    { label: "Latest response chars", value: topology.responseChars ?? 0 },
    { label: "Latest assistant chars", value: topology.assistantChars ?? 0 },
    { label: "Latest reduction savings", value: topology.reductionSavedChars ?? 0 },
  ]);

  if (topology.lastToolName) {
    overview.push({ label: "Last tool", value: topology.lastToolName });
  }
  const cacheAuditRecords = await readRecentClaudeCodeCacheAuditRecordsForSession(stateDir, topology.sessionId, 64);
  const cacheAuditSummary = cacheAuditRecords.length > 0
    ? summarizeClaudeCodeCacheAudit(cacheAuditRecords)
    : null;

  return renderSessionReport({
    stateDir,
    title: "TokenPilot Claude Code report:",
    sessionId: topology.sessionId,
    detailsEnabled: true,
    overview,
    cacheAuditSummary,
    readers: {
      readLatest: readLatestUxEffect,
      readAggregate: readUxSessionAggregate,
    },
  });
}
