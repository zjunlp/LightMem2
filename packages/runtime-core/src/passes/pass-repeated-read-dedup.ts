import type { ContextSegment, RuntimeTurnContext } from "@tokenpilot/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";
import {
  archiveContent,
  buildRecoveryHint,
} from "../archive-recovery/index.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_HEAD_PREVIEW_SIZE = 600;
const DEFAULT_TAIL_PREVIEW_SIZE = 400;

type RepeatedReadDedupConfig = {
  headPreviewSize: number;
  tailPreviewSize: number;
  noteLabel: string;
  archiveDir?: string;
  enabled: boolean;
  keepFirstRead: boolean; // If true, keep first read; if false, keep last read
};

// ============================================================================
// Utility Functions
// ============================================================================

const parsePositiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const parseBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const resolveConfig = (options?: Record<string, unknown>): RepeatedReadDedupConfig => ({
  headPreviewSize: parsePositiveInt(options?.headPreviewSize, DEFAULT_HEAD_PREVIEW_SIZE),
  tailPreviewSize: parsePositiveInt(options?.tailPreviewSize, DEFAULT_TAIL_PREVIEW_SIZE),
  noteLabel:
    typeof options?.noteLabel === "string" && options.noteLabel.trim().length > 0
      ? options.noteLabel.trim()
      : "repeated_read_dedup",
  archiveDir: typeof options?.archiveDir === "string" ? options.archiveDir : undefined,
  enabled: parseBool(options?.enabled, true),
  keepFirstRead: parseBool(options?.keepFirstRead, true),
});

const clipText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  !value || typeof value !== "object" || Array.isArray(value) ? undefined : value as Record<string, unknown>;

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

const isReadOutputSegment = (segment: ContextSegment): boolean => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta);
  if (toolName !== "read") return false;

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

// ============================================================================
// Deduplication Logic
// ============================================================================

const buildDedupStub = (
  toolName: string,
  dataKey: string,
  originalSize: number,
  archivePath: string,
  headPreview: string,
  tailPreview: string,
  totalLines: number,
): string => {
  const linesInfo = totalLines > 0 ? ` (${totalLines} lines)` : "";
  return (
    `[Repeated ${toolName} deduplicated] First read of \`${dataKey}\` is preserved (${originalSize.toLocaleString()} chars${linesInfo}). ` +
    `This repeated read has been removed to save context.\n` +
    `--- File Preview ---\n${headPreview}${tailPreview ? `\n...\n${tailPreview}` : ""}` +
    `--- End Preview ---` +
    buildRecoveryHint({
      dataKey,
      originalSize,
      archivePath,
      sourceLabel: "Repeated read deduplicated",
    })
  );
};

type DedupResult = {
  text: string;
  changed: boolean;
  archivePath?: string;
  originalSize?: number;
};

const deduplicateRead = async (
  segment: ContextSegment,
  sessionId: string,
  firstReadSegment: ContextSegment,
  config: RepeatedReadDedupConfig,
  workspaceDir?: string,
): Promise<DedupResult> => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta) ?? "read";
  const dataKey = extractDataKey(meta) ?? "unknown";

  // Build head+tail preview from original text
  const originalText = segment.text;
  const lines = originalText.split("\n");
  const totalLines = lines.length;
  const headLines = lines.slice(0, Math.max(1, Math.floor(config.headPreviewSize / 80)));
  const tailLines = lines.slice(-Math.max(1, Math.floor(config.tailPreviewSize / 80)));
  const headPreview = headLines.join("\n");
  const tailPreview = tailLines.join("\n");

  const { archivePath } = await archiveContent({
    sessionId,
    segmentId: segment.id,
    sourcePass: "repeated_read_dedup",
    toolName,
    dataKey,
    originalText,
    workspaceDir,
    archiveDir: config.archiveDir,
    metadata: {
      totalLines,
      firstReadSegmentId: firstReadSegment.id,
    },
  });

  const truncatedStub = buildDedupStub(
    toolName,
    dataKey,
    originalText.length,
    archivePath,
    headPreview,
    tailPreview,
    totalLines,
  );

  return {
    text: truncatedStub,
    changed: true,
    archivePath,
    originalSize: originalText.length,
  };
};

// ============================================================================
// Pass Handler
// ============================================================================

async function resolveFirstReadSegment(
  firstReadId: string,
  turnCtx: RuntimeTurnContext,
): Promise<ContextSegment | undefined> {
  const inContext = turnCtx.segments.find((s) => s.id === firstReadId);
  if (inContext) {
    return inContext;
  }

  return undefined;
}

export const repeatedReadDedupPass: ReductionPassHandler = {
  beforeCall: async ({ turnCtx, spec }) => {
    const config = resolveConfig(spec.options);

    if (!config.enabled) {
      return {
        changed: false,
        skippedReason: "pass_disabled",
      };
    }

    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for repeated_read_dedup strategy
    const repeatedReadInstructions = instructions.filter(
      (instr) => instr.strategy === "repeated_read_dedup",
    );

    if (repeatedReadInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Build a set of segment IDs to deduplicate
    const dedupSegmentIds = new Set<string>();
    for (const instr of repeatedReadInstructions) {
      for (const id of instr.segmentIds) {
        dedupSegmentIds.add(id);
      }
    }

    // Build a map of first read segment for each group
    const firstReadMap = new Map<string, ContextSegment>();
    for (const instr of repeatedReadInstructions) {
      const firstReadId = instr.parameters?.firstReadSegmentId as string | undefined;
      if (firstReadId) {
        const firstReadSegment = await resolveFirstReadSegment(firstReadId, turnCtx);
        if (firstReadSegment) {
          for (const id of instr.segmentIds) {
            firstReadMap.set(id, firstReadSegment);
          }
        }
      }
    }

    // Perform deduplication
    const touchedSegmentIds: string[] = [];
    let totalSavedChars = 0;
    const archivePaths: string[] = [];

    const workspaceDir =
      typeof turnCtx.metadata?.workspaceDir === "string"
        ? turnCtx.metadata.workspaceDir
        : undefined;

    const nextSegments: ContextSegment[] = [];
    for (const segment of turnCtx.segments) {
      if (!dedupSegmentIds.has(segment.id)) {
        nextSegments.push(segment);
        continue;
      }

      const firstReadSegment = firstReadMap.get(segment.id);
      if (!firstReadSegment) {
        nextSegments.push(segment);
        continue;
      }

      if (!isReadOutputSegment(segment) || !isReadOutputSegment(firstReadSegment)) {
        nextSegments.push(segment);
        continue;
      }

      const dedupResult = await deduplicateRead(
        segment,
        turnCtx.sessionId,
        firstReadSegment,
        config,
        workspaceDir,
      );
      if (!dedupResult.changed) {
        nextSegments.push(segment);
        continue;
      }

      const meta = asObject(segment.metadata) ?? {};
      if (dedupResult.archivePath) {
        archivePaths.push(dedupResult.archivePath);
      }
      touchedSegmentIds.push(segment.id);
      totalSavedChars += segment.text.length;

      nextSegments.push({
        ...segment,
        text: dedupResult.text,
        metadata: {
          ...meta,
          reduction: {
            ...(meta?.reduction as Record<string, unknown> ?? {}),
            repeatedReadDedup: {
              deduplicated: true,
              originalSize: segment.text.length,
              firstReadSegmentId: firstReadSegment.id,
              archivePath: dedupResult.archivePath,
            },
          },
        },
      });
    }

    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason: "no_segments_to_dedup",
      };
    }

    return {
      changed: true,
      turnCtx: {
        ...turnCtx,
        segments: nextSegments,
      },
      note: `${config.noteLabel}:deduplicated=${touchedSegmentIds.length},saved=${totalSavedChars.toLocaleString()}chars`,
      touchedSegmentIds,
      metadata: {
        archivePaths,
        totalSavedChars,
      },
    };
  },
};
