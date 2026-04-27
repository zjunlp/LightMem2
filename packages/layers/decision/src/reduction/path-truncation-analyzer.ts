import type { ContextSegment } from "@tokenpilot/kernel";
import type { ReductionDecision, ReductionInstruction } from "../types.js";

// ============================================================================
// Types
// ============================================================================

type PathTruncationInfo = {
  index: number;
  segmentId: string;
  originalPath: string;
  truncatedPath: string;
  estimatedSavings: number;
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Truncate a file path to fit within a max length
 * Strategy: keep filename + leading context + ellipsis
 */
export function truncatePath(path: string, maxLength: number = 80): string {
  if (path.length <= maxLength) return path;

  const lastSlashIndex = path.lastIndexOf("/");
  if (lastSlashIndex === -1) {
    // No slash, just truncate with ellipsis
    return `...${path.slice(-(maxLength - 3))}`;
  }

  const fileName = path.slice(lastSlashIndex + 1);
  const maxDirLength = maxLength - fileName.length - 4; // 4 for ".../"

  if (maxDirLength <= 0) {
    // Filename itself is too long
    return `${fileName.slice(0, maxLength - 3)}...`;
  }

  if (path.length <= maxDirLength + fileName.length + 1) {
    return path;
  }

  const truncatedDir = `...${path.slice(-(maxDirLength - 3))}`;
  return `${truncatedDir}/${fileName}`;
}

/**
 * Find paths in content that exceed max length
 * Returns array of { original, truncated, savings }
 */
function findLongPaths(
  content: string,
  maxLength: number = 80,
): { original: string; truncated: string; savings: number }[] {
  const results: { original: string; truncated: string; savings: number }[] = [];

  // Match file paths (Unix-style or Windows-style)
  const pathMatch =
    /((?:\/[\w\-.~]+)+\/[\w\-.~]+\.[\w]+)|(?:[A-Za-z]:\\(?:[\w\-.~]+\\)+[\w\-.~]+\.[\w]+)/g;

  let match: RegExpExecArray | null;
  while ((match = pathMatch.exec(content)) !== null) {
    const path = match[0];
    if (path.length > maxLength) {
      const truncated = truncatePath(path, maxLength);
      results.push({
        original: path,
        truncated,
        savings: path.length - truncated.length,
      });
    }
  }

  return results;
}

const estimatePathSavings = (content: string, maxLength: number): number => {
  const longPaths = findLongPaths(content, maxLength);
  return longPaths.reduce((sum, { savings }) => sum + savings, 0);
};

// ============================================================================
// Path Truncation Analyzer
// ============================================================================

export type PathTruncationAnalyzerConfig = {
  enabled?: boolean;
  minChars?: number;
  maxPathLength?: number;
  minSavedChars?: number;
};

const DEFAULT_CONFIG: Required<PathTruncationAnalyzerConfig> = {
  enabled: true,
  minChars: 100,
  maxPathLength: 80,
  minSavedChars: 20,
};

/**
 * Analyze context for segments with long file paths that need truncation.
 *
 * Path truncation strategy:
 * - Keep filename intact
 * - Truncate directory path with "..." prefix
 * - Preserve path structure
 */
export function analyzePathTruncation(
  segments: ContextSegment[],
  config: PathTruncationAnalyzerConfig = DEFAULT_CONFIG,
): ReductionDecision {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      enabled: false,
      instructions: [],
      estimatedSavedChars: 0,
      notes: ["path_truncation_analyzer_disabled"],
    };
  }

  const truncationCandidates: PathTruncationInfo[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment.text.length < cfg.minChars) continue;

    const longPaths = findLongPaths(segment.text, cfg.maxPathLength);
    if (longPaths.length === 0) continue;

    const totalSavings = longPaths.reduce(
      (sum, { savings }) => sum + savings,
      0,
    );
    if (totalSavings < cfg.minSavedChars) continue;

    const longestPath = longPaths.reduce(
      (max, curr) => (curr.original.length > max.original.length ? curr : max),
      longPaths[0],
    );

    truncationCandidates.push({
      index: i,
      segmentId: segment.id,
      originalPath: longestPath.original,
      truncatedPath: longestPath.truncated,
      estimatedSavings: totalSavings,
    });
  }

  const instructions: ReductionInstruction[] = [];
  let estimatedSavedChars = 0;

  for (const candidate of truncationCandidates) {
    instructions.push({
      strategy: "path_truncation",
      segmentIds: [candidate.segmentId],
      confidence: 0.85,
      priority: 3,
      rationale: `Path truncation needed: "${candidate.originalPath}" exceeds ${cfg.maxPathLength} chars, estimated savings: ${candidate.estimatedSavings} chars`,
      parameters: {
        maxPathLength: cfg.maxPathLength,
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
      `truncation_candidates=${truncationCandidates.length}`,
      `estimated_saved_chars=${estimatedSavedChars}`,
    ],
  };
}
