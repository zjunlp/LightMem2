import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  defaultPluginStateDir,
  pluginStateDirCandidates,
  pluginStateSubdir,
  pluginStateSubdirCandidates,
  pluginStateSubdirWriteTargets,
} from "@lightmem2/artifact-store";

export type RecentTurnBinding = {
  userMessage: string;
  matchKey: string;
  sessionKey: string;
  upstreamSessionId?: string;
  at: number;
};

function recentTurnBindingsPath(stateDir: string): string {
  return pluginStateSubdir(stateDir, "controls", "recent-turn-bindings.json");
}

function recentTurnBindingsPathCandidates(stateDir: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "controls", "recent-turn-bindings.json");
}

export function loadRecentTurnBindingsFromState(
  stateDir: string,
  normalizeTurnBindingMessage: (text: string) => string,
): RecentTurnBinding[] {
  for (const path of recentTurnBindingsPathCandidates(stateDir)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) continue;
      const out: RecentTurnBinding[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const userMessage = String((entry as any).userMessage ?? "").trim();
        const matchKey =
          String((entry as any).matchKey ?? "").trim() || normalizeTurnBindingMessage(userMessage);
        const sessionKey = String((entry as any).sessionKey ?? "").trim();
        const upstreamSessionId = String((entry as any).upstreamSessionId ?? "").trim() || undefined;
        const atRaw = Number((entry as any).at ?? 0);
        const at = Number.isFinite(atRaw) ? atRaw : 0;
        if (!userMessage || !matchKey || !sessionKey || !at) continue;
        out.push({ userMessage, matchKey, sessionKey, upstreamSessionId, at });
      }
      return out;
    } catch {
      // Try next candidate path.
    }
  }
  return [];
}

export function persistRecentTurnBindingsToState(stateDir: string, bindings: RecentTurnBinding[]): void {
  try {
    const merged = new Map<string, RecentTurnBinding>();
    const seedDirs = new Set<string>([
      stateDir,
      defaultPluginStateDir(),
      ...pluginStateDirCandidates(),
    ]);

    for (const dir of seedDirs) {
      if (!dir) continue;
      for (const entry of loadRecentTurnBindingsFromState(dir, (text) => text)) {
        const key = `${entry.at}:${entry.sessionKey}:${entry.upstreamSessionId ?? ""}:${entry.matchKey}`;
        merged.set(key, entry);
      }
    }

    for (const entry of bindings) {
      const key = `${entry.at}:${entry.sessionKey}:${entry.upstreamSessionId ?? ""}:${entry.matchKey}`;
      merged.set(key, entry);
    }

    const payload = JSON.stringify(
      [...merged.values()]
        .sort((a, b) => a.at - b.at)
        .slice(-128),
      null,
      2,
    );

    for (const dir of seedDirs) {
      if (!dir) continue;
      for (const path of pluginStateSubdirWriteTargets(dir, "controls", "recent-turn-bindings.json")) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, payload, "utf8");
      }
    }
  } catch {
    // Best-effort only: provider-side lookup can still rely on in-memory bindings if persistence fails.
  }
}
