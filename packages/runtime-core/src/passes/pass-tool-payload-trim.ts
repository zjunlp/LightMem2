import type { ContextSegment, RuntimeTurnContext } from "@tokenpilot/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";
import {
  archiveContent,
  buildArchiveLocation,
  buildRecoveryHint,
} from "../archive-recovery/index.js";

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_HEAD_LINES = 8;
const DEFAULT_TAIL_LINES = 8;

type PayloadKind = "stdout" | "stderr" | "json" | "blob";

type PayloadBlockConfig = {
  enabled: boolean;
  maxChars: number;
  keepHeadLines: number;
  keepTailLines: number;
  maxPreviewChars: number;
  maxItems: number;
  maxDepth: number;
};

type ToolPayloadTrimConfig = {
  maxChars: number;
  noteLabel: string;
  stdout: PayloadBlockConfig;
  stderr: PayloadBlockConfig;
  json: PayloadBlockConfig;
  blob: PayloadBlockConfig;
};

type ParsedSection = {
  kind: PayloadKind | "other";
  headerLine?: string;
  body: string;
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

const normalizePayloadKind = (value: unknown): PayloadKind | undefined => {
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

const clipText = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

const summarizeLineBlock = (
  text: string,
  label: PayloadKind,
  cfg: PayloadBlockConfig,
): string => {
  if (text.length <= cfg.maxChars) return text;

  const lines = text.split("\n");
  const head = lines.slice(0, cfg.keepHeadLines);
  const tail = lines.slice(-cfg.keepTailLines);
  const omittedLineCount = Math.max(0, lines.length - head.length - tail.length);
  const summaryLine = `...[${label} reduced lines=${omittedLineCount} chars=${text.length}]`;
  const nextLines = [...head];
  if (omittedLineCount > 0 || text.length > cfg.maxChars) nextLines.push(summaryLine);
  if (tail.length > 0) nextLines.push(...tail);
  return nextLines.join("\n").trim();
};

const summarizeJsonValue = (
  value: unknown,
  depth: number,
  maxDepth: number,
  maxItems: number,
  maxPreviewChars: number,
): unknown => {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clipText(value, maxPreviewChars);
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    return "[object]";
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value
        .slice(0, maxItems)
        .map((item) => summarizeJsonValue(item, depth + 1, maxDepth, maxItems, maxPreviewChars)),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      keyCount: entries.length,
      preview: Object.fromEntries(
        entries
          .slice(0, maxItems)
          .map(([key, item]) => [
            key,
            summarizeJsonValue(item, depth + 1, maxDepth, maxItems, maxPreviewChars),
          ]),
      ),
    };
  }
  return String(value);
};

const summarizeJsonText = (text: string, cfg: PayloadBlockConfig): string => {
  try {
    const parsed = JSON.parse(text);
    const minified = JSON.stringify(parsed);
    if (minified.length <= cfg.maxChars) {
      return minified;
    }
    const summary = {
      reduced: "json",
      originalChars: text.length,
      summary: summarizeJsonValue(parsed, 0, cfg.maxDepth, cfg.maxItems, cfg.maxPreviewChars),
    };
    return JSON.stringify(summary, null, 2);
  } catch {
    return summarizeLineBlock(text, "json", cfg);
  }
};

const isLikelyBlob = (text: string): boolean => {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^data:[^;]+;base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) return true;
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  if (/^[A-Fa-f0-9\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return true;
  return false;
};

const summarizeBlobText = (text: string, cfg: PayloadBlockConfig): string => {
  const trimmed = text.trim();
  const preview = clipText(trimmed.replace(/\s+/g, ""), cfg.maxPreviewChars);
  let blobKind = "blob";
  if (trimmed.startsWith("data:")) blobKind = "data_url";
  else if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) blobKind = "base64";
  else if (/^[A-Fa-f0-9\s]+$/.test(trimmed)) blobKind = "hex";

  return `[${blobKind} reduced chars=${trimmed.length} preview=${preview}]`;
};

const getBlockConfig = (cfg: ToolPayloadTrimConfig, kind: PayloadKind): PayloadBlockConfig => {
  if (kind === "stdout") return cfg.stdout;
  if (kind === "stderr") return cfg.stderr;
  if (kind === "json") return cfg.json;
  return cfg.blob;
};

const reduceTextByKind = (
  text: string,
  kind: PayloadKind,
  cfg: ToolPayloadTrimConfig,
): { text: string; changed: boolean } => {
  const blockCfg = getBlockConfig(cfg, kind);
  if (!blockCfg.enabled) return { text, changed: false };

  const nextText =
    kind === "json"
      ? summarizeJsonText(text, blockCfg)
      : kind === "blob"
        ? summarizeBlobText(text, blockCfg)
        : summarizeLineBlock(text, kind, blockCfg);

  return {
    text: nextText,
    changed: nextText !== text,
  };
};

const reduceSegment = (
  segment: ContextSegment,
  cfg: ToolPayloadTrimConfig,
  payloadKind: PayloadKind,
): { text: string; changed: boolean } => {
  return reduceTextByKind(segment.text, payloadKind, cfg);
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
    const segmentMap = new Map<string, { segment: ContextSegment; payloadKind: PayloadKind }>();
    for (const instr of toolPayloadInstructions) {
      const payloadKind = (instr.parameters?.payloadKind as PayloadKind) ?? "stdout";
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
    const reducedKinds = new Set<PayloadKind>();

    const workspaceDir =
      typeof turnCtx.metadata?.workspaceDir === "string"
        ? turnCtx.metadata.workspaceDir
        : undefined;
    const archivePaths: string[] = [];
    let skippedNoNetSavings = 0;
    const nextSegments = await Promise.all(turnCtx.segments.map(async (segment) => {
      const entry = segmentMap.get(segment.id);
      if (!entry) return segment;

      const reduced = reduceSegment(segment, cfg, entry.payloadKind);
      if (!reduced.changed) return segment;

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
        return segment;
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
          reducedPreviewChars: reduced.text.length,
        },
      });

      touchedSegmentIds.push(segment.id);
      reducedKinds.add(entry.payloadKind);
      archivePaths.push(archivePath);

      return {
        ...segment,
        text: replacementText,
        metadata: {
          ...segment.metadata,
          reduction: {
            ...(segment.metadata?.reduction as Record<string, unknown> ?? {}),
            toolPayloadTrim: {
              reduced: true,
              payloadKind: entry.payloadKind,
              dataKey,
              originalSize: segment.text.length,
              reducedSize: reduced.text.length,
              archivePath,
            },
          },
        },
      };
    }));

    if (touchedSegmentIds.length === 0) {
      return {
        changed: false,
        skippedReason: skippedNoNetSavings > 0 ? "no_net_savings" : "no_segments_reduced",
      };
    }

    return {
      changed: true,
      turnCtx: {
        ...turnCtx,
        segments: nextSegments,
      },
      note: `${cfg.noteLabel}:${[...reducedKinds].join(",") || "mixed"}`,
      touchedSegmentIds,
      metadata: {
        reducedKinds: [...reducedKinds],
        archivePaths,
      },
    };
  },
};
