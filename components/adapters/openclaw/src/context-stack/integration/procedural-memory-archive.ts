/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSessionTaskRegistry } from "@tokenpilot/history";
import { hashText, pluginStateSubdirCandidates } from "@tokenpilot/artifact-store";

function extractTaskObjective(registry: Awaited<ReturnType<typeof loadSessionTaskRegistry>>, taskId: string): string {
  return String(registry.tasks[taskId]?.objective ?? "").trim();
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function extractLastUserPrompt(input: any, helpers: any): string {
  if (!Array.isArray(input) || input.length === 0) return "";
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role ?? "") !== "user") continue;
    return String(helpers.extractInputText([item]) ?? "").trim();
  }
  return "";
}

function toCanonicalEvictionStableTaskId(taskId: string): string {
  const trimmed = taskId.trim().toLowerCase();
  const norm = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return norm || "main";
}

function collectArchivePaths(state: any, taskId: string, helpers: any): string[] {
  const out: string[] = [];
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const details = helpers.asRecord(message.details);
    const contextSafe = helpers.asRecord(details?.contextSafe);
    const taskIds = Array.isArray(contextSafe?.taskIds)
      ? contextSafe.taskIds.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (!taskIds.includes(taskId)) continue;
    const eviction = helpers.asRecord(contextSafe?.eviction);
    const archivePath = typeof eviction?.archivePath === "string" ? eviction.archivePath.trim() : "";
    if (archivePath) out.push(archivePath);
  }
  return unique(out);
}

export async function resolveTaskArchivePayloads(params: {
  cfg: any;
  sessionId: string;
  state: any;
  taskId: string;
  helpers: any;
}): Promise<Array<{
  sessionId: string;
  taskId: string;
  archivePath: string;
  archiveSourceLabel: string;
  objective: string;
  completionEvidence: string[];
  unresolvedQuestions: string[];
  turnAbsIds: string[];
}>> {
  const { cfg, sessionId, state, taskId, helpers } = params;
  const messagePaths = collectArchivePaths(state, taskId, helpers);
  let archivePaths = messagePaths;

  if (archivePaths.length === 0) {
    const stableTaskId = toCanonicalEvictionStableTaskId(taskId);
    const dataKey = `canonical_task_eviction:${stableTaskId}`;
    const lookupDirs = pluginStateSubdirCandidates(cfg.stateDir, "canonical-eviction", "task");
    let archivePath: string | null = null;
    for (const archiveDir of lookupDirs) {
      const keyPath = join(archiveDir, "keys", `${hashText(dataKey)}.json`);
      try {
        const raw = await readFile(keyPath, "utf8");
        const parsed = JSON.parse(raw) as { dataKey?: string; archivePath?: string };
        if (parsed?.dataKey === dataKey && typeof parsed.archivePath === "string" && parsed.archivePath.trim()) {
          archivePath = parsed.archivePath.trim();
          break;
        }
      } catch {
        // Try aggregate lookup next.
      }
      try {
        const raw = await readFile(join(archiveDir, "key-lookup.json"), "utf8");
        const parsed = JSON.parse(raw) as Record<string, string>;
        const found = typeof parsed[dataKey] === "string" ? parsed[dataKey].trim() : "";
        if (found) {
          archivePath = found;
          break;
        }
      } catch {
        // Try next candidate directory.
      }
    }
    archivePaths = archivePath ? [archivePath] : [];
  }

  if (archivePaths.length === 0) return [];

  const registry = await loadSessionTaskRegistry(cfg.stateDir, sessionId);
  const task = registry.tasks[taskId];
  if (!task) return [];

  return archivePaths.map((archivePath) => ({
    sessionId,
    taskId,
    archivePath,
    archiveSourceLabel: "canonical_task_eviction",
    objective: extractTaskObjective(registry, taskId),
    completionEvidence: [...task.completionEvidence],
    unresolvedQuestions: [...task.unresolvedQuestions],
    turnAbsIds: [...task.span.supportingTurnAbsIds],
  }));
}
