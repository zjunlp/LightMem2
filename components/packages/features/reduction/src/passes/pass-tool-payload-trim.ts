import type { ContextSegment, RuntimeTurnContext } from "@lightmem2/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";
import {
  archiveContent,
  buildArchiveLocation,
  buildRecoveryHint,
} from "@lightmem2/artifact-store";
import {
  reduceToolPayloadText,
  type PayloadBlockConfig,
  type ToolPayloadKind,
  type ToolPayloadRouteConfig,
} from "../reduction/tool-payload-router.js";
import {
  hasRecoveryMarker,
  hasRecoverySkipReductionFlag,
  isRecoveryText,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
} from "@lightmem2/artifact-store";
import { classifyReadStates, isReadOutputSegment } from "../reduction/read-state-compaction.js";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_HEAD_LINES = 8;
const DEFAULT_TAIL_LINES = 8;
const MAX_DISCLOSED_READ_PATHS = 128;

type ToolPayloadTrimConfig = {
  maxChars: number;
  noteLabel: string;
  stdout: PayloadBlockConfig;
  stderr: PayloadBlockConfig;
  json: PayloadBlockConfig;
  blob: PayloadBlockConfig;
};

const parsePositiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const parseBool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const buildBlockConfig = (
  raw: unknown,
  defaults: Partial<PayloadBlockConfig> & { maxChars: number },
): PayloadBlockConfig => {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: parseBool(obj.enabled, true),
    maxChars: parsePositiveInt(obj.maxChars, defaults.maxChars),
    keepHeadLines: parsePositiveInt(obj.keepHeadLines, defaults.keepHeadLines ?? DEFAULT_HEAD_LINES),
    keepTailLines: parsePositiveInt(obj.keepTailLines, defaults.keepTailLines ?? DEFAULT_TAIL_LINES),
    maxPreviewChars: parsePositiveInt(obj.maxPreviewChars, defaults.maxPreviewChars ?? 160),
    maxItems: parsePositiveInt(obj.maxItems, defaults.maxItems ?? 8),
    maxDepth: parsePositiveInt(obj.maxDepth, defaults.maxDepth ?? 2),
  };
};

const resolveConfig = (options?: Record<string, unknown>): ToolPayloadTrimConfig => {
  const maxChars = parsePositiveInt(options?.maxChars, DEFAULT_MAX_CHARS);
  const noteLabel =
    typeof options?.noteLabel === "string" && options.noteLabel.trim().length > 0
      ? options.noteLabel.trim()
      : "tool_payload_trim";

  return {
    maxChars,
    noteLabel,
    stdout: buildBlockConfig(options?.stdout, {
      maxChars,
      keepHeadLines: 10,
      keepTailLines: 10,
      maxPreviewChars: 120,
      maxItems: 8,
      maxDepth: 1,
    }),
    stderr: buildBlockConfig(options?.stderr, {
      maxChars: Math.max(600, Math.floor(maxChars * 0.75)),
      keepHeadLines: 8,
      keepTailLines: 16,
      maxPreviewChars: 160,
      maxItems: 8,
      maxDepth: 1,
    }),
    json: buildBlockConfig(options?.json, {
      maxChars: Math.max(700, Math.floor(maxChars * 0.8)),
      keepHeadLines: 6,
      keepTailLines: 6,
      maxPreviewChars: 220,
      maxItems: 8,
      maxDepth: 2,
    }),
    blob: buildBlockConfig(options?.blob, {
      maxChars: Math.max(256, Math.floor(maxChars * 0.25)),
      keepHeadLines: 1,
      keepTailLines: 1,
      maxPreviewChars: 96,
      maxItems: 4,
      maxDepth: 1,
    }),
  };
};

const normalizePayloadKind = (value: unknown): ToolPayloadKind | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "stdout" ||
    normalized === "stderr" ||
    normalized === "json" ||
    normalized === "blob"
  ) {
    return normalized;
  }
  return undefined;
};

const reduceSegment = (
  segment: ContextSegment,
  cfg: ToolPayloadTrimConfig,
  payloadKind: ToolPayloadKind,
  turnCtx: RuntimeTurnContext,
  readStateBySegmentId: Map<string, "fresh" | "superseded" | "stale">,
  previouslyReadPaths: Set<string>,
) => {
  const meta = asObject(segment.metadata);
  const toolPayload = asObject(meta?.toolPayload);
  const fieldName =
    typeof meta?.fieldName === "string"
      ? meta.fieldName
      : typeof toolPayload?.fieldName === "string"
        ? toolPayload.fieldName as string
        : undefined;
  const path =
    typeof meta?.path === "string"
      ? meta.path
      : typeof toolPayload?.path === "string"
        ? toolPayload.path as string
        : undefined;

  return reduceToolPayloadText(
    segment.text,
    payloadKind,
    cfg satisfies ToolPayloadRouteConfig,
    {
      toolName: extractToolName(segment),
      fieldName,
      path,
      payloadKind,
      readState: readStateBySegmentId.get(segment.id),
    },
    {
      queryText:
        typeof turnCtx.metadata?.latestUserQuery === "string"
          ? turnCtx.metadata.latestUserQuery
          : typeof turnCtx.metadata?.currentQuery === "string"
            ? turnCtx.metadata.currentQuery
            : undefined,
      previouslyReadPaths,
    },
  );
};

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

const extractToolName = (segment: ContextSegment): string => {
  const meta = asObject(segment.metadata);
  const toolPayload = asObject(meta?.toolPayload);
  const candidates = [
    meta?.toolName,
    toolPayload?.toolName,
    toolPayload?.tool_name,
    meta?.name,
  ];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed.toLowerCase();
  }
  return "tool";
};

const normalizeDisclosedReadPath = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
};

const readDisclosedReadPaths = (metadata: Record<string, unknown> | undefined): string[] => {
  const raw = metadata?.disclosedReadPaths;
  if (!Array.isArray(raw)) return [];
  const next = new Set<string>();
  for (const entry of raw) {
    const normalized = normalizeDisclosedReadPath(entry);
    if (normalized) next.add(normalized);
  }
  return [...next].slice(-MAX_DISCLOSED_READ_PATHS);
};

const isRecoveryExemptSegment = (segment: ContextSegment): boolean => {
  const meta = asObject(segment.metadata);
  if (hasRecoverySkipReductionFlag(meta, asObject)) return true;
  if (hasRecoveryMarker(meta, asObject)) return true;
  if (extractToolName(segment) === MEMORY_FAULT_RECOVER_TOOL_NAME) return true;
  return isRecoveryText(segment.text);
};

export const toolPayloadTrimPass: ReductionPassHandler = {
  async beforeCall({ turnCtx, spec }) {
    const cfg = resolveConfig(spec.options);

    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for tool_payload_trim strategy
    const toolPayloadInstructions = instructions.filter(
      (instr) => instr.strategy === "tool_payload_trim",
    );

    if (toolPayloadInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Build a set of segment IDs to trim with their payload kinds
    const segmentMap = new Map<string, { segment: ContextSegment; payloadKind: ToolPayloadKind }>();
    for (const instr of toolPayloadInstructions) {
      const payloadKind = (instr.parameters?.payloadKind as ToolPayloadKind) ?? "stdout";
      for (const id of instr.segmentIds) {
        const segment = turnCtx.segments.find((s) => s.id === id);
        if (segment) {
          segmentMap.set(id, { segment, payloadKind });
        }
      }
    }

    if (segmentMap.size === 0) {
      return {
        changed: false,
        skippedReason: "no_segments_found_for_instructions",
      };
    }

    // Perform trimming
    const touchedSegmentIds: string[] = [];
    const reducedKinds = new Set<ToolPayloadKind>();
    const reducedRoutes = new Set<string>();
    const readStateBySegmentId = classifyReadStates(turnCtx.segments);
    const previouslyReadPaths = new Set<string>(readDisclosedReadPaths(turnCtx.metadata));

    const workspaceDir =
      typeof turnCtx.metadata?.workspaceDir === "string"
        ? turnCtx.metadata.workspaceDir
        : undefined;
    const archivePaths: string[] = [];
    let skippedNoNetSavings = 0;
    let skippedRecoveryExempt = 0;
    const nextSegments: ContextSegment[] = [];
    for (const segment of turnCtx.segments) {
      const entry = segmentMap.get(segment.id);
      if (!entry) {
        nextSegments.push(segment);
        continue;
      }

      if (isRecoveryExemptSegment(segment)) {
        skippedRecoveryExempt += 1;
        nextSegments.push(segment);
        continue;
      }

      const reduced = reduceSegment(
        segment,
        cfg,
        entry.payloadKind,
        turnCtx,
        readStateBySegmentId,
        previouslyReadPaths,
      );
      const segmentMeta = asObject(segment.metadata);
      const segmentPath = extractDataKey(segment);
      if (isReadOutputSegment(segment) && segmentMeta && segmentPath) {
        const normalizedPath = normalizeDisclosedReadPath(segmentPath);
        if (normalizedPath) {
          previouslyReadPaths.add(normalizedPath);
        }
      }
      if (!reduced.changed) {
        nextSegments.push(segment);
        continue;
      }

      const dataKey = extractDataKey(segment);
      const toolName = extractToolName(segment);
      const { archivePath } = buildArchiveLocation({
        sessionId: turnCtx.sessionId,
        segmentId: segment.id,
        workspaceDir,
      });

      const replacementText = reduced.text + buildRecoveryHint({
        dataKey,
        originalSize: segment.text.length,
        archivePath,
        sourceLabel: "Tool payload trimmed",
      });

      if (replacementText.length >= segment.text.length) {
        skippedNoNetSavings += 1;
        nextSegments.push(segment);
        continue;
      }

      await archiveContent({
        sessionId: turnCtx.sessionId,
        segmentId: segment.id,
        sourcePass: "tool_payload_trim",
        toolName,
        dataKey,
        originalText: segment.text,
        workspaceDir,
        metadata: {
          payloadKind: entry.payloadKind,
          contentRoute: reduced.route,
          contentRouteReason: reduced.reason,
          reducedPreviewChars: reduced.text.length,
          readState: readStateBySegmentId.get(segment.id),
        },
      });

      touchedSegmentIds.push(segment.id);
      reducedKinds.add(entry.payloadKind);
      reducedRoutes.add(reduced.route);
      archivePaths.push(archivePath);

      nextSegments.push({
        ...segment,
        text: replacementText,
        metadata: {
          ...segment.metadata,
          reduction: {
            ...(segment.metadata?.reduction as Record<string, unknown> ?? {}),
            toolPayloadTrim: {
              reduced: true,
              payloadKind: entry.payloadKind,
              contentRoute: reduced.route,
              contentRouteReason: reduced.reason,
              dataKey,
              originalSize: segment.text.length,
              reducedSize: reduced.text.length,
              archivePath,
              readState: readStateBySegmentId.get(segment.id),
            },
          },
        },
      });
    }

    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason:
          skippedRecoveryExempt > 0
            ? "recovery_exempt"
            : skippedNoNetSavings > 0
              ? "no_net_savings"
              : "no_segments_reduced",
        metadata: {
          disclosedReadPaths: [...previouslyReadPaths].slice(-MAX_DISCLOSED_READ_PATHS),
        },
      };
    }

    return {
      changed: true,
      turnCtx: {
        ...turnCtx,
        segments: nextSegments,
      },
      note: `${cfg.noteLabel}:${[...reducedKinds].join(",") || "mixed"}:${[...reducedRoutes].join(",") || "plain_text"}`,
      touchedSegmentIds,
      metadata: {
        reducedKinds: [...reducedKinds],
        reducedRoutes: [...reducedRoutes],
        archivePaths,
        disclosedReadPaths: [...previouslyReadPaths].slice(-MAX_DISCLOSED_READ_PATHS),
      },
    };
  },
};
