import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

type CleaningKind =
  | "empty_lines"
  | "html_comments"
  | "full_width_chars"
  | "excess_whitespace";

type CleaningInfo = {
  index: number;
  segmentId: string;
  cleaningKinds: CleaningKind[];
  estimatedSavings: number;
};

// ============================================================================
// Utilities
// ============================================================================

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

/**
 * Strip leading and trailing empty lines (claude-code: stripEmptyLines)
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split("\n");

  let startIndex = 0;
  while (startIndex < lines.length && lines[startIndex]?.trim() === "") {
    startIndex++;
  }

  let endIndex = lines.length - 1;
  while (endIndex >= 0 && lines[endIndex]?.trim() === "") {
    endIndex--;
  }

  if (startIndex > endIndex) return "";

  return lines.slice(startIndex, endIndex + 1).join("\n");
}

/**
 * Strip HTML comments (claude-code: stripHtmlComments)
 */
export function stripHtmlComments(content: string): { content: string; stripped: boolean } {
  if (!content.includes("<!--")) {
    return { content, stripped: false };
  }

  const commentSpan = /<!--[\s\S]*?-->/g;
  const result = content.replace(commentSpan, "");
  const stripped = result !== content;

  return { content: result.trim() || "", stripped };
}

/**
 * Normalize full-width digits to half-width (claude-code: normalizeFullWidthDigits)
 */
export function normalizeFullWidthDigits(input: string): string {
  return input.replace(/[0-9]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/**
 * Normalize full-width space to half-width (claude-code: normalizeFullWidthSpace)
 */
export function normalizeFullWidthSpace(input: string): string {
  return input.replace(/\u3000/g, " ");
}

/**
 * Normalize excess whitespace (multiple spaces → single space)
 */
export function normalizeExcessWhitespace(input: string): string {
  return input
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n");
}

/**
 * Check if content has empty lines to strip
 */
function hasEmptyLines(content: string): boolean {
  const lines = content.split("\n");
  if (lines.length <= 2) return false;

  // Check leading empty lines
  if (lines[0]?.trim() === "" || lines[lines.length - 1]?.trim() === "") {
    return true;
  }

  // Check multiple consecutive empty lines
  if (/\n{3,}/.test(content)) {
    return true;
  }

  return false;
}

/**
 * Check if content has HTML comments
 */
function hasHtmlComments(content: string): boolean {
  return /<!--[\s\S]*?-->/.test(content);
}

/**
 * Check if content has full-width characters
 */
function hasFullWidthChars(content: string): boolean {
  // Full-width digits: 0-9 (U+FF10 to U+FF19)
  if (/[\uFF10-\uFF19]/.test(content)) return true;
  // Full-width space: U+3000
  if (/\u3000/.test(content)) return true;
  return false;
}

/**
 * Check if content has excess whitespace
 */
function hasExcessWhitespace(content: string): boolean {
  // Multiple consecutive spaces/tabs
  if (/[ \t]{3,}/.test(content)) return true;
  // Trailing whitespace on lines
  if (/[ \t]+$/m.test(content)) return true;
  return false;
}

const estimateSavings = (content: string, kinds: CleaningKind[]): number => {
  let savings = 0;

  if (kinds.includes("empty_lines")) {
    const stripped = stripEmptyLines(content);
    savings += content.length - stripped.length;
  }

  if (kinds.includes("html_comments")) {
    const { content: stripped } = stripHtmlComments(content);
    savings += content.length - stripped.length;
  }

  if (kinds.includes("full_width_chars")) {
    const normalized = normalizeFullWidthSpace(normalizeFullWidthDigits(content));
    savings += content.length - normalized.length;
  }

  if (kinds.includes("excess_whitespace")) {
    const normalized = normalizeExcessWhitespace(content);
    savings += content.length - normalized.length;
  }

  return savings;
};

// ============================================================================
// Format Cleaning Analyzer
// ============================================================================

export type FormatCleaningAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<FormatCleaningAnalyzerConfig> = {
  enabled: true,
  minChars: 500,
  minSavedChars: 20,
};

/**
 * Analyze context for segments that need format cleaning.
 *
 * Cleaning strategies:
 * - Strip leading/trailing empty lines
 * - Strip HTML comments
 * - Normalize full-width characters to half-width
 * - Normalize excess whitespace
 */
export function analyzeFormatCleaning(
  segments: ContextSegment[],
  config: FormatCleaningAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["format_cleaning_analyzer_disabled"],
    };
  }

  const cleaningCandidates: CleaningInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.text.length < cfg.minChars) continue;

    const cleaningKinds: CleaningKind[] = [];

    if (hasEmptyLines(segment.text)) cleaningKinds.push("empty_lines");
    if (hasHtmlComments(segment.text)) cleaningKinds.push("html_comments");
    if (hasFullWidthChars(segment.text)) cleaningKinds.push("full_width_chars");
    if (hasExcessWhitespace(segment.text)) cleaningKinds.push("excess_whitespace");

    if (cleaningKinds.length === 0) continue;

    const estimatedSavings = estimateSavings(segment.text, cleaningKinds);
    if (estimatedSavings < cfg.minSavedChars) continue;

    cleaningCandidates.push({
      index: i,
      segmentId: segment.id,
      cleaningKinds,
      estimatedSavings,
    });
  }

  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const candidate of cleaningCandidates) {
    instructions.push({
      strategy: "format_cleaning",
      segmentIds: [candidate.segmentId],
      confidence: 0.90,
      priority: 4,
      rationale: `Format cleaning needed: ${candidate.cleaningKinds.join(", ")}, estimated savings: ${candidate.estimatedSavings} chars`,
      parameters: {
        cleaningKinds: candidate.cleaningKinds,
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
      `cleaning_candidates=${cleaningCandidates.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}
