import type { ReductionPassHandler } from "../reduction/types.js";
import { truncatePath } from "@tokenpilot/decision";

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

const applyPathTruncation = (
  content: string,
  maxLength: number,
): { content: string; changed: boolean; truncatedCount: number } => {
  let result = content;
  let truncatedCount = 0;

  // Match file paths (Unix-style or Windows-style)
  const pathMatch =
    /((?:\/[\w\-.~]+)+\/[\w\-.~]+\.[\w]+)|(?:[A-Za-z]:\\(?:[\w\-.~]+\\)+[\w\-.~]+\.[\w]+)/g;

  let match: RegExpExecArray | null;
  const replacedPaths = new Set<string>();

  while ((match = pathMatch.exec(result)) !== null) {
    const path = match[0];
    if (path.length > maxLength && !replacedPaths.has(path)) {
      const truncated = truncatePath(path, maxLength);
      if (truncated !== path) {
        // Replace all occurrences of this path
        const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escapedPath, "g");
        result = result.replace(regex, truncated);
        truncatedCount++;
        replacedPaths.add(path);
      }
    }
  }

  return {
    content: result,
    changed: result !== content,
    truncatedCount,
  };
};

export const pathTruncationPass: ReductionPassHandler = {
  afterCall({ currentResult, spec, turnCtx }) {
    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for path_truncation strategy
    const pathTruncationInstructions = instructions.filter(
      (instr) => instr.strategy === "path_truncation",
    );

    // If no instructions, skip (policy didn't identify path truncation candidates)
    if (pathTruncationInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Get max path length from instruction parameters or spec
    const instrParams = pathTruncationInstructions[0]?.parameters ?? {};
    const maxLength =
      (instrParams.maxPathLength as number)
      ?? (typeof spec.options?.maxPathLength === "number" ? spec.options.maxPathLength : undefined)
      ?? 80;

    const { content, changed, truncatedCount } = applyPathTruncation(
      currentResult.content,
      maxLength,
    );

    if (!changed) {
      return {
        changed: false,
        skippedReason: "no_paths_to_truncate",
      };
    }

    return {
      changed: true,
      note: `path_truncation:${truncatedCount} paths truncated to ${maxLength} chars`,
      result: {
        ...currentResult,
        content,
      },
      metadata: {
        pathTruncation: {
          originalSize: currentResult.content.length,
          reducedSize: content.length,
          savedChars: currentResult.content.length - content.length,
          truncatedCount,
          maxLength,
        },
      },
    };
  },
};
