import { join } from "node:path";
import { appendJsonl, readJsonFile, writeJsonFileAtomic } from "./file-store.js";

export type UxCountMode = "openai_tokens" | "chars";

export type UxEffectRecord = {
  at: string;
  sessionId: string;
  model: string;
  countMode: UxCountMode;
  beforeCount: number;
  afterCount: number;
  savedCount: number;
  details?: {
    requestSavedCount?: number;
    responseSavedCount?: number;
  };
};

export type UxSessionAggregate = {
  sessionId: string;
  turns: number;
  latestCountMode?: UxCountMode;
  tokenOptimizedTurns: number;
  tokenSavedCount: number;
  avgSavedTokensPerOptimizedTurn: number;
  charOptimizedTurns: number;
  charSavedCount: number;
  avgSavedCharsPerOptimizedTurn: number;
  latestAt?: string;
};

export function latestUxEffectPath(stateDir: string): string {
  return join(stateDir, "ux-effects", "latest.json");
}

export function sessionUxAggregatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, "ux-effects", "sessions", `${sessionId}.json`);
}

export function uxHistoryPath(stateDir: string): string {
  return join(stateDir, "ux-effects", "history.jsonl");
}

function emptyAggregate(sessionId: string): UxSessionAggregate {
  return {
    sessionId,
    turns: 0,
    tokenOptimizedTurns: 0,
    tokenSavedCount: 0,
    avgSavedTokensPerOptimizedTurn: 0,
    charOptimizedTurns: 0,
    charSavedCount: 0,
    avgSavedCharsPerOptimizedTurn: 0,
  };
}

export async function recordUxEffect(
  stateDir: string,
  record: UxEffectRecord,
): Promise<void> {
  await appendJsonl(uxHistoryPath(stateDir), record);
  await writeJsonFileAtomic(latestUxEffectPath(stateDir), record);

  const current = await readJsonFile<UxSessionAggregate>(sessionUxAggregatePath(stateDir, record.sessionId))
    ?? emptyAggregate(record.sessionId);

  current.turns += 1;
  current.latestCountMode = record.countMode;
  if (record.countMode === "openai_tokens") {
    if (record.savedCount > 0) current.tokenOptimizedTurns += 1;
    current.tokenSavedCount += record.savedCount;
    current.avgSavedTokensPerOptimizedTurn = current.tokenOptimizedTurns > 0
      ? Math.round(current.tokenSavedCount / current.tokenOptimizedTurns)
      : 0;
  } else {
    if (record.savedCount > 0) current.charOptimizedTurns += 1;
    current.charSavedCount += record.savedCount;
    current.avgSavedCharsPerOptimizedTurn = current.charOptimizedTurns > 0
      ? Math.round(current.charSavedCount / current.charOptimizedTurns)
      : 0;
  }
  current.latestAt = record.at;

  await writeJsonFileAtomic(sessionUxAggregatePath(stateDir, record.sessionId), current);
}

export async function readLatestUxEffect(
  stateDir: string,
): Promise<UxEffectRecord | null> {
  return readJsonFile<UxEffectRecord>(latestUxEffectPath(stateDir));
}

export async function readUxSessionAggregate(
  stateDir: string,
  sessionId: string,
): Promise<UxSessionAggregate | null> {
  return readJsonFile<UxSessionAggregate>(sessionUxAggregatePath(stateDir, sessionId));
}
