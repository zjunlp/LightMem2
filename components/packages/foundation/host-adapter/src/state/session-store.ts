import { join } from "node:path";
import { appendJsonl, readJsonFile, readRecentJsonlEntries, writeJsonFileAtomic } from "./file-store.js";

export type TokenPilotLatestSessionRef = {
  sessionId: string;
  updatedAt: string;
};

function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function sessionStateRoot(stateDir: string): string {
  return join(stateDir, "session-state");
}

export function sessionSnapshotPath(stateDir: string, sessionId: string): string {
  return join(sessionStateRoot(stateDir), "sessions", `${encodeSessionId(sessionId)}.json`);
}

export function recentTurnBindingsPath(stateDir: string, sessionId: string): string {
  return join(sessionStateRoot(stateDir), "bindings", `${encodeSessionId(sessionId)}.jsonl`);
}

export function latestSessionPath(stateDir: string): string {
  return join(sessionStateRoot(stateDir), "latest.json");
}

export async function writeLatestSessionRef(
  stateDir: string,
  sessionId: string,
  updatedAt: string,
): Promise<void> {
  await writeJsonFileAtomic(latestSessionPath(stateDir), {
    sessionId,
    updatedAt,
  } satisfies TokenPilotLatestSessionRef);
}

export async function readLatestSessionRef(
  stateDir: string,
): Promise<TokenPilotLatestSessionRef | null> {
  return readJsonFile<TokenPilotLatestSessionRef>(latestSessionPath(stateDir));
}

export async function resolveLatestSessionId(stateDir: string): Promise<string | undefined> {
  const latest = await readLatestSessionRef(stateDir);
  const sessionId = typeof latest?.sessionId === "string" ? latest.sessionId.trim() : "";
  return sessionId || undefined;
}

export async function loadSessionSnapshot<T>(
  stateDir: string,
  sessionId: string,
): Promise<T | null> {
  return readJsonFile<T>(sessionSnapshotPath(stateDir, sessionId));
}

export async function writeSessionSnapshot<T>(
  stateDir: string,
  sessionId: string,
  payload: T,
): Promise<void> {
  await writeJsonFileAtomic(sessionSnapshotPath(stateDir, sessionId), payload);
}

export async function appendRecentTurnBinding<T extends { sessionId: string; updatedAt: string }>(
  stateDir: string,
  binding: T,
): Promise<void> {
  await appendJsonl(recentTurnBindingsPath(stateDir, binding.sessionId), binding);
  await writeLatestSessionRef(stateDir, binding.sessionId, binding.updatedAt);
}

export async function loadRecentTurnBindings<T>(
  stateDir: string,
  sessionId: string,
  limit = 8,
  isEntry?: (value: unknown) => value is T,
): Promise<T[]> {
  return readRecentJsonlEntries<T>(recentTurnBindingsPath(stateDir, sessionId), limit, isEntry);
}
