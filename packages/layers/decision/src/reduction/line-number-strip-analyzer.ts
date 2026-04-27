import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type LineNumberStripInfo = {
  index: number;
  segmentId: string;
  lineCount: number;
  estimatedSavings: number;
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Pattern for line number prefixes from file read tools
 * Matches patterns like:
 * - "   1 | " (with pipe separator, common in Claude Code)
 * - "1: " or "  1: " (with colon)
 * - "   1  " (just numbers with padding)
 */
const LINE_NUMBER_PATTERN = /^\s*\d+\s*[|:\]\s]\s?/m;

/**
 * Check if content has line number prefixes
 */
function hasLineNumbers(content: string): boolean {
  const lines = content.split("\n");
  let matchCount = 0;

  // Need at least 3 lines with line numbers to be considered a pattern
  for (const line of lines.slice(0, Math.min(50, lines.length))) {
    if (LINE_NUMBER_PATTERN.test(line)) {
      matchCount++;
      if (matchCount >= 3) return true;
    }
  }

  return false;
}

/**
 * Strip line number prefixes from content
 * Returns the stripped content and whether any stripping occurred
 */
export function stripLineNumbers(
  content: string,
): { content: string; stripped: boolean; removedCharCount: number } {
  const originalLength = content.length;
  const lines = content.split("\n");

  const strippedLines = lines.map((line) => {
    // Pattern 1: "   1 | " or "   1| " (with pipe)
    const pipeMatch = line.match(/^\s*\d+\s*\|\s?/);
    if (pipeMatch) {
      return line.slice(pipeMatch[0].length);
    }

    // Pattern 2: "1: " or "  1: " (with colon)
    const colonMatch = line.match(/^\s*\d+\s*:\s?/);
    if (colonMatch) {
      return line.slice(colonMatch[0].length);
    }

    // Pattern 3: "   1  " (just line number with padding at start)
    // Only strip if it looks like a line number prefix (digits followed by space)
    const numberMatch = line.match(/^(\s*\d+\s{2,})/);
    if (numberMatch) {
      return line.slice(numberMatch[1].length);
    }

    return line;
  });

  const result = strippedLines.join("\n");
  const stripped = result !== content;

  return {
    content: result,
    stripped,
    removedCharCount: originalLength - result.length,
  };
}

/**
 * Estimate savings from stripping line numbers
 */
function estimateLineNumberSavings(content: string): number {
  const lines = content.split("\n");
  let totalSavings = 0;

  for (const line of lines) {
    // Estimate: line number prefix is typically 5-10 chars per line
    if (LINE_NUMBER_PATTERN.test(line)) {
      const pipeMatch = line.match(/^\s*\d+\s*\|\s?/);
      if (pipeMatch) {
        totalSavings += pipeMatch[0].length;
        continue;
      }

      const colonMatch = line.match(/^\s*\d+\s*:\s?/);
      if (colonMatch) {
        totalSavings += colonMatch[0].length;
        continue;
      }

      const numberMatch = line.match(/^(\s*\d+\s{2,})/);
      if (numberMatch) {
        totalSavings += numberMatch[1].length;
      }
    }
  }

  return totalSavings;
}

// ============================================================================
// Line Number Strip Analyzer
// ============================================================================

export type LineNumberStripAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  minLines?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<LineNumberStripAnalyzerConfig> = {
  enabled: true,
  minChars: 500,
  minLines: 20,
  minSavedChars: 50,
};

/**
 * Analyze context for segments with line number prefixes that need stripping.
 *
 * Line number strip strategy:
 * - Detect file read outputs with line number prefixes
 * - Remove line number prefixes (e.g., "   1 | ", "1: ")
 * - Preserve actual content
 */
export function analyzeLineNumberStrip(
  segments: ContextSegment[],
  config: LineNumberStripAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["line_number_strip_analyzer_disabled"],
    };
  }

  const stripCandidates: LineNumberStripInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.text.length < cfg.minChars) continue;

    const lines = segment.text.split("\n");
    if (lines.length < cfg.minLines) continue;

    if (!hasLineNumbers(segment.text)) continue;

    const estimatedSavings = estimateLineNumberSavings(segment.text);
    if (estimatedSavings < cfg.minSavedChars) continue;

    stripCandidates.push({
      index: i,
      segmentId: segment.id,
      lineCount: lines.length,
      estimatedSavings,
    });
  }

  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const candidate of stripCandidates) {
    instructions.push({
      strategy: "line_number_strip",
      segmentIds: [candidate.segmentId],
      confidence: 0.90,
      priority: 3,
      rationale: `Line number prefixes detected in ${candidate.lineCount} lines, estimated savings: ${candidate.estimatedSavings} chars`,
      parameters: {
        lineCount: candidate.lineCount,
        estimatedSavings: candidate.estimatedSavings,
      },
    });

    estimatedSavedChars += candidate.estimatedSavings;
  }

  return {
    enabled: true,
    instructions,
    estimatedSavedChars,
    notes: [
      `analyzed_segments=${segments.length}`,
      `strip_candidates=${stripCandidates.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}
