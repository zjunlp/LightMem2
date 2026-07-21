import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export function proceduralMemoryRoot(stateDir: string): string {
  return join(stateDir, "procedural-memory");
}

function safeSessionSegment(sessionId: string): string {
  const trimmed = String(sessionId ?? "").trim();
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_") || "unknown-session";
}

export function proceduralMemoryQueuePath(stateDir: string): string {
  return join(proceduralMemoryRoot(stateDir), "queue", "entries.json");
}

export function proceduralMemorySessionRoot(stateDir: string, sessionId: string): string {
  return join(proceduralMemoryRoot(stateDir), "sessions", safeSessionSegment(sessionId));
}

export function proceduralMemoryStorePath(stateDir: string, sessionId: string): string {
  return join(proceduralMemorySessionRoot(stateDir, sessionId), "skills.json");
}

export async function ensureProceduralMemoryDirs(stateDir: string): Promise<void> {
  await mkdir(join(proceduralMemoryRoot(stateDir), "queue"), { recursive: true });
  await mkdir(join(proceduralMemoryRoot(stateDir), "sessions"), { recursive: true });
}

export async function ensureProceduralMemorySessionDirs(stateDir: string, sessionId: string): Promise<void> {
  await ensureProceduralMemoryDirs(stateDir);
  await mkdir(proceduralMemorySessionRoot(stateDir, sessionId), { recursive: true });
}
