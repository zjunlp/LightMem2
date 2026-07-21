/* eslint-disable @typescript-eslint/no-explicit-any */
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type CanonicalTranscriptState = {
  version: 1;
  sessionId: string;
  messages: any[];
  seenMessageIds: string[];
  updatedAt: string;
};

export function canonicalStateDir(stateDir: string): string {
  return join(stateDir, "tokenpilot", "canonical-state");
}

export function canonicalStatePathCandidates(stateDir: string, sessionId: string): string[] {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return [join(stateDir, "tokenpilot", "canonical-state", `${safeSessionId}.json`)];
}

export function canonicalStatePath(stateDir: string, sessionId: string): string {
  const safeSessionId = String(sessionId || "session").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(canonicalStateDir(stateDir), `${safeSessionId}.json`);
}

export async function loadCanonicalState(stateDir: string, sessionId: string): Promise<CanonicalTranscriptState | null> {
  for (const path of canonicalStatePathCandidates(stateDir, sessionId)) {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as CanonicalTranscriptState;
      if (!parsed || parsed.version !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.messages)) {
        continue;
      }
      const seenMessageIds = Array.isArray((parsed as any).seenMessageIds)
        ? ((parsed as any).seenMessageIds as unknown[])
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      return {
        version: 1,
        sessionId: parsed.sessionId,
        messages: parsed.messages,
        seenMessageIds,
        updatedAt: parsed.updatedAt,
      };
    } catch {
      // Try next candidate path.
    }
  }
  return null;
}

export async function saveCanonicalState(stateDir: string, state: CanonicalTranscriptState): Promise<void> {
  const payload = JSON.stringify(state, null, 2);
  const path = canonicalStatePath(stateDir, state.sessionId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, payload, "utf8");
}

export function estimateMessagesChars(messages: any[], contentToText: (value: unknown) => string): number {
  return messages.reduce((sum, msg) => sum + contentToText(msg?.content ?? "").length, 0);
}

export function appendCanonicalTranscript<TEntry>(
  loaded: CanonicalTranscriptState | null,
  transcriptEntries: TEntry[],
  sessionId: string,
  getMessage: (entry: TEntry) => any,
  stableIdForEntry: (entry: TEntry) => string,
): { state: CanonicalTranscriptState; changed: boolean } {
  const rawEntries = Array.isArray(transcriptEntries) ? structuredClone(transcriptEntries) : [];
  if (!loaded) {
    return {
      state: {
        version: 1,
        sessionId,
        messages: rawEntries.map((entry) => getMessage(entry)),
        seenMessageIds: rawEntries.map(stableIdForEntry),
        updatedAt: new Date().toISOString(),
      },
      changed: true,
    };
  }

  const seen = new Set(
    Array.isArray(loaded.seenMessageIds)
      ? loaded.seenMessageIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [],
  );
  const newMessages: any[] = [];
  const newIds: string[] = [];
  for (const entry of rawEntries) {
    const stableId = stableIdForEntry(entry);
    if (seen.has(stableId)) continue;
    seen.add(stableId);
    newIds.push(stableId);
    newMessages.push(getMessage(entry));
  }
  if (newMessages.length === 0) {
    return {
      state: {
        ...loaded,
        updatedAt: loaded.updatedAt,
      },
      changed: false,
    };
  }

  return {
    state: {
      version: 1,
      sessionId,
      messages: [...loaded.messages, ...newMessages],
      seenMessageIds: [...(Array.isArray(loaded.seenMessageIds) ? loaded.seenMessageIds : []), ...newIds],
      updatedAt: new Date().toISOString(),
    },
    changed: true,
  };
}
