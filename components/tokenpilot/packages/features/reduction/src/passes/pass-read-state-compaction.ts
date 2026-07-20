import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";
import {
  archiveContent,
  buildRecoveryHint,
  buildRecoveryContextSafePatch,
} from "@tokenpilot/artifact-store";
import {
  analyzeReadStateCompaction,
  isReadOutputSegment,
  normalizeToolName,
} from "../reduction/read-state-compaction.js";

const DEFAULT_HEAD_PREVIEW_SIZE = 400;
const DEFAULT_TAIL_PREVIEW_SIZE = 240;

type ReadStateCompactionPassConfig = {
  enabled: boolean;
  archiveDir?: string;
  noteLabel: string;
  replaceSuperseded: boolean;
  replaceStale: boolean;
  headPreviewSize: number;
  tailPreviewSize: number;
};

const parsePositiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const parseBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const resolveConfig = (options?: Record<string, unknown>): ReadStateCompactionPassConfig => ({
  enabled: parseBool(options?.enabled, true),
  archiveDir: typeof options?.archiveDir === "string" ? options.archiveDir : undefined,
  noteLabel:
    typeof options?.noteLabel === "string" && options.noteLabel.trim().length > 0
      ? options.noteLabel.trim()
      : "read_state_compaction",
  replaceSuperseded: parseBool(options?.replaceSuperseded, true),
  replaceStale: parseBool(options?.replaceStale, true),
  headPreviewSize: parsePositiveInt(options?.headPreviewSize, DEFAULT_HEAD_PREVIEW_SIZE),
  tailPreviewSize: parsePositiveInt(options?.tailPreviewSize, DEFAULT_TAIL_PREVIEW_SIZE),
});

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  !value || typeof value !== "object" || Array.isArray(value) ? undefined : value as Record<string, unknown>;

const extractDataKey = (segment: ContextSegment): string => {
  const meta = asObject(segment.metadata);
  const toolPayload = asObject(meta?.toolPayload);
  const candidates = [
    meta?.path,
    meta?.file_path,
    meta?.filePath,
    toolPayload?.path,
    toolPayload?.file_path,
    toolPayload?.filePath,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return `segment:${segment.id}`;
};

const clipText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

function buildLifecycleStub(params: {
  state: "superseded" | "stale";
  dataKey: string;
  originalText: string;
  archivePath: string;
  sourceLabel: string;
  headPreviewSize: number;
  tailPreviewSize: number;
}): string {
  const {
    state,
    dataKey,
    originalText,
    archivePath,
    sourceLabel,
    headPreviewSize,
    tailPreviewSize,
  } = params;
  const reasonLine =
    state === "stale"
      ? "This read is stale because the same path was modified later."
      : "This read is superseded because the same path was read again later.";
  const headPreview = clipText(originalText, headPreviewSize);
  const tailPreview =
    originalText.length > tailPreviewSize ? originalText.slice(-tailPreviewSize) : "";
  const previewBlock = tailPreview && tailPreview !== headPreview
    ? `${headPreview}\n...\n${tailPreview}`
    : headPreview;
  return (
    `[Read ${state}] ${dataKey}\n` +
    `${reasonLine}\n` +
    `--- Read Preview ---\n${previewBlock}\n--- End Preview ---` +
    buildRecoveryHint({
      dataKey,
      originalSize: originalText.length,
      archivePath,
      sourceLabel,
      enabled: true,
    })
  );
}

export const readStateCompactionPass: ReductionPassHandler = {
  beforeCall: async ({ turnCtx, spec }) => {
    const config = resolveConfig(spec.options);
    if (!config.enabled) {
      return {
        changed: false,
        skippedReason: "pass_disabled",
      };
    }

    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];
    const readStateInstructions = instructions.filter(
      (instr) => instr.strategy === "read_state_compaction",
    );
    if (readStateInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }
    const eligibleSegmentIds = new Set<string>();
    for (const instr of readStateInstructions) {
      for (const segmentId of instr.segmentIds) {
        eligibleSegmentIds.add(segmentId);
      }
    }

    const readStates = analyzeReadStateCompaction(turnCtx.segments);
    if (readStates.size === 0) {
      return {
        changed: false,
        skippedReason: "no_read_segments",
      };
    }

    const workspaceDir =
      typeof turnCtx.metadata?.workspaceDir === "string"
        ? turnCtx.metadata.workspaceDir
        : undefined;

    const touchedSegmentIds: string[] = [];
    const replacedStates = new Set<string>();
    const archivePaths: string[] = [];

    const nextSegments = await Promise.all(turnCtx.segments.map(async (segment) => {
      if (!isReadOutputSegment(segment)) return segment;
      if (!eligibleSegmentIds.has(segment.id)) return segment;
      const classification = readStates.get(segment.id);
      if (!classification) return segment;
      if (classification.state === "fresh") return segment;
      if (classification.state === "superseded" && !config.replaceSuperseded) return segment;
      if (classification.state === "stale" && !config.replaceStale) return segment;

      const meta = asObject(segment.metadata);
      const toolName = normalizeToolName(meta) ?? "read";
      const dataKey = extractDataKey(segment);
      const { archivePath } = await archiveContent({
        sessionId: turnCtx.sessionId,
        segmentId: segment.id,
        sourcePass: "read_state_compaction",
        toolName,
        dataKey,
        originalText: segment.text,
        workspaceDir,
        archiveDir: config.archiveDir,
        metadata: {
          lifecycleState: classification.state,
          lifecycleReason: classification.reason,
          triggeringIndex: classification.triggeringIndex,
        },
      });

      const replacementText = buildLifecycleStub({
        state: classification.state,
        dataKey,
        originalText: segment.text,
        archivePath,
        sourceLabel: `Read ${classification.state}`,
        headPreviewSize: config.headPreviewSize,
        tailPreviewSize: config.tailPreviewSize,
      });

      if (replacementText.length >= segment.text.length) {
        return segment;
      }

      touchedSegmentIds.push(segment.id);
      replacedStates.add(classification.state);
      archivePaths.push(archivePath);

      return {
        ...segment,
        text: replacementText,
        metadata: {
          ...segment.metadata,
          contextSafe: {
            ...(asObject(segment.metadata?.contextSafe) ?? {}),
            ...buildRecoveryContextSafePatch("read_state_compaction"),
          },
          recovery: {
            ...(asObject(segment.metadata?.recovery) ?? {}),
            source: "read_state_compaction",
            skipReduction: true,
          },
          reduction: {
            ...(segment.metadata?.reduction as Record<string, unknown> ?? {}),
            readStateCompaction: {
              replaced: true,
              state: classification.state,
              reason: classification.reason,
              dataKey,
              originalSize: segment.text.length,
              reducedSize: replacementText.length,
              archivePath,
            },
          },
        },
      };
    }));

    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason: "no_segments_replaced",
      };
    }

    return {
      changed: true,
      turnCtx: {
        ...turnCtx,
        segments: nextSegments,
      },
      note: `${config.noteLabel}:${[...replacedStates].join(",") || "none"}`,
      touchedSegmentIds,
      metadata: {
        readStateCompaction: {
          touchedSegmentIds,
          replacedStates: [...replacedStates],
          archivePaths,
        },
      },
    };
  },
};
