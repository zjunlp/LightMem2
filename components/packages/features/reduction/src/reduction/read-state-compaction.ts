import type { ContextSegment } from "@lightmem2/kernel";

export type ReadState = "fresh" | "superseded" | "stale";
export type ReadStateReason = "later_read" | "later_mutation" | "none";

export type ReadStateClassification = {
  segmentId: string;
  dataKey: string;
  readKey: string;
  state: ReadState;
  reason: ReadStateReason;
  triggeringIndex?: number;
};

type ReadEvent = {
  kind: "read";
  segmentId: string;
  index: number;
  dataKey: string;
  readKey: string;
};

type FileEvent =
  | {
      kind: "read";
      index: number;
      dataKey: string;
      readKey: string;
      segmentId: string;
    }
  | {
      kind: "mutate";
      index: number;
      dataKey: string;
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

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  !value || typeof value !== "object" || Array.isArray(value) ? undefined : value as Record<string, unknown>;

export const normalizeToolName = (metadata: Record<string, unknown> | undefined): string | undefined => {
  const toolPayload = asObject(metadata?.toolPayload);
  const directToolName = typeof metadata?.toolName === "string" ? metadata.toolName : undefined;
  const payloadToolName =
    typeof toolPayload?.toolName === "string" ? (toolPayload.toolName as string) : undefined;
  const raw = directToolName ?? payloadToolName;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

export const extractDataKey = (metadata: Record<string, unknown> | undefined): string | undefined => {
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

type ReadWindow = {
  offset?: number;
  limit?: number;
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

const buildReadKey = (dataKey: string, window: ReadWindow | undefined): string => {
  const offset = window?.offset;
  const limit = window?.limit;
  if (offset == null && limit == null) return `${dataKey}#full`;
  return `${dataKey}#offset=${offset ?? "?"}:limit=${limit ?? "?"}`;
};

export const isReadOutputSegment = (segment: ContextSegment): boolean => {
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

export const isMutatingToolSegment = (segment: ContextSegment): boolean => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta);
  if (!toolName || !MUTATING_TOOL_NAMES.has(toolName)) return false;
  return Boolean(extractDataKey(meta));
};

function collectFileEvents(segments: ContextSegment[]): FileEvent[] {
  const events: FileEvent[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const meta = asObject(segment.metadata);
    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;
    const readKey = buildReadKey(dataKey, extractReadWindow(meta));

    if (isReadOutputSegment(segment)) {
      events.push({
        kind: "read",
        index,
        dataKey,
        readKey,
        segmentId: segment.id,
      });
      continue;
    }

    if (isMutatingToolSegment(segment)) {
      events.push({
        kind: "mutate",
        index,
        dataKey,
      });
    }
  }
  return events;
}

export function analyzeReadStateCompaction(
  segments: ContextSegment[],
): Map<string, ReadStateClassification> {
  const events = collectFileEvents(segments);
  const eventsByDataKey = new Map<string, FileEvent[]>();

  for (const event of events) {
    const bucket = eventsByDataKey.get(event.dataKey) ?? [];
    bucket.push(event);
    eventsByDataKey.set(event.dataKey, bucket);
  }

  const stateBySegmentId = new Map<string, ReadStateClassification>();

  for (const bucket of eventsByDataKey.values()) {
    const reads = bucket.filter((event): event is ReadEvent => event.kind === "read");
    if (reads.length === 0) continue;

    for (const read of reads) {
      let state: ReadState = "fresh";
      let reason: ReadStateReason = "none";
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
      stateBySegmentId.set(read.segmentId, {
        segmentId: read.segmentId,
        dataKey: read.dataKey,
        readKey: read.readKey,
        state,
        reason,
        triggeringIndex,
      });
    }
  }

  return stateBySegmentId;
}

export function classifyReadStates(
  segments: ContextSegment[],
): Map<string, ReadState> {
  const analyzed = analyzeReadStateCompaction(segments);
  const states = new Map<string, ReadState>();
  for (const [segmentId, entry] of analyzed.entries()) {
    states.set(segmentId, entry.state);
  }
  return states;
}
