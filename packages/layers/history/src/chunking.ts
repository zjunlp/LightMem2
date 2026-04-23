import type { ContextSegment, RuntimeTurnContext } from "@ecoclaw/kernel";
import type { HistoryBlock, HistoryChunkingConfig, HistoryChunkingResult, HistoryBlockType } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeToolName(metadata: Record<string, unknown> | undefined): string | undefined {
  const toolPayload = asRecord(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName = typeof toolPayload?.toolName === "string" ? toolPayload.toolName : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function extractDataKey(metadata: Record<string, unknown> | undefined): string | undefined {
  const toolPayload = asRecord(metadata?.toolPayload);
  const candidates = [
    metadata?.path,
    metadata?.file_path,
    metadata?.filePath,
    toolPayload?.path,
    toolPayload?.file_path,
    toolPayload?.filePath,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function uniqueNonEmptyStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function extractTurnAbsIds(metadata: Record<string, unknown> | undefined): string[] | undefined {
  if (!metadata) return undefined;
  const candidates: unknown[] = [];
  if (typeof metadata.turnAbsId === "string") candidates.push(metadata.turnAbsId);
  if (Array.isArray(metadata.turnAbsIds)) candidates.push(...metadata.turnAbsIds);
  const toolPayload = asRecord(metadata.toolPayload);
  if (toolPayload) {
    if (typeof toolPayload.turnAbsId === "string") candidates.push(toolPayload.turnAbsId);
    if (Array.isArray(toolPayload.turnAbsIds)) candidates.push(...toolPayload.turnAbsIds);
  }
  const turnAbsIds = uniqueNonEmptyStrings(candidates);
  return turnAbsIds.length > 0 ? turnAbsIds : undefined;
}

function extractTaskIds(metadata: Record<string, unknown> | undefined): string[] | undefined {
  if (!metadata) return undefined;
  const candidates: unknown[] = [];
  if (typeof metadata.taskId === "string") candidates.push(metadata.taskId);
  if (Array.isArray(metadata.taskIds)) candidates.push(...metadata.taskIds);
  const taskState = asRecord(metadata.taskState);
  if (taskState) {
    if (typeof taskState.taskId === "string") candidates.push(taskState.taskId);
    if (Array.isArray(taskState.taskIds)) candidates.push(...taskState.taskIds);
  }
  const toolPayload = asRecord(metadata.toolPayload);
  if (toolPayload) {
    if (typeof toolPayload.taskId === "string") candidates.push(toolPayload.taskId);
    if (Array.isArray(toolPayload.taskIds)) candidates.push(...toolPayload.taskIds);
  }
  const taskIds = uniqueNonEmptyStrings(candidates);
  return taskIds.length > 0 ? taskIds : undefined;
}

function inferBlockType(segment: ContextSegment): HistoryBlockType {
  const metadata = asRecord(segment.metadata);
  const toolName = normalizeToolName(metadata);
  const eviction = asRecord(metadata?.eviction);
  const source = String(segment.source ?? "").toLowerCase();
  const text = segment.text.trim();

  if (source.includes("summary") || source.includes("checkpoint")) return "summary_seed";
  if (
    eviction?.archived === true
    || eviction?.kind === "cached_pointer_stub"
    || /\[(archived|evicted .* block|repeated .* deduplicated|.* output truncated|tool payload trimmed)/i.test(text)
  ) {
    return "pointer_stub";
  }
  if (toolName === "read" || toolName === "exec" || toolName === "web_fetch" || toolName === "web_search") {
    return "tool_result";
  }
  if (toolName === "write" || toolName === "edit" || toolName === "file_write" || toolName === "file_edit") {
    return "write_result";
  }
  if (segment.kind === "stable" || source.includes("system") || source.includes("prompt")) {
    return "system_context";
  }
  if (source.includes("assistant")) {
    return "assistant_reply";
  }
  return "other";
}

function toApproxTokens(chars: number): number {
  return Math.max(0, Math.round(chars / 4));
}

function toBlock(segment: ContextSegment, index: number): HistoryBlock {
  const metadata = asRecord(segment.metadata);
  return {
    blockId: `history-block:${segment.id}`,
    blockType: inferBlockType(segment),
    lifecycleState: "ACTIVE",
    segmentIds: [segment.id],
    text: segment.text,
    charCount: segment.text.length,
    approxTokens: toApproxTokens(segment.text.length),
    createdAt: typeof metadata?.createdAt === "string" ? metadata.createdAt : undefined,
    source: segment.source,
    toolName: normalizeToolName(metadata),
    dataKey: extractDataKey(metadata),
    turnAbsIds: extractTurnAbsIds(metadata),
    taskIds: extractTaskIds(metadata),
    priority: segment.priority,
    metadata: {
      index,
      kind: segment.kind,
      ...(metadata ?? {}),
    },
  };
}

export function buildHistoryBlocks(
  ctx: RuntimeTurnContext,
  _config: HistoryChunkingConfig = {},
): HistoryChunkingResult {
  const blocks = ctx.segments.map((segment, index) => toBlock(segment, index));
  const segmentToBlockId = new Map<string, string>();
  for (const block of blocks) {
    for (const segmentId of block.segmentIds) {
      segmentToBlockId.set(segmentId, block.blockId);
    }
  }
  return { blocks, segmentToBlockId };
}
