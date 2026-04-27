import type { ContextSegment, RuntimeTurnContext } from "@tokenpilot/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";
import {
  archiveContent,
  buildRecoveryHint,
} from "../archive-recovery/index.js";

// =============================================================================
// Per-Tool Threshold Configuration
// =============================================================================

const DEFAULT_THRESHOLD_CHARS = 50_000;
const DEFAULT_HEAD_PREVIEW_SIZE = 600;
const DEFAULT_TAIL_PREVIEW_SIZE = 400;

const TOOL_THRESHOLDS: Record<string, number> = {
  bash: 30_000,
  shell: 30_000,
  powershell: 30_000,
  grep: 20_000,
  rg: 20_000,
  read: Infinity,
  file_read: Infinity,
  mcp_auth: 10_000,
  glob: 100_000,
  write: 100_000,
  edit: 100_000,
  file_write: 100_000,
  file_edit: 100_000,
  web_fetch: 100_000,
  web_search: 100_000,
  agent: 100_000,
  task: 100_000,
};

const getToolThreshold = (toolName: string, toolThresholds?: Record<string, number>): number => {
  const normalized = toolName.toLowerCase();
  if (toolThresholds && normalized in toolThresholds) {
    return toolThresholds[normalized];
  }
  if (normalized in TOOL_THRESHOLDS) {
    return TOOL_THRESHOLDS[normalized];
  }
  return DEFAULT_THRESHOLD_CHARS;
};

// =============================================================================
// Configuration
// =============================================================================

type ExecOutputTruncationConfig = {
  headPreviewSize: number;
  tailPreviewSize: number;
  noteLabel: string;
  archiveDir?: string;
  enabled: boolean;
  toolThresholds?: Record<string, number>;
};

const parsePositiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const parseBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const resolveConfig = (options?: Record<string, unknown>): ExecOutputTruncationConfig => ({
  headPreviewSize: parsePositiveInt(options?.headPreviewSize, DEFAULT_HEAD_PREVIEW_SIZE),
  tailPreviewSize: parsePositiveInt(options?.tailPreviewSize, DEFAULT_TAIL_PREVIEW_SIZE),
  noteLabel:
    typeof options?.noteLabel === "string" && options.noteLabel.trim().length > 0
      ? options.noteLabel.trim()
      : "exec_output_truncation",
  archiveDir: typeof options?.archiveDir === "string" ? options.archiveDir : undefined,
  enabled: parseBool(options?.enabled, true),
  toolThresholds: options?.toolThresholds && typeof options.toolThresholds === "object"
    ? options.toolThresholds as Record<string, number>
    : undefined,
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
  return raw.trim().toLowerCase() || undefined;
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

// =============================================================================
// Archive and Truncation Logic
// =============================================================================

const buildTruncationStub = (
  toolName: string,
  dataKey: string,
  originalSize: number,
  archivePath: string,
  headPreview: string,
  tailPreview: string,
  omittedChars: number,
  headSize: number,
  tailSize: number,
): string => {
  return (
    `[${toolName} output truncated] Original: ${originalSize.toLocaleString()} chars.\n\n` +
    `Preview shows first ${headSize.toLocaleString()} + last ${tailSize.toLocaleString()} chars:\n\n` +
    `=== BEGIN PREVIEW (first ${headSize.toLocaleString()} chars) ===\n` +
    `${headPreview}\n` +
    `=== END PREVIEW ===\n\n` +
    `[${omittedChars.toLocaleString()} chars omitted]\n\n` +
    `=== BEGIN PREVIEW (last ${tailSize.toLocaleString()} chars) ===\n` +
    `${tailPreview}\n` +
    `=== END PREVIEW ===` +
    buildRecoveryHint({
      dataKey,
      originalSize,
      archivePath,
      sourceLabel: `${toolName} output truncated`,
    })
  );
};

type TruncationResult = {
  text: string;
  changed: boolean;
  archivePath?: string;
  originalSize?: number;
};

const truncateExecOutput = async (
  segment: ContextSegment,
  sessionId: string,
  config: ExecOutputTruncationConfig,
  workspaceDir?: string,
): Promise<TruncationResult> => {
  const meta = asObject(segment.metadata);
  const toolName = normalizeToolName(meta) ?? "exec";
  const dataKey = extractDataKey(meta) ?? "unknown";

  const threshold = getToolThreshold(toolName, config.toolThresholds);

  if (!Number.isFinite(threshold)) {
    return { text: segment.text, changed: false };
  }

  if (segment.text.length <= threshold) {
    return { text: segment.text, changed: false };
  }

  const { archivePath } = await archiveContent({
    sessionId,
    segmentId: segment.id,
    sourcePass: "exec_output_truncation",
    toolName,
    dataKey,
    originalText: segment.text,
    workspaceDir,
    archiveDir: config.archiveDir,
    metadata: {
      threshold,
    },
  });

  const fullText = segment.text;
  const headPreview = clipText(fullText, config.headPreviewSize);
  const tailPreview = fullText.length > config.tailPreviewSize ? fullText.slice(-config.tailPreviewSize) : "";
  const omittedChars = fullText.length - config.headPreviewSize - config.tailPreviewSize;

  const truncatedStub = buildTruncationStub(
    toolName,
    dataKey,
    fullText.length,
    archivePath,
    headPreview,
    tailPreview,
    Math.max(0, omittedChars),
    config.headPreviewSize,
    config.tailPreviewSize,
  );

  return {
    text: truncatedStub,
    changed: true,
    archivePath,
    originalSize: fullText.length,
  };
};

// =============================================================================
// Pass Handler
// =============================================================================

export const execOutputTruncationPass: ReductionPassHandler = {
  afterCall({ turnCtx, currentResult, spec }) {
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

    // Find instructions for exec_output_truncation strategy
    const execOutputInstructions = instructions.filter(
      (instr) => instr.strategy === "exec_output_truncation",
    );

    if (execOutputInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Build a set of segment IDs to truncate
    const segmentIds = new Set<string>();
    for (const instr of execOutputInstructions) {
      for (const id of instr.segmentIds) {
        segmentIds.add(id);
      }
    }

    // Find segments to truncate
    const segmentsToTruncate = turnCtx.segments.filter((s) => segmentIds.has(s.id));

    if (segmentsToTruncate.length === 0) {
      return {
        changed: false,
        skippedReason: "no_segments_found_for_instructions",
      };
    }

    // Note: exec_output_truncation operates on context segments, not result content
    // The actual truncation happens in beforeCall phase if needed, or we mark segments
    // For now, we return a note that instructions were received
    return {
      changed: true,
      note: `${config.noteLabel}:segments=${segmentsToTruncate.length}`,
      metadata: {
        segmentIds: [...segmentIds],
      },
    };
  },
};

// Also support beforeCall for segment truncation
const updateSegments = async (
  turnCtx: RuntimeTurnContext,
  config: ExecOutputTruncationConfig,
  segmentIds: Set<string>,
): Promise<{
  turnCtx: RuntimeTurnContext;
  touchedSegmentIds: string[];
  archivePaths: string[];
  totalSavedChars: number;
}> => {
  const touchedSegmentIds: string[] = [];
  const archivePaths: string[] = [];
  let totalSavedChars = 0;

  const workspaceDir = typeof turnCtx.metadata?.workspaceDir === "string"
    ? turnCtx.metadata.workspaceDir
    : undefined;

  const nextSegments: ContextSegment[] = [];

  for (const segment of turnCtx.segments) {
    if (!segmentIds.has(segment.id)) {
      nextSegments.push(segment);
      continue;
    }

    const result = await truncateExecOutput(segment, turnCtx.sessionId, config, workspaceDir);

    if (result.changed) {
      touchedSegmentIds.push(segment.id);
      if (result.archivePath) archivePaths.push(result.archivePath);
      totalSavedChars += (result.originalSize ?? 0) - result.text.length;

      const meta = asObject(segment.metadata) ?? {};
      nextSegments.push({
        ...segment,
        text: result.text,
        metadata: {
          ...meta,
          reduction: {
            ...(meta.reduction as Record<string, unknown> ?? {}),
            execOutputTruncation: {
              archived: true,
              dataKey: extractDataKey(meta),
              archivePath: result.archivePath,
              originalSize: result.originalSize,
              truncatedSize: result.text.length,
            },
          },
        },
      });
    } else {
      nextSegments.push(segment);
    }
  }

  return {
    turnCtx: touchedSegmentIds.length === 0 ? turnCtx : { ...turnCtx, segments: nextSegments },
    touchedSegmentIds,
    archivePaths,
    totalSavedChars,
  };
};

// Add beforeCall handler for segment truncation
export const execOutputTruncationBeforeCall: ReductionPassHandler = {
  async beforeCall({ turnCtx, spec }) {
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

    const execOutputInstructions = instructions.filter(
      (instr) => instr.strategy === "exec_output_truncation",
    );

    if (execOutputInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    const segmentIds = new Set<string>();
    for (const instr of execOutputInstructions) {
      for (const id of instr.segmentIds) {
        segmentIds.add(id);
      }
    }

    const { turnCtx: nextCtx, touchedSegmentIds, archivePaths, totalSavedChars } =
      await updateSegments(turnCtx, config, segmentIds);

    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason: "no_segments_reduced",
      };
    }

    return {
      changed: true,
      turnCtx: nextCtx,
      note: `${config.noteLabel}:truncated=${touchedSegmentIds.length},saved=${totalSavedChars.toLocaleString()}chars`,
      touchedSegmentIds,
      metadata: {
        archivePaths,
        totalSavedChars,
      },
    };
  },
};
