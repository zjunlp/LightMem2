import { createHash } from "node:crypto";
import type { ContextSegment } from "@lightmem2/kernel";
import type { ReductionDecision, ReductionInstruction } from "../decision-types.js";

// ============================================================================
// Types
// ============================================================================

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

type ReadSegmentInfo = {
  index: number;
  segmentId: string;
  toolName: string;
  dataKey?: string;
  readKey: string;
  contentHash: string;
  chars: number;
  state: "fresh" | "superseded" | "stale";
  reason: "later_read" | "later_mutation" | "none";
  triggeringIndex?: number;
};

type ReadEvent = {
  kind: "read";
  segment: ContextSegment;
  index: number;
  dataKey: string;
  readKey: string;
  toolName: string;
};

type FileEvent =
  | ReadEvent
  | {
      kind: "mutate";
      index: number;
      dataKey: string;
      toolName: string;
    };

// ============================================================================
// Utilities
// ============================================================================

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

const hashText = (value: string): string => {
  return createHash("sha256").update(value).digest("hex");
};

const normalizeToolName = (metadata: Record<string, unknown> | undefined): string | undefined => {
  const toolPayload = asObject(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName =
    typeof toolPayload?.toolName === "string" ? (toolPayload.toolName as string) : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const extractDataKey = (metadata: Record<string, unknown> | undefined): string | undefined => {
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
};

const extractReadWindow = (metadata: Record<string, unknown> | undefined): ReadWindow | undefined => {
  const toolPayload = asObject(metadata?.toolPayload);
  const candidate =
    asObject(metadata?.readWindow)
    ?? asObject(toolPayload?.readWindow);
  if (!candidate) return undefined;
  const offset =
    typeof candidate.offset === "number" && Number.isFinite(candidate.offset) && candidate.offset > 0
      ? Math.floor(candidate.offset)
      : undefined;
  const limit =
    typeof candidate.limit === "number" && Number.isFinite(candidate.limit) && candidate.limit > 0
      ? Math.floor(candidate.limit)
      : undefined;
  if (offset == null && limit == null) return undefined;
  return { offset, limit };
};

const buildReadKey = (dataKey: string, readWindow: ReadWindow | undefined): string => {
  const offset = readWindow?.offset;
  const limit = readWindow?.limit;
  if (offset == null && limit == null) return `${dataKey}#full`;
  return `${dataKey}#offset=${offset ?? "?"}:limit=${limit ?? "?"}`;
};

const MUTATING_TOOL_NAMES = new Set([
  "write",
  "edit",
  "apply_patch",
  "file_write",
  "file_edit",
  "str_replace",
  "replace",
]);

type ReadWindow = {
  offset?: number;
  limit?: number;
};

const isReadOutputSegment = (segment: ContextSegment): boolean => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta);
  if (toolName !== "read" && toolName !== "file_read") return false;

  const fieldName =
    typeof meta?.fieldName === "string" ? meta.fieldName.trim().toLowerCase() : undefined;
  if (fieldName === "arguments") return false;
  if (fieldName === "output" || fieldName === "result" || fieldName === "content") return true;

  const segmentId = segment.id.trim().toLowerCase();
  if (segmentId.endsWith("-arguments")) return false;
  if (
    segmentId.endsWith("-output") ||
    segmentId.endsWith("-result") ||
    segmentId.includes("-content")
  ) {
    return true;
  }

  return fieldName === undefined;
};

const isMutatingToolSegment = (segment: ContextSegment): boolean => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta);
  if (!toolName || !MUTATING_TOOL_NAMES.has(toolName)) return false;
  return Boolean(extractDataKey(meta));
};

function classifyReadSegments(
  segments: ContextSegment[],
): Map<string, Pick<ReadSegmentInfo, "state" | "reason" | "triggeringIndex">> {
  const events: FileEvent[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const meta = asObject(segment.metadata);
    const dataKey = extractDataKey(meta);
    const readKey = dataKey ? buildReadKey(dataKey, extractReadWindow(meta)) : undefined;
    const toolName = normalizeToolName(meta) ?? "tool";
    if (!dataKey) continue;

    if (isReadOutputSegment(segment)) {
      events.push({
        kind: "read",
        segment,
        index,
        dataKey,
        readKey: readKey ?? `${dataKey}#full`,
        toolName,
      });
      continue;
    }

    if (isMutatingToolSegment(segment)) {
      events.push({
        kind: "mutate",
        index,
        dataKey,
        toolName,
      });
    }
  }

  const eventsByDataKey = new Map<string, FileEvent[]>();
  for (const event of events) {
    const bucket = eventsByDataKey.get(event.dataKey) ?? [];
    bucket.push(event);
    eventsByDataKey.set(event.dataKey, bucket);
  }

  const stateBySegmentId = new Map<string, Pick<ReadSegmentInfo, "state" | "reason" | "triggeringIndex">>();
  for (const bucket of eventsByDataKey.values()) {
    const reads = bucket.filter((event): event is ReadEvent => event.kind === "read");
    for (const read of reads) {
      let state: ReadSegmentInfo["state"] = "fresh";
      let reason: ReadSegmentInfo["reason"] = "none";
      let triggeringIndex: number | undefined;
      for (const event of bucket) {
        if (event.index <= read.index) continue;
        if (event.kind === "mutate") {
          state = "stale";
          reason = "later_mutation";
          triggeringIndex = event.index;
          break;
        }
        if (event.kind === "read") {
          if (event.readKey !== read.readKey) continue;
          state = "superseded";
          reason = "later_read";
          triggeringIndex = event.index;
          break;
        }
      }
      stateBySegmentId.set(read.segment.id, {
        state,
        reason,
        triggeringIndex,
      });
    }
  }

  return stateBySegmentId;
}

// ============================================================================
// Read-State Compaction Analyzer
// ============================================================================

export type ReadStateCompactionAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<ReadStateCompactionAnalyzerConfig> = {
  enabled: true,
  minChars: 500,
  minSavedChars: 200,
};

/**
 * Analyze context for stale or superseded read state that can be compacted safely.
 *
 * Strategy:
 * - Track read segments by path across later reads and mutations
 * - Mark stale/superseded reads as reduction candidates
 * - Repeated-read dedup is now just one subtype of read-state compaction
 */
export function analyzeReadStateCompaction(
  segments: ContextSegment[],
  config: ReadStateCompactionAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["read_state_compaction_analyzer_disabled"],
    };
  }

  const stateBySegmentId = classifyReadSegments(segments);
  const readsByKey = new Map<string, ReadSegmentInfo[]>();

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);

    if (!isReadOutputSegment(segment)) continue;

    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;
    const classification = stateBySegmentId.get(segment.id);
    if (!classification || classification.state === "fresh") continue;
    if (segment.text.length < cfg.minChars) continue;

    const contentHash = hashText(segment.text);
    const readKey = buildReadKey(dataKey, extractReadWindow(meta));
    const key =
      classification.state === "stale"
        ? `${dataKey}:stale`
        : `${readKey}:superseded`;

    const existing = readsByKey.get(key) ?? [];
    existing.push({
      index: i,
      segmentId: segment.id,
      toolName: tool ?? "read",
      dataKey,
      readKey,
      contentHash,
      chars: segment.text.length,
      state: classification.state,
      reason: classification.reason,
      triggeringIndex: classification.triggeringIndex,
    });
    readsByKey.set(key, existing);
  }

  // Build instructions for groups with stale or superseded reads.
  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const reads of readsByKey.values()) {
    const savedChars = reads.reduce((sum, r) => sum + r.chars, 0);
    if (savedChars < cfg.minSavedChars) continue;

    const dataKey = reads[0]?.dataKey ?? "unknown";
    const state = reads[0]?.state ?? "superseded";
    const reason = reads[0]?.reason ?? "later_read";
    const segmentIds = reads
      .sort((a, b) => a.index - b.index)
      .map((r) => r.segmentId);
    if (segmentIds.length === 0) continue;

    instructions.push({
      strategy: "read_state_compaction",
      segmentIds,
      confidence: state === "stale" ? 0.98 : 0.95,
      priority: state === "stale" ? 11 : 10,
      rationale:
        state === "stale"
          ? `Read content for "${dataKey}" became stale after a later mutation; compacting ${segmentIds.length} stale read segment(s)`
          : `Read content for "${dataKey}" was superseded by a later read; compacting ${segmentIds.length} superseded read segment(s)`,
      parameters: {
        readPath: dataKey,
        state,
        reason,
        triggeringIndices: reads
          .map((r) => r.triggeringIndex)
          .filter((value): value is number => typeof value === "number"),
        contentHashes: reads.map((r) => r.contentHash),
      },
    });

    estimatedSavedChars += savedChars;
  }

  return {
    enabled: true,
    instructions,
    estimatedSavedChars,
    notes: [
      `analyzed_segments=${segments.length}`,
      `read_state_groups=${instructions.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}
