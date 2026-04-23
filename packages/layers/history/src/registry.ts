import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  SessionTaskRegistry,
  SessionTaskRegistryPatch,
  TaskState,
} from "./types.js";

function dedupeOrdered(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
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

function cloneTask(task: TaskState): TaskState {
  return {
    ...task,
    ...(typeof task.evictableReason === "string" && task.evictableReason.trim().length > 0
      ? { evictableReason: task.evictableReason }
      : {}),
    completionEvidence: [...task.completionEvidence],
    unresolvedQuestions: [...task.unresolvedQuestions],
    span: {
      ...task.span,
      supportingTurnAbsIds: [...task.span.supportingTurnAbsIds],
    },
  };
}

function cloneRelationMap(map: Record<string, string[]>): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(map)) {
    next[key] = [...values];
  }
  return next;
}

function mergeRelationMap(
  current: Record<string, string[]>,
  patch: Record<string, string[]> | undefined,
): Record<string, string[]> {
  if (!patch) return cloneRelationMap(current);
  const next = cloneRelationMap(current);
  for (const [key, values] of Object.entries(patch)) {
    const normalized = dedupeOrdered(values) ?? [];
    if (normalized.length === 0) {
      delete next[key];
      continue;
    }
    next[key] = normalized;
  }
  return next;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRegistryJson(raw: string): SessionTaskRegistry {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("registry file must contain a JSON object");
  }
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
  if (!sessionId) {
    throw new Error("registry file missing sessionId");
  }
  const registry = createEmptySessionTaskRegistry(sessionId);
  return {
    ...registry,
    ...parsed,
    sessionId,
    version: typeof parsed.version === "number" ? parsed.version : 0,
    tasks: isRecord(parsed.tasks) ? (parsed.tasks as Record<string, TaskState>) : {},
    activeTaskIds: Array.isArray(parsed.activeTaskIds) ? parsed.activeTaskIds.filter((v): v is string => typeof v === "string") : [],
    completedTaskIds: Array.isArray(parsed.completedTaskIds) ? parsed.completedTaskIds.filter((v): v is string => typeof v === "string") : [],
    evictableTaskIds: Array.isArray(parsed.evictableTaskIds) ? parsed.evictableTaskIds.filter((v): v is string => typeof v === "string") : [],
    taskToBlockIds: isRecord(parsed.taskToBlockIds) ? (parsed.taskToBlockIds as Record<string, string[]>) : {},
    blockToTaskIds: isRecord(parsed.blockToTaskIds) ? (parsed.blockToTaskIds as Record<string, string[]>) : {},
    turnToTaskIds: isRecord(parsed.turnToTaskIds) ? (parsed.turnToTaskIds as Record<string, string[]>) : {},
    lastProcessedTurnSeq:
      typeof parsed.lastProcessedTurnSeq === "number" ? parsed.lastProcessedTurnSeq : 0,
  };
}

export class SessionTaskRegistryVersionMismatchError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(`session task registry version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
    this.name = "SessionTaskRegistryVersionMismatchError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export type PersistSessionTaskRegistryOptions = {
  expectedVersion?: number;
};

export function sessionTaskRegistryPath(stateDir: string, sessionId: string): string {
  return join(stateDir, "task-state", safeSessionId(sessionId), "registry.json");
}

export function createEmptySessionTaskRegistry(sessionId: string): SessionTaskRegistry {
  return {
    sessionId,
    version: 0,
    tasks: {},
    activeTaskIds: [],
    completedTaskIds: [],
    evictableTaskIds: [],
    taskToBlockIds: {},
    blockToTaskIds: {},
    turnToTaskIds: {},
    lastProcessedTurnSeq: 0,
  };
}

export function cloneSessionTaskRegistry(registry: SessionTaskRegistry): SessionTaskRegistry {
  const tasks: Record<string, TaskState> = {};
  for (const [taskId, task] of Object.entries(registry.tasks)) {
    tasks[taskId] = cloneTask(task);
  }
  return {
    sessionId: registry.sessionId,
    version: registry.version,
    tasks,
    activeTaskIds: [...registry.activeTaskIds],
    completedTaskIds: [...registry.completedTaskIds],
    evictableTaskIds: [...registry.evictableTaskIds],
    taskToBlockIds: cloneRelationMap(registry.taskToBlockIds),
    blockToTaskIds: cloneRelationMap(registry.blockToTaskIds),
    turnToTaskIds: cloneRelationMap(registry.turnToTaskIds),
    lastProcessedTurnSeq: registry.lastProcessedTurnSeq,
  };
}

export function applySessionTaskRegistryPatch(
  registry: SessionTaskRegistry,
  patch: SessionTaskRegistryPatch,
): SessionTaskRegistry {
  const next = cloneSessionTaskRegistry(registry);

  if (patch.upsertTasks) {
    for (const [taskId, task] of Object.entries(patch.upsertTasks)) {
      next.tasks[taskId] = cloneTask(task);
    }
  }

  if (patch.removeTaskIds) {
    for (const taskId of patch.removeTaskIds) {
      delete next.tasks[taskId];
      delete next.taskToBlockIds[taskId];
    }
  }

  if (patch.activeTaskIds) {
    next.activeTaskIds = dedupeOrdered(patch.activeTaskIds) ?? [];
  }
  if (patch.completedTaskIds) {
    next.completedTaskIds = dedupeOrdered(patch.completedTaskIds) ?? [];
  }
  if (patch.evictableTaskIds) {
    next.evictableTaskIds = dedupeOrdered(patch.evictableTaskIds) ?? [];
  }

  next.taskToBlockIds = mergeRelationMap(next.taskToBlockIds, patch.upsertTaskToBlockIds);
  next.blockToTaskIds = mergeRelationMap(next.blockToTaskIds, patch.upsertBlockToTaskIds);
  next.turnToTaskIds = mergeRelationMap(next.turnToTaskIds, patch.upsertTurnToTaskIds);

  if (typeof patch.lastProcessedTurnSeq === "number") {
    next.lastProcessedTurnSeq = patch.lastProcessedTurnSeq;
  }

  next.version += 1;
  return next;
}

export async function loadSessionTaskRegistry(
  stateDir: string,
  sessionId: string,
): Promise<SessionTaskRegistry> {
  const path = sessionTaskRegistryPath(stateDir, sessionId);
  try {
    const raw = await readFile(path, "utf8");
    return parseRegistryJson(raw);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return createEmptySessionTaskRegistry(sessionId);
    }
    throw error;
  }
}

export async function persistSessionTaskRegistry(
  stateDir: string,
  registry: SessionTaskRegistry,
  options: PersistSessionTaskRegistryOptions = {},
): Promise<string> {
  const path = sessionTaskRegistryPath(stateDir, registry.sessionId);
  if (typeof options.expectedVersion === "number") {
    const current = await loadSessionTaskRegistry(stateDir, registry.sessionId);
    if (current.version !== options.expectedVersion) {
      throw new SessionTaskRegistryVersionMismatchError(options.expectedVersion, current.version);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
  return path;
}
