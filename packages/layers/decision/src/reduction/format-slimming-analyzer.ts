import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

type FormatInfo = {
  index: number;
  segmentId: string;
  chars: number;
  lineCount: number;
  formatType: "json" | "xml" | "html" | "markdown" | "log" | "code" | "mixed";
  hasExcessWhitespace: boolean;
  estimatedSavingsRatio: number;
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

const detectFormatType = (text: string): FormatInfo["formatType"] => {
  const trimmed = text.trim();

  // JSON detection
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }

  // XML detection
  if (trimmed.startsWith("<?xml") || (trimmed.startsWith("<") && trimmed.endsWith(">"))) {
    return "xml";
  }

  // HTML detection
  if (/<[a-z][\s\S]*>/i.test(trimmed) && (trimmed.includes("</") || trimmed.includes("/>"))) {
    return "html";
  }

  // Markdown detection
  if (/^#{1,6}\s|^[-*+]\s|^\d+\.\s|^\[.+\]\(|^\s{4,}/m.test(text)) {
    return "markdown";
  }

  // Log detection (timestamp patterns)
  if (/^\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}:\d{2}|^\[\d{4}[-/]|^\d{2}:\d{2}:\d{2}\.\d{3}/m.test(text)) {
    return "log";
  }

  // Code detection (common patterns)
  if (/^(import |from |export |function |const |let |var |class |interface |type )/m.test(text) ||
      /^[a-zA-Z_][a-zA-Z0-9_]*\s*[:=]\s*/m.test(text)) {
    return "code";
  }

  return "mixed";
};

const detectExcessWhitespace = (text: string): boolean => {
  // Multiple consecutive blank lines
  if (/\n{3,}/.test(text)) return true;

  // Trailing whitespace on lines
  if (/^[ \t]+$/m.test(text)) return true;

  // Lines with excessive leading whitespace (not code indentation)
  const lines = text.split("\n");
  const hasExcessiveIndent = lines.some(line => {
    const leadingSpaces = line.match(/^( *)/);
    return leadingSpaces && leadingSpaces[0].length > 8;
  });
  if (hasExcessiveIndent) return true;

  // Very short lines with lots of whitespace (pretty-printed)
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  if (nonEmptyLines.length > 10) {
    const avgLineLength = text.length / nonEmptyLines.length;
    const avgContentLength = nonEmptyLines.reduce((sum, l) => sum + l.trim().length, 0) / nonEmptyLines.length;
    if (avgLineLength > 0 && avgContentLength / avgLineLength < 0.5) return true;
  }

  return false;
};

const estimateSavingsRatio = (formatType: FormatInfo["formatType"], hasExcessWhitespace: boolean): number => {
  // Base ratios by format type
  const baseRatios: Record<FormatInfo["formatType"], number> = {
    json: 0.15,      // Minifying JSON saves ~15%
    xml: 0.25,       // Removing tags/whitespace saves ~25%
    html: 0.20,      // Stripping HTML saves ~20%
    markdown: 0.08,  // Markdown doesn't slim much
    log: 0.05,       // Logs don't slim much
    code: 0.05,      // Code doesn't slim much
    mixed: 0.10,     // Mixed content
  };

  const baseRatio = baseRatios[formatType] ?? 0.10;

  // Additional savings from whitespace removal
  const whitespaceBonus = hasExcessWhitespace ? 0.15 : 0;

  return Math.min(0.50, baseRatio + whitespaceBonus);
};

// ============================================================================
// Format Slimming Analyzer
// ============================================================================

export type FormatSlimmingAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<FormatSlimmingAnalyzerConfig> = {
  enabled: true,
  minChars: 1200,
  minSavedChars: 50,
};

/**
 * Analyze context for segments that can benefit from format slimming.
 *
 * Strategy:
 * - Detect formatted content (JSON, XML, HTML, markdown, logs, code)
 * - Identify segments with excess whitespace or formatting overhead
 * - Estimate potential savings based on format type
 */
export function analyzeFormatSlimming(
  segments: ContextSegment[],
  config: FormatSlimmingAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["format_slimming_analyzer_disabled"],
    };
  }

  // Detect formattable segments
  const formatSegments: FormatInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.text.length < cfg.minChars) continue;

    const formatType = detectFormatType(segment.text);
    const hasExcessWhitespace = detectExcessWhitespace(segment.text);
    const estimatedSavingsRatio = estimateSavingsRatio(formatType, hasExcessWhitespace);
    const estimatedSavings = Math.round(segment.text.length * estimatedSavingsRatio);

    if (estimatedSavings < cfg.minSavedChars) continue;

    formatSegments.push({
      index: i,
      segmentId: segment.id,
      chars: segment.text.length,
      lineCount: countLines(segment.text),
      formatType,
      hasExcessWhitespace,
      estimatedSavingsRatio,
    });
  }

  // Build instructions for slimming candidates
  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const seg of formatSegments) {
    const savings = Math.round(seg.chars * seg.estimatedSavingsRatio);

    instructions.push({
      strategy: "format_slimming",
      segmentIds: [seg.segmentId],
      confidence: seg.formatType === "json" ? 0.95 : seg.formatType === "xml" ? 0.90 : 0.75,
      priority: 5,
      rationale: `${seg.formatType} content (${seg.chars.toLocaleString()} chars, ${seg.lineCount} lines) can be slimmed by ~${Math.round(seg.estimatedSavingsRatio * 100)}%`,
      parameters: {
        formatType: seg.formatType,
        lineCount: seg.lineCount,
        estimatedSavingsRatio: seg.estimatedSavingsRatio,
        hasExcessWhitespace: seg.hasExcessWhitespace,
      },
    });

    estimatedSavedChars += savings;
  }

  return {
    enabled: true,
    instructions,
    estimatedSavedChars,
    notes: [
      `analyzed_segments=${segments.length}`,
      `format_candidates=${formatSegments.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}

/**
 * Debug helper - returns detailed analysis for inspection
 */
export function debugFormatSlimmingAnalysis(
  segments: ContextSegment[],
  config: FormatSlimmingAnalyzerConfig = {},
): {
  config: Required<FormatSlimmingAnalyzerConfig>;
  totalSegments: number;
  formatSegments: FormatInfo[];
  decision: ReductionDecision;
} {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const decision = analyzeFormatSlimming(segments, cfg);

  const formatSegments: FormatInfo[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.text.length < cfg.minChars) continue;

    const formatType = detectFormatType(segment.text);
    const hasExcessWhitespace = detectExcessWhitespace(segment.text);
    const estimatedSavingsRatio = estimateSavingsRatio(formatType, hasExcessWhitespace);

    formatSegments.push({
      index: i,
      segmentId: segment.id,
      chars: segment.text.length,
      lineCount: countLines(segment.text),
      formatType,
      hasExcessWhitespace,
      estimatedSavingsRatio,
    });
  }

  return {
    config: cfg,
    totalSegments: segments.length,
    formatSegments,
    decision,
  };
}
