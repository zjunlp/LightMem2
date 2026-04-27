import type { ReductionPassHandler } from "../reduction/types.js";
import {
  stripEmptyLines,
  stripHtmlComments,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  normalizeExcessWhitespace,
} from "@tokenpilot/decision";

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

const applyFormatCleaning = (
  content: string,
  kinds: string[],
): { content: string; changed: boolean; cleanedKinds: string[] } => {
  let result = content;
  const cleanedKinds: string[] = [];

  if (kinds.includes("empty_lines")) {
    const stripped = stripEmptyLines(result);
    if (stripped !== result) {
      result = stripped;
      cleanedKinds.push("empty_lines");
    }
  }

  if (kinds.includes("html_comments")) {
    const { content: stripped, stripped: wasStripped } = stripHtmlComments(result);
    if (wasStripped) {
      result = stripped;
      cleanedKinds.push("html_comments");
    }
  }

  if (kinds.includes("full_width_chars")) {
    const normalized = normalizeFullWidthSpace(normalizeFullWidthDigits(result));
    if (normalized !== result) {
      result = normalized;
      cleanedKinds.push("full_width_chars");
    }
  }

  if (kinds.includes("excess_whitespace")) {
    const normalized = normalizeExcessWhitespace(result);
    if (normalized !== result) {
      result = normalized;
      cleanedKinds.push("excess_whitespace");
    }
  }

  return {
    content: result,
    changed: result !== content,
    cleanedKinds,
  };
};

export const formatCleaningPass: ReductionPassHandler = {
  afterCall({ currentResult, spec, turnCtx }) {
    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for format_cleaning strategy
    const formatCleaningInstructions = instructions.filter(
      (instr) => instr.strategy === "format_cleaning",
    );

    // If no instructions, skip (policy didn't identify format cleaning candidates)
    if (formatCleaningInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Get cleaning kinds from instruction parameters
    const instrParams = formatCleaningInstructions[0]?.parameters ?? {};
    const cleaningKinds = (instrParams.cleaningKinds as string[]) ?? [];

    if (cleaningKinds.length === 0) {
      return {
        changed: false,
        skippedReason: "no_cleaning_kinds_specified",
      };
    }

    const { content, changed, cleanedKinds } = applyFormatCleaning(
      currentResult.content,
      cleaningKinds,
    );

    if (!changed) {
      return {
        changed: false,
        skippedReason: "no_cleaning_applied",
      };
    }

    return {
      changed: true,
      note: `format_cleaning:${cleanedKinds.join(",")}`,
      result: {
        ...currentResult,
        content,
      },
      metadata: {
        formatCleaning: {
          originalSize: currentResult.content.length,
          reducedSize: content.length,
          savedChars: currentResult.content.length - content.length,
          cleanedKinds,
        },
      },
    };
  },
};
