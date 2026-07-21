import {
  appendRecentTurnBinding,
  loadRecentTurnBindings,
  loadSessionSnapshot,
  resolveLatestSessionId,
  writeLatestSessionRef,
  writeSessionSnapshot,
} from "@lightmem2/host-adapter";

export type ClaudeCodeSessionSnapshot = {
  sessionId: string;
  latestResponseId?: string;
  previousResponseId?: string;
  latestModel?: string;
  workspaceHint?: string;
  disclosedReadPaths?: string[];
  lastHookEvent?: string;
  lastToolName?: string;
  lastToolInputChars?: number;
  lastToolOutputChars?: number;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  updatedAt: string;
};

export type ClaudeCodeRecentTurnBinding = {
  sessionId: string;
  responseId?: string;
  previousResponseId?: string;
  model?: string;
  requestChars?: number;
  responseChars?: number;
  assistantChars?: number;
  reductionSavedChars?: number;
  stablePrefixApplied?: boolean;
  reductionApplied?: boolean;
  stream?: boolean;
  updatedAt: string;
};

async function markLatestSession(stateDir: string, sessionId: string, updatedAt: string): Promise<void> {
  await writeLatestSessionRef(stateDir, sessionId, updatedAt);
}

export async function loadClaudeCodeSessionSnapshot(
  stateDir: string,
  sessionId: string,
): Promise<ClaudeCodeSessionSnapshot | null> {
  return loadSessionSnapshot<ClaudeCodeSessionSnapshot>(stateDir, sessionId);
}

export async function upsertClaudeCodeSessionSnapshot(
  stateDir: string,
  sessionId: string,
  patch: Partial<ClaudeCodeSessionSnapshot>,
): Promise<ClaudeCodeSessionSnapshot> {
  const current = await loadClaudeCodeSessionSnapshot(stateDir, sessionId);
  const updatedAt = new Date().toISOString();
  const next: ClaudeCodeSessionSnapshot = {
    sessionId,
    latestResponseId: patch.latestResponseId ?? current?.latestResponseId,
    previousResponseId: patch.previousResponseId ?? current?.previousResponseId,
    latestModel: patch.latestModel ?? current?.latestModel,
    workspaceHint: patch.workspaceHint ?? current?.workspaceHint,
    disclosedReadPaths: patch.disclosedReadPaths ?? current?.disclosedReadPaths,
    lastHookEvent: patch.lastHookEvent ?? current?.lastHookEvent,
    lastToolName: patch.lastToolName ?? current?.lastToolName,
    lastToolInputChars: patch.lastToolInputChars ?? current?.lastToolInputChars,
    lastToolOutputChars: patch.lastToolOutputChars ?? current?.lastToolOutputChars,
    requestChars: patch.requestChars ?? current?.requestChars,
    responseChars: patch.responseChars ?? current?.responseChars,
    assistantChars: patch.assistantChars ?? current?.assistantChars,
    reductionSavedChars: patch.reductionSavedChars ?? current?.reductionSavedChars,
    updatedAt,
  };
  await writeSessionSnapshot(stateDir, sessionId, next);
  await markLatestSession(stateDir, sessionId, updatedAt);
  return next;
}

export async function appendClaudeCodeRecentTurnBinding(
  stateDir: string,
  binding: ClaudeCodeRecentTurnBinding,
): Promise<void> {
  await appendRecentTurnBinding(stateDir, binding);
}

export async function loadClaudeCodeRecentTurnBindings(
  stateDir: string,
  sessionId: string,
  limit = 8,
): Promise<ClaudeCodeRecentTurnBinding[]> {
  return loadRecentTurnBindings<ClaudeCodeRecentTurnBinding>(
    stateDir,
    sessionId,
    limit,
    (entry): entry is ClaudeCodeRecentTurnBinding =>
      Boolean(entry && typeof entry === "object" && typeof (entry as { sessionId?: unknown }).sessionId === "string"),
  );
}

export async function resolveLatestClaudeCodeSessionId(stateDir: string): Promise<string | undefined> {
  return resolveLatestSessionId(stateDir);
}
