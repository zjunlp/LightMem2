import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  RawSemanticSnapshot,
  RawSemanticTurnRecord,
  TurnAnchor,
  TurnAnchorRole,
} from "./types.js";

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function padTurnSeq(turnSeq: number): string {
  return String(Math.max(0, Math.trunc(turnSeq))).padStart(8, "0");
}

export function buildTurnAbsId(sessionId: string, turnSeq: number): string {
  return `${sessionId}:t${Math.max(0, Math.trunc(turnSeq))}`;
}

export function createTurnAnchor(
  sessionId: string,
  turnSeq: number,
  role: TurnAnchorRole,
): TurnAnchor {
  return {
    sessionId,
    turnAbsId: buildTurnAbsId(sessionId, turnSeq),
    turnSeq: Math.max(0, Math.trunc(turnSeq)),
    role,
  };
}

export function rawSemanticTurnRecordPath(stateDir: string, sessionId: string, turnSeq: number): string {
  return join(stateDir, "task-state", safeSessionId(sessionId), "raw-turns", `${padTurnSeq(turnSeq)}.json`);
}

function parseRawSemanticTurnRecord(raw: string): RawSemanticTurnRecord {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("raw semantic turn record must contain a JSON object");
  }
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
  const turnSeq = typeof parsed.turnSeq === "number" ? parsed.turnSeq : -1;
  const turnAbsId = typeof parsed.turnAbsId === "string" ? parsed.turnAbsId : "";
  if (!sessionId || turnSeq < 0 || !turnAbsId) {
    throw new Error("raw semantic turn record missing required identity fields");
  }
  return {
    sessionId,
    turnSeq,
    turnAbsId,
    messages: Array.isArray(parsed.messages) ? (parsed.messages as RawSemanticTurnRecord["messages"]) : [],
    toolCalls: Array.isArray(parsed.toolCalls) ? (parsed.toolCalls as RawSemanticTurnRecord["toolCalls"]) : [],
    toolResults: Array.isArray(parsed.toolResults) ? (parsed.toolResults as RawSemanticTurnRecord["toolResults"]) : [],
  };
}

export async function persistRawSemanticTurnRecord(
  stateDir: string,
  record: RawSemanticTurnRecord,
): Promise<string> {
  const path = rawSemanticTurnRecordPath(stateDir, record.sessionId, record.turnSeq);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
  return path;
}

export async function loadRawSemanticTurnRecord(
  stateDir: string,
  sessionId: string,
  turnSeq: number,
): Promise<RawSemanticTurnRecord | null> {
  const path = rawSemanticTurnRecordPath(stateDir, sessionId, turnSeq);
  try {
    const raw = await readFile(path, "utf8");
    return parseRawSemanticTurnRecord(raw);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }
}

export async function listRawSemanticTurnSeqs(
  stateDir: string,
  sessionId: string,
): Promise<number[]> {
  const dir = join(stateDir, "task-state", safeSessionId(sessionId), "raw-turns");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => Number.parseInt(entry.name.replace(/\.json$/, ""), 10))
      .filter((turnSeq) => Number.isFinite(turnSeq))
      .sort((left, right) => left - right);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw error;
  }
}

export async function loadRawSemanticSnapshotWindow(
  stateDir: string,
  sessionId: string,
  fromTurnSeqExclusive: number,
  toTurnSeqInclusive: number,
): Promise<RawSemanticSnapshot> {
  const messages: RawSemanticSnapshot["messages"] = [];
  const toolCalls: RawSemanticSnapshot["toolCalls"] = [];
  const toolResults: RawSemanticSnapshot["toolResults"] = [];
  let lastTurnSeq = Math.max(0, fromTurnSeqExclusive);

  for (let turnSeq = fromTurnSeqExclusive + 1; turnSeq <= toTurnSeqInclusive; turnSeq += 1) {
    const record = await loadRawSemanticTurnRecord(stateDir, sessionId, turnSeq);
    if (!record) continue;
    messages.push(...record.messages);
    toolCalls.push(...record.toolCalls);
    toolResults.push(...record.toolResults);
    lastTurnSeq = Math.max(lastTurnSeq, record.turnSeq);
  }

  return {
    sessionId,
    lastTurnSeq,
    messages,
    toolCalls,
    toolResults,
  };
}
