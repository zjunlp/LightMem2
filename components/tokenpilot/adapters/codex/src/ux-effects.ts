import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type CodexUxCountMode = "litellm_tokens" | "chars";

export type CodexUxEffectRecord = {
  at: string;
  sessionId: string;
  model: string;
  countMode: CodexUxCountMode;
  beforeCount: number;
  afterCount: number;
  savedCount: number;
  details?: {
    requestSavedCount?: number;
    responseSavedCount?: number;
  };
};

export type CodexUxSessionAggregate = {
  sessionId: string;
  turns: number;
  latestCountMode?: CodexUxCountMode;
  tokenOptimizedTurns: number;
  tokenSavedCount: number;
  avgSavedTokensPerOptimizedTurn: number;
  charOptimizedTurns: number;
  charSavedCount: number;
  avgSavedCharsPerOptimizedTurn: number;
  latestAt?: string;
};

function latestUxEffectPath(stateDir: string): string {
  return join(stateDir, "ux-effects", "latest.json");
}

function sessionUxAggregatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, "ux-effects", "sessions", `${sessionId}.json`);
}

function historyPath(stateDir: string): string {
  return join(stateDir, "ux-effects", "history.jsonl");
}

async function appendJsonl(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(payload)}\n`;
  await writeFile(path, line, { encoding: "utf8", flag: "a" });
}

export async function recordCodexUxEffect(
  stateDir: string,
  record: CodexUxEffectRecord,
): Promise<void> {
  await appendJsonl(historyPath(stateDir), record);
  await mkdir(dirname(latestUxEffectPath(stateDir)), { recursive: true });
  await writeFile(latestUxEffectPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  let current: CodexUxSessionAggregate = {
    sessionId: record.sessionId,
    turns: 0,
    tokenOptimizedTurns: 0,
    tokenSavedCount: 0,
    avgSavedTokensPerOptimizedTurn: 0,
    charOptimizedTurns: 0,
    charSavedCount: 0,
    avgSavedCharsPerOptimizedTurn: 0,
  };

  try {
    const raw = await readFile(sessionUxAggregatePath(stateDir, record.sessionId), "utf8");
    current = JSON.parse(raw) as CodexUxSessionAggregate;
  } catch {
    // first record
  }

  current.turns += 1;
  current.latestCountMode = record.countMode;
  if (record.countMode === "litellm_tokens") {
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

  await mkdir(dirname(sessionUxAggregatePath(stateDir, record.sessionId)), { recursive: true });
  await writeFile(
    sessionUxAggregatePath(stateDir, record.sessionId),
    `${JSON.stringify(current, null, 2)}\n`,
    "utf8",
  );
}
