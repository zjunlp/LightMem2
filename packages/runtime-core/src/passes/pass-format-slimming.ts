import type { RuntimeTurnResult, RuntimeTurnContext } from "@tokenpilot/kernel";
import type { ReductionPassHandler } from "../reduction/types.js";

type AsObject<T> = T extends Record<string, unknown> ? T : Record<string, unknown>;

const asObject = <T>(value: unknown): AsObject<T> | undefined => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as AsObject<T>)
    : undefined;
};

const applyFormatSlimming = (
  content: string,
  options: {
    removeCodeFences: boolean;
    collapseBlankLines: boolean;
    trimTrailingSpaces: boolean;
  },
): { content: string; changed: boolean } => {
  let result = content;

  if (options.removeCodeFences) {
    result = result.replace(/```[a-zA-Z0-9_-]*\n?/g, "").replace(/\n```/g, "");
  }
  if (options.collapseBlankLines) {
    result = result.replace(/\n{3,}/g, "\n\n");
  }
  if (options.trimTrailingSpaces) {
    result = result.replace(/[ \t]+\n/g, "\n");
  }

  return {
    content: result,
    changed: result !== content,
  };
};

export const formatSlimmingPass: ReductionPassHandler = {
  afterCall({ currentResult, spec, turnCtx }) {
    // Check if policy provided instructions for this strategy
    const policy = asObject(turnCtx.metadata?.policy);
    const decisions = asObject(policy?.decisions);
    const reduction = asObject(decisions?.reduction);
    const instructions = Array.isArray(reduction?.instructions)
      ? (reduction.instructions as Array<{ strategy: string; segmentIds: string[]; parameters?: Record<string, unknown> }>)
      : [];

    // Find instructions for format_slimming strategy
    const formatSlimmingInstructions = instructions.filter(
      (instr) => instr.strategy === "format_slimming",
    );

    // If no instructions, skip (policy didn't identify format slimming candidates)
    if (formatSlimmingInstructions.length === 0) {
      return {
        changed: false,
        skippedReason: "no_policy_instructions",
      };
    }

    // Get options from instruction parameters or spec
    const instrParams = formatSlimmingInstructions[0]?.parameters ?? {};
    const options = {
      removeCodeFences: spec.options?.removeCodeFences !== false,
      collapseBlankLines: spec.options?.collapseBlankLines !== false,
      trimTrailingSpaces: spec.options?.trimTrailingSpaces !== false,
    };

    const { content, changed } = applyFormatSlimming(currentResult.content, options);

    if (!changed) {
      return {
        changed: false,
        skippedReason: "no_format_savings",
      };
    }

    return {
      changed: true,
      note: `format_slimming:${options.removeCodeFences ? "code_fences," : ""}${options.collapseBlankLines ? "blank_lines," : ""}${options.trimTrailingSpaces ? "trailing_spaces," : ""}`.replace(/,$/, ""),
      result: {
        ...currentResult,
        content,
      },
      metadata: {
        formatSlimming: {
          originalSize: currentResult.content.length,
          reducedSize: content.length,
          savedChars: currentResult.content.length - content.length,
        },
      },
    };
  },
};
