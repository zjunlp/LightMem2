import type { RuntimeTurnContext } from "@ecoclaw/kernel";
import type { TurnLocalCandidate } from "./types.js";
import { hashText } from "./archive.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeToolName(metadata: Record<string, unknown> | undefined): string | undefined {
  const toolPayload = asObject(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName =
    typeof toolPayload?.toolName === "string" ? (toolPayload.toolName as string) : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function extractDataKey(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const toolPayload = asObject(metadata?.toolPayload);
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
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}

function skipCompaction(metadata: Record<string, unknown> | undefined): boolean {
  const recovery = asObject(metadata?.recovery);
  return recovery?.skipCompaction === true;
}

function isSuccessfulWriteLike(text: string): boolean {
  const lowered = text.toLowerCase();
  if (/successfully (wrote|updated|edited|applied)/i.test(text)) return true;
  if (lowered.includes('"status":"success"') || lowered.includes('"status": "success"')) return true;
  if (lowered.includes("'status': 'success'")) return true;
  return false;
}

/**
 * Detects read operations that have been "consumed" by subsequent write operations.
 *
 * Strategy (方案 4 - simple heuristic):
 * - When a write is detected, compact ALL read results that appeared before it
 * - This assumes writes "consume" the context from prior reads
 * - Window is unlimited: compact ALL reads before a write (not just recent N turns)
 * - No "first read protection" - if a write happened, all prior reads are assumed consumed
 */
export function detectConsumedReads(
  ctx: RuntimeTurnContext,
  policyCandidateMessageIds?: string[],
): TurnLocalCandidate[] {
  const candidates: TurnLocalCandidate[] = [];
  const processedReads = new Set<number>();

  // Build a set of segment IDs that policy has marked as candidates
  const policyCandidateSet = policyCandidateMessageIds
    ? new Set(policyCandidateMessageIds)
    : null;

  // Find all reads in the context
  const readIndices: number[] = [];
  for (let i = 0; i < ctx.segments.length; i += 1) {
    const segment = ctx.segments[i];
    const meta = asObject(segment.metadata);
    if (skipCompaction(meta)) continue;
    const tool = normalizeToolName(meta);
    if (tool !== "read" && tool !== "exec") continue;
    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;
    readIndices.push(i);
  }

  // Find all writes in the context
  const writeIndices: number[] = [];
  for (let i = 0; i < ctx.segments.length; i += 1) {
    const segment = ctx.segments[i];
    const meta = asObject(segment.metadata);
    const tool = normalizeToolName(meta);
    if (tool !== "write" && tool !== "edit") continue;
    if (!isSuccessfulWriteLike(segment.text)) continue;
    writeIndices.push(i);
  }

  if (writeIndices.length === 0 || readIndices.length === 0) {
    return [];
  }

  // For each write, compact all reads that came before it
  for (const writeIndex of writeIndices) {
    for (let i = 0; i < writeIndex; i += 1) {
      if (processedReads.has(i)) continue;

      const segment = ctx.segments[i];
      const meta = asObject(segment.metadata);
      if (skipCompaction(meta)) continue;
      const tool = normalizeToolName(meta);
      if (tool !== "read" && tool !== "exec") continue;

      const dataKey = extractDataKey(meta);
      if (!dataKey) continue;

      if (policyCandidateSet && !policyCandidateSet.has(segment.id)) {
        continue;
      }

      const writeSegment = ctx.segments[writeIndex];
      const writeMeta = asObject(writeSegment.metadata);

      candidates.push({
        sourceIndex: i,
        sourceSegmentId: segment.id,
        sourceToolName: tool,
        sourceDataKey: dataKey,
        sourceText: segment.text,
        writeIndex: writeIndex,
        writeSegmentId: writeSegment.id,
        writeToolName: normalizeToolName(writeMeta) ?? "write_or_edit",
        writeText: writeSegment.text,
      });

      processedReads.add(i);
    }
  }

  return candidates;
}

/**
 * Original repeated-read detection logic - detects when model reads same content multiple times.
 * This is a locality-based signal: if model re-reads same content, it hasn't "consumed" it yet.
 */
export function pickRepeatedReadCandidates(
  ctx: RuntimeTurnContext,
  policyCandidateMessageIds?: string[],
): TurnLocalCandidate[] {
  const candidates: TurnLocalCandidate[] = [];
  const processedReads = new Set<number>();

  const policyCandidateSet = policyCandidateMessageIds
    ? new Set(policyCandidateMessageIds)
    : null;

  // Group reads by content hash (not just path)
  const readsByContentHash = new Map<string, { index: number; dataKey: string; segmentId: string }[]>();

  for (let i = 0; i < ctx.segments.length; i += 1) {
    const segment = ctx.segments[i];
    const meta = asObject(segment.metadata);
    if (skipCompaction(meta)) continue;
    const tool = normalizeToolName(meta);
    if (tool !== "read" && tool !== "exec") continue;
    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;

    const contentHash = hashText(segment.text);
    const hashKey = `${dataKey}:${contentHash}`;

    const existing = readsByContentHash.get(hashKey) ?? [];
    existing.push({ index: i, dataKey, segmentId: segment.id });
    readsByContentHash.set(hashKey, existing);
  }

  for (const [hashKey, readInfos] of readsByContentHash.entries()) {
    if (readInfos.length <= 1) continue;

    const dataKey = readInfos[0].dataKey;
    const readIndices = readInfos.map((r) => r.index);

    if (policyCandidateSet) {
      const hasPolicyCandidate = readInfos.some((r) => policyCandidateSet.has(r.segmentId));
      if (!hasPolicyCandidate) continue;
    }

    const lastReadIndex = readIndices[readIndices.length - 1];
    let firstWriteAfterLastRead = -1;

    for (let j = lastReadIndex + 1; j < ctx.segments.length; j += 1) {
      const writeSeg = ctx.segments[j];
      const writeMeta = asObject(writeSeg.metadata);
      const writeTool = normalizeToolName(writeMeta);
      if (writeTool !== "write" && writeTool !== "edit") continue;
      if (!isSuccessfulWriteLike(writeSeg.text)) continue;
      firstWriteAfterLastRead = j;
      break;
    }

    if (firstWriteAfterLastRead < 0) continue;

    let rereadAfterWrite = false;
    for (let k = firstWriteAfterLastRead + 1; k < ctx.segments.length; k += 1) {
      const check = ctx.segments[k];
      const checkMeta = asObject(check.metadata);
      const checkTool = normalizeToolName(checkMeta);
      if (checkTool !== "read" && checkTool !== "exec") continue;
      const checkDataKey = extractDataKey(checkMeta);
      if (checkDataKey === dataKey && check.text === ctx.segments[lastReadIndex].text) {
        rereadAfterWrite = true;
        break;
      }
    }

    if (rereadAfterWrite) continue;

    for (let idx = 1; idx < readIndices.length; idx += 1) {
      const readIdx = readIndices[idx];
      if (processedReads.has(readIdx)) continue;

      const readSegment = ctx.segments[readIdx];
      const readMeta = asObject(readSegment.metadata);
      if (skipCompaction(readMeta)) continue;

      candidates.push({
        sourceIndex: readIdx,
        sourceSegmentId: readSegment.id,
        sourceToolName: normalizeToolName(readMeta) ?? "read_or_exec",
        sourceDataKey: dataKey,
        sourceText: readSegment.text,
        writeIndex: firstWriteAfterLastRead,
        writeSegmentId: ctx.segments[firstWriteAfterLastRead].id,
        writeToolName: normalizeToolName(asObject(ctx.segments[firstWriteAfterLastRead].metadata)) ?? "write_or_edit",
        writeText: ctx.segments[firstWriteAfterLastRead].text,
      });

      processedReads.add(readIdx);
    }
  }

  return candidates;
}

export function pickTurnLocalCandidates(
  ctx: RuntimeTurnContext,
  policyCandidateMessageIds?: string[],
): TurnLocalCandidate[] {
  const consumedReadCandidates = detectConsumedReads(ctx, policyCandidateMessageIds);
  const repeatedReadCandidates = pickRepeatedReadCandidates(ctx, policyCandidateMessageIds);

  const seenIndices = new Set<number>();
  const allCandidates: TurnLocalCandidate[] = [];

  for (const c of consumedReadCandidates) {
    if (!seenIndices.has(c.sourceIndex)) {
      allCandidates.push(c);
      seenIndices.add(c.sourceIndex);
    }
  }

  for (const c of repeatedReadCandidates) {
    if (!seenIndices.has(c.sourceIndex)) {
      allCandidates.push(c);
      seenIndices.add(c.sourceIndex);
    }
  }

  return allCandidates;
}
