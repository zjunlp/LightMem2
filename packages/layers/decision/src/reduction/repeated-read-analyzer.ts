import { createHash } from "node:crypto";
import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

type ReadSegmentInfo = {
  index: number;
  segmentId: string;
  toolName: string;
  dataKey?: string;
  contentHash: string;
  chars: number;
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

// ============================================================================
// Repeated Read Analyzer
// ============================================================================

export type RepeatedReadAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<RepeatedReadAnalyzerConfig> = {
  enabled: true,
  minChars: 500,
  minSavedChars: 200,
};

/**
 * Analyze context for repeated read operations.
 *
 * Strategy:
 * - Group reads by content hash (same path + same content)
 * - Mark all reads after the first as reduction candidates
 * - This is a deduplication strategy, not a locality strategy
 */
export function analyzeRepeatedReads(
  segments: ContextSegment[],
  config: RepeatedReadAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["repeated_read_analyzer_disabled"],
    };
  }

  // Group reads by content hash
  const readsByKey = new Map<string, ReadSegmentInfo[]>();

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);

    // Only process read/exec tools
    if (tool !== "read" && tool !== "exec") continue;

    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;

    const contentHash = hashText(segment.text);
    const key = `${dataKey}:${contentHash}`;

    const existing = readsByKey.get(key) ?? [];
    existing.push({
      index: i,
      segmentId: segment.id,
      toolName: tool,
      dataKey,
      contentHash,
      chars: segment.text.length,
    });
    readsByKey.set(key, existing);
  }

  // Build instructions for groups with repeated reads
  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const [key, reads] of readsByKey.entries()) {
    if (reads.length <= 1) continue; // No repeated reads

    // Calculate potential savings (all reads after the first)
    const savedChars = reads.slice(1).reduce((sum, r) => sum + r.chars, 0);
    if (savedChars < cfg.minSavedChars) continue;

    const dataKey = reads[0]?.dataKey ?? "unknown";

    instructions.push({
      strategy: "repeated_read_dedup",
      segmentIds: reads.slice(1).map((r) => r.segmentId),
      confidence: 0.95, // High confidence - exact content match
      priority: 10, // High priority - deduplication is safe
      rationale: `Same content was read ${reads.length} times for "${dataKey}"; keeping first read, deduplicating ${reads.length - 1} duplicates`,
      parameters: {
        readPath: dataKey,
        repeatCount: reads.length,
        firstReadIndex: reads[0]?.index,
        contentHash: reads[0]?.contentHash,
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
      `repeated_read_groups=${instructions.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}

/**
 * Debug helper - returns detailed analysis for inspection
 */
export function debugRepeatedReadAnalysis(
  segments: ContextSegment[],
  config: RepeatedReadAnalyzerConfig = {},
): {
  config: Required<RepeatedReadAnalyzerConfig>;
  totalSegments: number;
  readSegments: number;
  uniqueReadContents: number;
  repeatedReadGroups: Array<{
    dataKey: string;
    contentHash: string;
    readCount: number;
    savedChars: number;
    segmentIds: string[];
  }>;
  decision: ReductionDecision;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const decision = analyzeRepeatedReads(segments, cfg);

  const readSegments = segments.filter((s) => {
    const meta = asObject(s.metadata);
    const tool = normalizeToolName(meta);
    return tool === "read" || tool === "exec";
  });

  const readsByKey = new Map<string, ReadSegmentInfo[]>();
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);
    if (tool !== "read" && tool !== "exec") continue;
    const dataKey = extractDataKey(meta);
    if (!dataKey) continue;
    const contentHash = hashText(segment.text);
    const key = `${dataKey}:${contentHash}`;
    const existing = readsByKey.get(key) ?? [];
    existing.push({
      index: i,
      segmentId: segment.id,
      toolName: tool,
      dataKey,
      contentHash,
      chars: segment.text.length,
    });
    readsByKey.set(key, existing);
  }

  const repeatedReadGroups = Array.from(readsByKey.entries())
    .filter(([, reads]) => reads.length > 1)
    .map(([key, reads]) => {
      const savedChars = reads.slice(1).reduce((sum, r) => sum + r.chars, 0);
      return {
        dataKey: reads[0]?.dataKey ?? "unknown",
        contentHash: key.split(":").slice(1).join(":") || key,
        readCount: reads.length,
        savedChars,
        segmentIds: reads.slice(1).map((r) => r.segmentId),
      };
    });

  return {
    config: cfg,
    totalSegments: segments.length,
    readSegments: readSegments.length,
    uniqueReadContents: readsByKey.size,
    repeatedReadGroups,
    decision,
  };
}
