import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

type ExecOutputInfo = {
  index: number;
  segmentId: string;
  toolName: string;
  chars: number;
  lineCount: number;
  exitCode?: number;
  hasError: boolean;
  threshold: number;
  excessChars: number;
};

// ============================================================================
// Utilities
// ============================================================================

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

const countLines = (text: string): number => {
  const matches = text.match(/\n/g);
  return matches ? matches.length + 1 : text.length > 0 ? 1 : 0;
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

// Default thresholds (matching exec_output_truncation pass)
const DEFAULT_THRESHOLD_CHARS = 50_000;

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

const extractExitCode = (metadata: Record<string, unknown> | undefined): number | undefined => {
  const toolPayload = asObject(metadata?.toolPayload);
  const execResult = asObject(toolPayload?.execResult);

  const candidates = [
    metadata?.exitCode,
    metadata?.exit_code,
    toolPayload?.exitCode,
    toolPayload?.exit_code,
    execResult?.exitCode,
    execResult?.exit_code,
  ];

  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return undefined;
};

// ============================================================================
// Exec Output Truncation Analyzer
// ============================================================================

export type ExecOutputTruncationAnalyzerConfig = {
  enabled?: boolean;
  toolThresholds?: Record<string, number>;
  minExcessChars?: number;
};

const DEFAULT_CONFIG: Required<ExecOutputTruncationAnalyzerConfig> = {
  enabled: true,
  toolThresholds: {},
  minExcessChars: 1000,
};

/**
 * Analyze context for exec/tool outputs that exceed size thresholds.
 *
 * Strategy:
 * - Detect exec/tool result segments
 * - Check against per-tool thresholds
 * - Mark segments exceeding thresholds as truncation candidates
 */
export function analyzeExecOutputTruncation(
  segments: ContextSegment[],
  config: ExecOutputTruncationAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["exec_output_truncation_analyzer_disabled"],
    };
  }

  // Detect large exec outputs
  const largeOutputs: ExecOutputInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);

    if (!tool) continue;

    const threshold = getToolThreshold(tool, cfg.toolThresholds);

    // Skip tools with Infinity threshold (e.g., read/file_read)
    if (!Number.isFinite(threshold)) continue;

    // Skip if under threshold
    if (segment.text.length <= threshold) continue;

    const excessChars = segment.text.length - threshold;
    if (excessChars < cfg.minExcessChars) continue;

    const exitCode = extractExitCode(meta);
    const hasError = typeof exitCode === "number" && exitCode !== 0;

    largeOutputs.push({
      index: i,
      segmentId: segment.id,
      toolName: tool,
      chars: segment.text.length,
      lineCount: countLines(segment.text),
      exitCode,
      hasError,
      threshold,
      excessChars,
    });
  }

  // Build instructions for truncation candidates
  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const output of largeOutputs) {
    // Estimate savings: truncation keeps head + tail preview (~1000 chars total)
    const estimatedKeepChars = 1000;
    const estimatedSavings = Math.max(0, output.chars - estimatedKeepChars);

    instructions.push({
      strategy: "exec_output_truncation",
      segmentIds: [output.segmentId],
      confidence: 0.99, // High confidence - deterministic threshold
      priority: 9, // High priority - large savings
      rationale: `${output.toolName} output (${output.chars.toLocaleString()} chars) exceeds threshold (${output.threshold.toLocaleString()} chars) by ${output.excessChars.toLocaleString()} chars`,
      parameters: {
        toolName: output.toolName,
        threshold: output.threshold,
        excessChars: output.excessChars,
        exitCode: output.exitCode,
        hasError: output.hasError,
        estimatedKeepChars,
      },
    });

    estimatedSavedChars += estimatedSavings;
  }

  return {
    enabled: true,
    instructions,
    estimatedSavedChars,
    notes: [
      `analyzed_segments=${segments.length}`,
      `large_exec_outputs=${largeOutputs.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}

/**
 * Debug helper - returns detailed analysis for inspection
 */
export function debugExecOutputTruncationAnalysis(
  segments: ContextSegment[],
  config: ExecOutputTruncationAnalyzerConfig = {},
): {
  config: Required<ExecOutputTruncationAnalyzerConfig>;
  totalSegments: number;
  largeOutputs: ExecOutputInfo[];
  decision: ReductionDecision;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const decision = analyzeExecOutputTruncation(segments, cfg);

  const largeOutputs: ExecOutputInfo[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const meta = asObject(segment.metadata) ?? {};
    const tool = normalizeToolName(meta);
    if (!tool) continue;

    const threshold = getToolThreshold(tool, cfg.toolThresholds);
    if (!Number.isFinite(threshold)) continue;
    if (segment.text.length <= threshold) continue;

    const excessChars = segment.text.length - threshold;
    if (excessChars < cfg.minExcessChars) continue;

    const exitCode = extractExitCode(meta);

    largeOutputs.push({
      index: i,
      segmentId: segment.id,
      toolName: tool,
      chars: segment.text.length,
      lineCount: countLines(segment.text),
      exitCode,
      hasError: typeof exitCode === "number" && exitCode !== 0,
      threshold,
      excessChars,
    });
  }

  return {
    config: cfg,
    totalSegments: segments.length,
    largeOutputs,
    decision,
  };
}
