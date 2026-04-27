import type { ReductionPassHandler } from "../reduction/types.js";
import { stripLineNumbers } from "@tokenpilot/decision";

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

export const lineNumberStripPass: ReductionPassHandler = {
  afterCall({ currentResult, spec, turnCtx }) {
    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for line_number_strip strategy
    const lineNumberStripInstructions = instructions.filter(
      (instr) => instr.strategy === "line_number_strip",
    );

    // If no instructions, skip (policy didn't identify line number strip candidates)
    if (lineNumberStripInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    const { content, stripped, removedCharCount } = stripLineNumbers(currentResult.content);

    if (!stripped) {
      return {
        changed: false,
        skippedReason: "no_line_numbers_to_strip",
      };
    }

    return {
      changed: true,
      note: `line_number_strip:${removedCharCount} chars removed`,
      result: {
        ...currentResult,
        content,
      },
      metadata: {
        lineNumberStrip: {
          originalSize: currentResult.content.length,
          reducedSize: content.length,
          savedChars: removedCharCount,
        },
      },
    };
  },
};
