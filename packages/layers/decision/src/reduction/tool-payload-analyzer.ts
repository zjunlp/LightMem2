import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

type ToolPayloadInfo = {
  index: number;
  segmentId: string;
  toolName: string;
  payloadKind: "stdout" | "stderr" | "json" | "blob" | "other";
  chars: number;
  isLikelyToolPayload: boolean;
};

// ============================================================================
// Utilities
// ============================================================================

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
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

const isLikelyReductionToolPayloadSegment = (segment: ContextSegment): boolean => {
  const metadata = asObject(segment.metadata);
  const reduction = asObject(metadata?.reduction);
  const toolPayload = asObject(metadata?.toolPayload);
  const reductionTrim = asObject(reduction?.toolPayloadTrim);

  const payloadKind = [
    reductionTrim?.kind,
    toolPayload?.kind,
    reduction?.payloadKind,
    metadata?.payloadKind,
  ].find((value) => typeof value === "string");

  if (payloadKind) return true;

  const explicitEnabled =
    reductionTrim?.enabled === true ||
    toolPayload?.enabled === true ||
    metadata?.isToolPayload === true ||
    reduction?.target === "tool_payload";

  if (explicitEnabled) return true;

  const role = typeof metadata?.role === "string" ? metadata.role : "";
  if (role === "tool" || role === "tool_result") return true;

  return false;
};

const detectPayloadKind = (segment: ContextSegment): "stdout" | "stderr" | "json" | "blob" | "other" => {
  const metadata = asObject(segment.metadata);
  const toolPayload = asObject(metadata?.toolPayload);

  const explicitKind = toolPayload?.kind as string | undefined;
  if (explicitKind && ["stdout", "stderr", "json", "blob"].includes(explicitKind)) {
    return explicitKind as "stdout" | "stderr" | "json" | "blob";
  }

  const text = segment.text;

  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // Not valid JSON, continue checking
    }
  }

  if (text.includes("stderr") || text.includes("ERROR") || text.includes("error:")) {
    return "stderr";
  }

  if (text.includes("stdout") || /^[A-Za-z0-9\s\-\[\]{}:,"'.]+$/s.test(text)) {
    return "stdout";
  }

  if (text.length > 500 && !/[\n\r]/.test(text)) {
    return "blob";
  }

  return "other";
};

// ============================================================================
// Tool Payload Analyzer
// ============================================================================

export type ToolPayloadAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  minSavedChars?: number;
  onlyLikelyToolSegments?: boolean;
};

const DEFAULT_CONFIG: Required<ToolPayloadAnalyzerConfig> = {
  enabled: true,
  minChars: 200,
  minSavedChars: 100,
  onlyLikelyToolSegments: true,
};

/**
 * Analyze context for tool payload segments that can be trimmed.
 *
 * Strategy:
 * - Detect segments that are tool payloads (stdout, stderr, json, blob)
 * - Mark large payloads as reduction candidates
 * - Estimate savings based on typical trim ratios
 */
export function analyzeToolPayloadTrim(
  segments: ContextSegment[],
  config: ToolPayloadAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["tool_payload_analyzer_disabled"],
    };
  }

  // Detect tool payload segments
  const payloadSegments: ToolPayloadInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];

    if (cfg.onlyLikelyToolSegments && !isLikelyReductionToolPayloadSegment(segment)) {
      continue;
    }

    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);

    if (!tool) continue;
    if (segment.text.length < cfg.minChars) continue;

    const payloadKind = detectPayloadKind(segment);
    const isLikelyToolPayload = isLikelyReductionToolPayloadSegment(segment);

    payloadSegments.push({
      index: i,
      segmentId: segment.id,
      toolName: tool,
      payloadKind,
      chars: segment.text.length,
      isLikelyToolPayload,
    });
  }

  // Build instructions for trimmable payloads
  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  // Group by payload kind for batching
  const byKind = new Map<string, ToolPayloadInfo[]>();
  for (const seg of payloadSegments) {
    const key = seg.payloadKind;
    const existing = byKind.get(key) ?? [];
    existing.push(seg);
    byKind.set(key, existing);
  }

  for (const [kind, kindSegments] of byKind.entries()) {
    const totalChars = kindSegments.reduce((sum, s) => sum + s.chars, 0);
    if (totalChars < cfg.minSavedChars) continue;

    // Estimate savings: ~65% reduction for tool payloads
    const savedChars = Math.round(totalChars * 0.65);

    instructions.push({
      strategy: "tool_payload_trim",
      segmentIds: kindSegments.map((s) => s.segmentId),
      confidence: kind === "json" ? 0.9 : kind === "stdout" ? 0.8 : 0.7,
      priority: 8,
      rationale: `Found ${kindSegments.length} ${kind} payload(s) totaling ${totalChars.toLocaleString()} chars; estimated ${savedChars.toLocaleString()} chars savings`,
      parameters: {
        payloadKind: kind,
        segmentCount: kindSegments.length,
        totalChars,
        estimatedKeepRatio: 0.35,
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
      `tool_payload_segments=${payloadSegments.length}`,
      `payload_groups=${instructions.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}

/**
 * Debug helper - returns detailed analysis for inspection
 */
export function debugToolPayloadAnalysis(
  segments: ContextSegment[],
  config: ToolPayloadAnalyzerConfig = {},
): {
  config: Required<ToolPayloadAnalyzerConfig>;
  totalSegments: number;
  payloadSegments: ToolPayloadInfo[];
  decision: ReductionDecision;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const decision = analyzeToolPayloadTrim(segments, cfg);

  const payloadSegments: ToolPayloadInfo[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (cfg.onlyLikelyToolSegments && !isLikelyReductionToolPayloadSegment(segment)) {
      continue;
    }
    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);
    if (!tool) continue;
    if (segment.text.length < cfg.minChars) continue;

    payloadSegments.push({
      index: i,
      segmentId: segment.id,
      toolName: tool,
      payloadKind: detectPayloadKind(segment),
      chars: segment.text.length,
      isLikelyToolPayload: isLikelyReductionToolPayloadSegment(segment),
    });
  }

  return {
    config: cfg,
    totalSegments: segments.length,
    payloadSegments,
    decision,
  };
}
