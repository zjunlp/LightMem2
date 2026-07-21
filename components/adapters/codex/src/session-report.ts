import {
  readLatestUxEffect,
  readUxSessionAggregate,
} from "@tokenpilot/host-adapter";
import {
  buildBaseSessionOverview,
  resolveBaseSessionTopology,
  renderSessionReport,
} from "@tokenpilot/product-surface";
import { readRecentCodexCacheAuditRecordsForSession, summarizeCodexCacheAudit } from "./cache-audit.js";
import {
  loadCodexRecentTurnBindings,
  loadCodexSessionSnapshot,
  resolveCanonicalCodexSessionId,
} from "./session-state.js";

export type CodexSessionTopology = {
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
  updatedAt?: string;
  turnCount: number;
};

export async function resolveCodexSessionTopology(
  stateDir: string,
  sessionRef?: string,
): Promise<CodexSessionTopology | undefined> {
  const sessionId = await resolveCanonicalCodexSessionId(
    stateDir,
    typeof sessionRef === "string" ? sessionRef.trim() || undefined : undefined,
  );
  if (!sessionId) return undefined;

  const [snapshot, bindings] = await Promise.all([
    loadCodexSessionSnapshot(stateDir, sessionId),
    loadCodexRecentTurnBindings(stateDir, sessionId, 12),
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
    buildExtra: (value) => ({
      lastHookEvent: value?.lastHookEvent,
      lastToolName: value?.lastToolName,
      lastToolInputChars: value?.lastToolInputChars,
      lastToolOutputChars: value?.lastToolOutputChars,
    }),
  });
}

export async function renderCodexSessionReport(stateDir: string, sessionRef?: string): Promise<string> {
  const topology = await resolveCodexSessionTopology(stateDir, sessionRef);
  if (!topology) return "No Codex TokenPilot session data found.";

  const overview = buildBaseSessionOverview(topology);
  const cacheAuditRecords = await readRecentCodexCacheAuditRecordsForSession(stateDir, topology.sessionId, 64);
  const cacheAuditSummary = cacheAuditRecords.length > 0
    ? summarizeCodexCacheAudit(cacheAuditRecords)
    : null;

  return renderSessionReport({
    stateDir,
    title: "TokenPilot Codex report:",
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
