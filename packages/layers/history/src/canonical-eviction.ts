/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  archiveContent,
  readArchive,
} from "@tokenpilot/runtime-core";

type RegistryLike = {
  evictableTaskIds: string[];
  tasks?: Record<string, { title?: string; objective?: string }>;
};

type CanonicalTaskArchiveInfo = {
  taskId: string;
  archivePath: string;
  dataKey: string;
  originalSize: number;
};

export type EvictionHelpers = {
  asRecord: (value: unknown) => Record<string, unknown> | undefined;
  appendTaskStateTrace: (stateDir: string, payload: Record<string, unknown>) => Promise<void>;
  canonicalMessageTaskIds: (message: Record<string, unknown>) => string[];
  contentToText: (value: unknown) => string;
  dedupeStrings: (values: string[]) => string[];
  ensureContextSafeDetails: (
    details: unknown,
    patch: Record<string, unknown>,
  ) => Record<string, unknown>;
  extractPathLike: (value: unknown) => string | undefined;
  extractToolMessageText: (message: Record<string, unknown>) => string;
  isToolResultLikeMessage: (message: Record<string, unknown>) => boolean;
  messageToolCallId: (message: Record<string, unknown>) => string | undefined;
  safeId: (value: string) => string;
};

function extractCanonicalProtocolRefs(
  message: Record<string, unknown>,
  helpers: Pick<EvictionHelpers, "asRecord" | "isToolResultLikeMessage" | "messageToolCallId">,
): Array<{ callId: string; kind: "call" | "result" }> {
  const refs: Array<{ callId: string; kind: "call" | "result" }> = [];
  const directCallId = helpers.messageToolCallId(message);
  if (directCallId && helpers.isToolResultLikeMessage(message)) {
    refs.push({ callId: directCallId, kind: "result" });
  }
  const content = Array.isArray(message.content) ? message.content : [];
  for (const rawBlock of content) {
    const block = helpers.asRecord(rawBlock);
    if (!block) continue;
    const type = String(block.type ?? "").toLowerCase();
    if (type === "toolcall" || type === "tool_call" || type === "function_call") {
      const callId = String(block.id ?? block.call_id ?? block.tool_call_id ?? "").trim();
      if (callId) refs.push({ callId, kind: "call" });
      continue;
    }
    if (type === "function_call_output" || type === "tool_call_output" || type === "tool_result") {
      const callId = String(block.call_id ?? block.tool_call_id ?? block.id ?? "").trim();
      if (callId) refs.push({ callId, kind: "result" });
    }
  }
  return refs;
}

export function computeClosureDeferredTaskInfo(
  messages: any[],
  evictableTaskIds: Set<string>,
  helpers: Pick<EvictionHelpers, "asRecord" | "canonicalMessageTaskIds" | "isToolResultLikeMessage" | "messageToolCallId">,
): {
  deferredTaskIds: Set<string>;
  deferredByTaskId: Record<string, Array<{ callId: string; reason: "missing_call" | "missing_result" | "outside_candidate_task" }>>;
} {
  const protocolByCallId = new Map<string, {
    hasCall: boolean;
    hasResult: boolean;
    taskIds: Set<string>;
    hasOutsideCandidateTask: boolean;
  }>();

  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const taskIds = helpers.canonicalMessageTaskIds(message);
    const refs = extractCanonicalProtocolRefs(message, helpers);
    if (refs.length === 0) continue;
    for (const ref of refs) {
      const bucket = protocolByCallId.get(ref.callId) ?? {
        hasCall: false,
        hasResult: false,
        taskIds: new Set<string>(),
        hasOutsideCandidateTask: false,
      };
      if (ref.kind === "call") bucket.hasCall = true;
      if (ref.kind === "result") bucket.hasResult = true;
      if (taskIds.length === 0) {
        bucket.hasOutsideCandidateTask = true;
      } else {
        for (const taskId of taskIds) {
          bucket.taskIds.add(taskId);
          if (!evictableTaskIds.has(taskId)) bucket.hasOutsideCandidateTask = true;
        }
      }
      protocolByCallId.set(ref.callId, bucket);
    }
  }

  const deferred = new Set<string>();
  const deferredByTaskId: Record<string, Array<{ callId: string; reason: "missing_call" | "missing_result" | "outside_candidate_task" }>> = {};
  for (const [callId, protocol] of protocolByCallId.entries()) {
    const protocolTaskIds = [...protocol.taskIds];
    if (protocolTaskIds.length === 0) continue;
    const reasons: Array<"missing_call" | "missing_result" | "outside_candidate_task"> = [];
    if (!protocol.hasCall) reasons.push("missing_call");
    if (!protocol.hasResult) reasons.push("missing_result");
    if (protocol.hasOutsideCandidateTask) reasons.push("outside_candidate_task");
    if (reasons.length === 0) continue;
    for (const taskId of protocolTaskIds) {
      if (!evictableTaskIds.has(taskId)) continue;
      deferred.add(taskId);
      const bucket = deferredByTaskId[taskId] ?? [];
      for (const reason of reasons) bucket.push({ callId, reason });
      deferredByTaskId[taskId] = bucket;
    }
  }
  return { deferredTaskIds: deferred, deferredByTaskId };
}

function parseEvictedTaskIdFromMessage(
  message: Record<string, unknown>,
  contentToText: (value: unknown) => string,
): string | undefined {
  const text = contentToText(message.content);
  const patterns = [
    /\[Completed task paged out: `([^`]+)`\]/,
    /\[Evicted completed task `([^`]+)`\]/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (typeof match?.[1] === "string" && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  return undefined;
}

function truncateInlineLabel(value: string, maxChars = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function humanizeTaskId(taskId: string): string {
  return truncateInlineLabel(
    taskId
      .replace(/^task[_-]/i, "")
      .replace(/[_-]+/g, " ")
      .trim(),
  );
}

function visibleTaskLabel(taskId: string, registry: RegistryLike): string | undefined {
  const task = registry.tasks?.[taskId];
  const title = typeof task?.title === "string" ? truncateInlineLabel(task.title) : "";
  if (title) return title;
  const objective = typeof task?.objective === "string" ? truncateInlineLabel(task.objective) : "";
  if (objective) return objective;
  const fallback = humanizeTaskId(taskId);
  return fallback || undefined;
}

const canonicalEvictionLocks = new Map<string, Promise<void>>();

async function withCanonicalEvictionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = canonicalEvictionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  canonicalEvictionLocks.set(sessionId, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (canonicalEvictionLocks.get(sessionId) === current) {
      canonicalEvictionLocks.delete(sessionId);
    }
  }
}

async function loadCanonicalTaskArchives(
  archiveDir: string,
  sessionId: string,
  asRecord: EvictionHelpers["asRecord"],
): Promise<Map<string, CanonicalTaskArchiveInfo>> {
  const out = new Map<string, CanonicalTaskArchiveInfo>();
  let entries: string[] = [];
  try {
    entries = await readdir(archiveDir);
  } catch {
    return out;
  }

  for (const name of entries.filter((item) => item.endsWith(".json")).sort().reverse()) {
    const archivePath = `${archiveDir}/${name}`;
    const archive = await readArchive(archivePath);
    if (!archive || archive.sessionId !== sessionId) continue;
    const metadata = asRecord(archive.metadata);
    const taskIds = Array.isArray(metadata?.taskIds)
      ? metadata.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    for (const taskId of taskIds) {
      if (out.has(taskId)) continue;
      out.set(taskId, {
        taskId,
        archivePath,
        dataKey: archive.dataKey,
        originalSize: archive.originalSize,
      });
    }
  }
  return out;
}

function canonicalArchiveTextForMessage(
  message: Record<string, unknown>,
  helpers: Pick<EvictionHelpers, "contentToText" | "extractToolMessageText" | "isToolResultLikeMessage">,
): string {
  const role = String(message.role ?? "unknown").trim().toLowerCase() || "unknown";
  const toolName = String(message.toolName ?? message.tool_name ?? "").trim().toLowerCase();
  const text = helpers.isToolResultLikeMessage(message)
    ? helpers.extractToolMessageText(message)
    : helpers.contentToText(message.content);
  const normalizedText = text.trim();
  if (!normalizedText) return "";
  const header = toolName ? `${role}:${toolName}` : role;
  return `[${header}]\n${normalizedText}`;
}

export async function applyCanonicalEviction(params: {
  stateDir: string;
  sessionId: string;
  messages: any[];
  registry: RegistryLike;
  enabled: boolean;
  policy: string;
  minBlockChars: number;
  replacementMode: "pointer_stub" | "drop";
  archiveDir: string;
  persistedBy: string;
  archiveSourceLabel: string;
  helpers: EvictionHelpers;
}): Promise<{ messages: any[]; changed: boolean; appliedCount: number; appliedTaskIds: string[] }> {
  if (!params.enabled) {
    return { messages: params.messages, changed: false, appliedCount: 0, appliedTaskIds: [] };
  }
  const evictableTaskIds = new Set(params.registry.evictableTaskIds);
  if (evictableTaskIds.size === 0) {
    return { messages: params.messages, changed: false, appliedCount: 0, appliedTaskIds: [] };
  }
  return withCanonicalEvictionLock(params.sessionId, async () => {
    const { deferredTaskIds, deferredByTaskId } = computeClosureDeferredTaskInfo(
      params.messages,
      evictableTaskIds,
      params.helpers,
    );
    await params.helpers.appendTaskStateTrace(params.stateDir, {
      stage: "canonical_eviction_closure_checked",
      sessionId: params.sessionId,
      evictableTaskIds: [...evictableTaskIds].sort(),
      deferredTaskIds: [...deferredTaskIds].sort(),
      deferredByTaskId,
      replacementMode: params.replacementMode,
      messageCount: params.messages.length,
    });
    const persistedArchives = await loadCanonicalTaskArchives(
      params.archiveDir,
      params.sessionId,
      params.helpers.asRecord,
    );
    const rolePriority = (message: Record<string, unknown>): number => {
      const role = String(message.role ?? "").trim().toLowerCase();
      if (role === "assistant") return 0;
      if (role === "tool" || role === "toolresult") return 1;
      if (role === "user") return 2;
      return 3;
    };
    const bundles = new Map<string, {
      firstIndex: number;
      representativeIndex: number;
      messageIndexes: number[];
      turnAbsIds: string[];
      taskIds: string[];
      archiveParts: string[];
      totalChars: number;
      alreadyArchived: boolean;
    }>();
    const archivedTaskIds = new Set<string>();
    for (const raw of params.messages) {
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Record<string, unknown>;
      const details = params.helpers.asRecord(message.details);
      const contextSafe = params.helpers.asRecord(details?.contextSafe);
      const skipEviction = params.helpers.asRecord(contextSafe?.eviction)?.skip === true;
      if (skipEviction) continue;
      const existingEviction = params.helpers.asRecord(contextSafe?.eviction);
      if (existingEviction?.archived !== true && existingEviction?.kind !== "cached_pointer_stub") continue;
      const taskIds = Array.isArray(contextSafe?.taskIds)
        ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      for (const taskId of taskIds) archivedTaskIds.add(taskId);
      const parsedTaskId = parseEvictedTaskIdFromMessage(message, params.helpers.contentToText);
      if (parsedTaskId) archivedTaskIds.add(parsedTaskId);
    }
    for (let index = 0; index < params.messages.length; index += 1) {
      const raw = params.messages[index];
      if (!raw || typeof raw !== "object") continue;
      const message = raw as Record<string, unknown>;
      const details = params.helpers.asRecord(message.details);
      const contextSafe = params.helpers.asRecord(details?.contextSafe);
      const skipEviction = params.helpers.asRecord(contextSafe?.eviction)?.skip === true;
      if (skipEviction) continue;
      const taskIds = Array.isArray(contextSafe?.taskIds)
        ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      const matchedTaskIds = taskIds.filter((taskId) => evictableTaskIds.has(taskId));
      if (matchedTaskIds.length !== 1) continue;
      const taskId = matchedTaskIds[0]!;
      if (deferredTaskIds.has(taskId)) continue;
      if (archivedTaskIds.has(taskId)) continue;
      const existingEviction = params.helpers.asRecord(contextSafe?.eviction);
      const bundle = bundles.get(taskId) ?? {
        firstIndex: index,
        representativeIndex: index,
        messageIndexes: [],
        turnAbsIds: [],
        taskIds: [taskId],
        archiveParts: [],
        totalChars: 0,
        alreadyArchived: false,
      };
      bundle.firstIndex = Math.min(bundle.firstIndex, index);
      if (rolePriority(message) < rolePriority((params.messages[bundle.representativeIndex] ?? {}) as Record<string, unknown>)) {
        bundle.representativeIndex = index;
      }
      bundle.messageIndexes.push(index);
      if (typeof contextSafe?.turnAbsId === "string" && contextSafe.turnAbsId.trim().length > 0) {
        bundle.turnAbsIds.push(contextSafe.turnAbsId);
      }
      if (existingEviction?.archived === true || existingEviction?.kind === "cached_pointer_stub") {
        bundle.alreadyArchived = true;
      } else {
        const archiveText = canonicalArchiveTextForMessage(message, params.helpers);
        if (archiveText) {
          bundle.archiveParts.push(archiveText);
          bundle.totalChars += archiveText.length;
        }
      }
      bundles.set(taskId, bundle);
    }

    let changed = false;
    let appliedCount = 0;
    const appliedTaskIds: string[] = [];
    const nextMessages: any[] = [];
    const skipIndexes = new Set<number>();
    const stubByIndex = new Map<number, Record<string, unknown>>();
    for (const [taskId, bundle] of bundles.entries()) {
      if (bundle.alreadyArchived) continue;
      if (bundle.totalChars < params.minBlockChars) continue;
      const normalizedTurns = params.helpers.dedupeStrings(bundle.turnAbsIds);
      const representative = (params.messages[bundle.representativeIndex] ?? {}) as Record<string, unknown>;
      const representativeDetails = params.helpers.asRecord(representative.details);
      const representativeContextSafe = params.helpers.asRecord(representativeDetails?.contextSafe);
      const digest = createHash("sha256").update(bundle.archiveParts.join("\n\n")).digest("hex").slice(0, 16);
      const stableTaskId = params.helpers.safeId(taskId);
      const existingArchive = persistedArchives.get(taskId);
      const dataKey = existingArchive?.dataKey ?? `canonical_task_eviction:${stableTaskId}`;
      const archived = existingArchive
        ? { archivePath: existingArchive.archivePath }
        : await archiveContent({
            sessionId: params.sessionId,
            segmentId: `task-${stableTaskId}`,
            sourcePass: "canonical_eviction",
            toolName: "task",
            dataKey,
            originalText: bundle.archiveParts.join("\n\n"),
            archiveDir: params.archiveDir,
            metadata: {
              contentDigest: digest,
              evictionPolicy: params.policy,
              persistedBy: params.persistedBy,
              taskIds: [taskId],
              turnAbsIds: normalizedTurns,
            },
          });
      const originalSize = existingArchive?.originalSize ?? bundle.totalChars;
      if (params.replacementMode === "pointer_stub") {
        const taskLabel = visibleTaskLabel(taskId, params.registry);
        const stub =
          taskLabel
            ? `[Completed task paged out] We previously completed a task about ${taskLabel}, and it has been paged out from the active context to save space.`
            : `[Completed task paged out] We previously completed an earlier task, and it has been paged out from the active context to save space.`;
        const representativeStopReason =
          typeof representative.stopReason === "string" && representative.stopReason.trim().length > 0
            ? representative.stopReason
            : "stop";
        const representativeMessage = {
          ...representative,
          role: "assistant",
          content: [{ type: "text", text: stub }],
          details: params.helpers.ensureContextSafeDetails(representative.details, {
            turnAbsId: normalizedTurns[0] ?? representativeContextSafe?.turnAbsId,
            taskIds: [taskId],
            eviction: {
              archived: true,
              kind: "cached_pointer_stub",
              archivePath: archived.archivePath,
              dataKey,
              policy: params.policy,
              persistedBy: params.persistedBy,
              scope: "task",
            },
            originalChars: originalSize,
          }),
        };
        stubByIndex.set(bundle.firstIndex, {
          ...representativeMessage,
          stopReason: representativeStopReason,
        });
        for (const idx of bundle.messageIndexes) {
          if (idx === bundle.firstIndex) continue;
          skipIndexes.add(idx);
        }
      } else {
        for (const idx of bundle.messageIndexes) skipIndexes.add(idx);
      }
      changed = true;
      appliedCount += 1;
      appliedTaskIds.push(taskId);
    }

    for (let index = 0; index < params.messages.length; index += 1) {
      const raw = params.messages[index];
      if (skipIndexes.has(index)) continue;
      const stub = stubByIndex.get(index);
      if (stub) {
        nextMessages.push(stub);
        continue;
      }
      nextMessages.push(raw);
    }
    return { messages: nextMessages, changed, appliedCount, appliedTaskIds };
  });
}
