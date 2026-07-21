import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  defaultPluginStateDir,
  pluginStateDirCandidates,
  pluginStateSubdirCandidates,
  pluginStateSubdirWriteTargets,
} from "@lightmem2/artifact-store";

export type CommandScopeBinding = {
  scopeKey: string;
  sessionId: string;
  at: number;
};

function commandScopeMapPathCandidates(stateDir: string): string[] {
  return pluginStateSubdirCandidates(stateDir, "controls", "command-scope-map.json");
}

function normalizeTextPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseSenderMetadataId(text: string): string {
  const match = text.match(/Sender \(untrusted metadata\):\s*```json\s*([\s\S]*?)\s*```/i);
  if (!match) return "";
  try {
    const parsed = JSON.parse(match[1]);
    return normalizeTextPart(parsed?.id);
  } catch {
    return "";
  }
}

export function deriveCommandScopeKeys(value: any, fallbackText?: string): string[] {
  const channel = normalizeTextPart(value?.channel ?? value?.from?.channel);
  const channelId = normalizeTextPart(value?.channelId ?? value?.to?.id ?? value?.conversationId);
  const threadId = normalizeTextPart(value?.messageThreadId ?? value?.threadId);
  const accountId = normalizeTextPart(value?.accountId);
  const senderId =
    normalizeTextPart(value?.senderId ?? value?.from?.id)
    || parseSenderMetadataId(normalizeTextPart(fallbackText ?? ""));

  const keys = [
    [channel, channelId, threadId, accountId, senderId].filter(Boolean).join("|"),
    [channel, channelId, threadId, senderId].filter(Boolean).join("|"),
    [channel, threadId, senderId].filter(Boolean).join("|"),
    [channel, channelId, senderId].filter(Boolean).join("|"),
    [threadId, senderId].filter(Boolean).join("|"),
    [accountId, senderId].filter(Boolean).join("|"),
    [channel, senderId].filter(Boolean).join("|"),
    senderId ? `sender:${senderId}` : "",
  ]
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `command-scope:${item}`);

  return Array.from(new Set(keys));
}

export function loadCommandScopeBindings(stateDir: string): CommandScopeBinding[] {
  for (const path of commandScopeMapPathCandidates(stateDir)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(parsed)) continue;
      const out: CommandScopeBinding[] = [];
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object") continue;
        const scopeKey = normalizeTextPart((entry as any).scopeKey);
        const sessionId = normalizeTextPart((entry as any).sessionId);
        const atRaw = Number((entry as any).at ?? 0);
        const at = Number.isFinite(atRaw) ? atRaw : 0;
        if (!scopeKey || !sessionId || !at) continue;
        out.push({ scopeKey, sessionId, at });
      }
      return out;
    } catch {
      // try next candidate path
    }
  }
  return [];
}

export function persistCommandScopeBindings(stateDir: string, bindings: CommandScopeBinding[]): void {
  try {
    const merged = new Map<string, CommandScopeBinding>();
    const seedDirs = new Set<string>([
      stateDir,
      defaultPluginStateDir(),
      ...pluginStateDirCandidates(),
    ]);

    for (const dir of seedDirs) {
      const normalizedDir = normalizeTextPart(dir);
      if (!normalizedDir) continue;
      for (const entry of loadCommandScopeBindings(normalizedDir)) {
        merged.set(entry.scopeKey, entry);
      }
    }

    for (const entry of bindings) {
      merged.set(entry.scopeKey, entry);
    }

    const payload = JSON.stringify(
      [...merged.values()]
        .sort((a, b) => a.at - b.at)
        .slice(-256),
      null,
      2,
    );

    for (const dir of seedDirs) {
      const normalizedDir = normalizeTextPart(dir);
      if (!normalizedDir) continue;
      for (const path of pluginStateSubdirWriteTargets(normalizedDir, "controls", "command-scope-map.json")) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, payload, "utf8");
      }
    }
  } catch {
    // best effort
  }
}

export function resolveSessionIdFromCommandScope(
  stateDir: string,
  value: any,
  fallbackText?: string,
): string | undefined {
  const keys = deriveCommandScopeKeys(value, fallbackText);
  if (keys.length === 0) return undefined;
  const bindings = loadCommandScopeBindings(stateDir);
  const recentCutoff = Date.now() - 30 * 60 * 1000;

  for (const key of keys) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      if (binding.scopeKey !== key) continue;
      if (binding.at < recentCutoff) continue;
      return binding.sessionId;
    }
  }

  return undefined;
}
