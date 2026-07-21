import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { countTextWithPreciseTokens } from "@lightmem2/host-adapter";
import { pluginStateSubdirCandidates, pluginStateSubdirWriteTargets } from "@lightmem2/artifact-store";
import { appendJsonl } from "../../trace/io.js";

export type CountMode = "openai_tokens" | "chars";

export type UxEffectDetails = {
  requestSavedCount?: number;
  responseSavedCount?: number;
};

export type UxEffectRecord = {
  at: string;
  sessionId: string;
  model: string;
  countMode: CountMode;
  beforeCount: number;
  afterCount: number;
  savedCount: number;
  details?: UxEffectDetails;
};

export type UxSessionAggregate = {
  sessionId: string;
  turns: number;
  latestCountMode?: CountMode;
  tokenOptimizedTurns: number;
  tokenSavedCount: number;
  avgSavedTokensPerOptimizedTurn: number;
  charOptimizedTurns: number;
  charSavedCount: number;
  avgSavedCharsPerOptimizedTurn: number;
  latestAt?: string;
};

function canonicalizeInputForUx(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeInputForUx(item));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (key.startsWith("__tokenpilot_")) continue;
      const child = obj[key];
      if (child === undefined || typeof child === "function") continue;
      next[key] = canonicalizeInputForUx(child);
    }
    return next;
  }
  return String(value);
}

export function serializeCanonicalInputForUx(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(canonicalizeInputForUx(input));
}

function latestUxEffectPathCandidates(stateDir: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "ux-effects", "latest.json");
}

function latestUxEffectWriteTargets(stateDir: string): string[] {
  return pluginStateSubdirWriteTargets(stateDir, "ux-effects", "latest.json");
}

function sessionUxAggregatePathCandidates(stateDir: string, sessionId: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "ux-effects", "sessions", `${sessionId}.json`);
}

function sessionUxAggregateWriteTargets(stateDir: string, sessionId: string): string[] {
  return pluginStateSubdirWriteTargets(stateDir, "ux-effects", "sessions", `${sessionId}.json`);
}

export async function countTokensWithFallback(
  model: string,
  text: string,
): Promise<{ count: number; mode: CountMode }> {
  return countTextWithPreciseTokens(model, text);
}

export async function recordUxEffect(
  stateDir: string,
  record: UxEffectRecord,
): Promise<void> {
  for (const historyPath of pluginStateSubdirWriteTargets(stateDir, "ux-effects", "history.jsonl")) {
    await appendJsonl(historyPath, record);
  }

  for (const latestPath of latestUxEffectWriteTargets(stateDir)) {
    await mkdir(dirname(latestPath), { recursive: true });
    await writeFile(latestPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }

  let current: UxSessionAggregate = {
    sessionId: record.sessionId,
    turns: 0,
    tokenOptimizedTurns: 0,
    tokenSavedCount: 0,
    avgSavedTokensPerOptimizedTurn: 0,
    charOptimizedTurns: 0,
    charSavedCount: 0,
    avgSavedCharsPerOptimizedTurn: 0,
  };

  for (const sessionPath of sessionUxAggregatePathCandidates(stateDir, record.sessionId)) {
    try {
      const raw = await readFile(sessionPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        current = {
          sessionId: String(parsed.sessionId ?? record.sessionId),
          turns: Number(parsed.turns ?? 0),
          latestCountMode:
            parsed.latestCountMode === "chars" || parsed.latestCountMode === "openai_tokens"
              ? parsed.latestCountMode
              : "openai_tokens",
          tokenOptimizedTurns: Number(parsed.tokenOptimizedTurns ?? parsed.optimizedTurns ?? 0),
          tokenSavedCount: Number(parsed.tokenSavedCount ?? parsed.savedTokens ?? 0),
          avgSavedTokensPerOptimizedTurn: Number(parsed.avgSavedTokensPerOptimizedTurn ?? 0),
          charOptimizedTurns: Number(parsed.charOptimizedTurns ?? 0),
          charSavedCount: Number(parsed.charSavedCount ?? 0),
          avgSavedCharsPerOptimizedTurn: Number(parsed.avgSavedCharsPerOptimizedTurn ?? 0),
          latestAt: typeof parsed.latestAt === "string" ? parsed.latestAt : undefined,
        };
        break;
      }
    } catch {
      // try next candidate
    }
  }

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

  for (const sessionPath of sessionUxAggregateWriteTargets(stateDir, record.sessionId)) {
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }
}

export async function readLatestUxEffect(stateDir: string): Promise<UxEffectRecord | null> {
  for (const path of latestUxEffectPathCandidates(stateDir)) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as UxEffectRecord;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function readSessionUxAggregate(stateDir: string, sessionId: string): Promise<UxSessionAggregate | null> {
  for (const path of sessionUxAggregatePathCandidates(stateDir, sessionId)) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as UxSessionAggregate;
    } catch {
      // try next candidate
    }
  }
  return null;
}
