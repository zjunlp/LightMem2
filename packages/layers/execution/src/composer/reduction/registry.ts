import { formatSlimmingPass } from "../../atomic/passes/pass-format-slimming.js";
import { htmlSlimmingPass } from "../../atomic/passes/pass-html-slimming.js";
import { semanticLlmlingua2Pass } from "../../atomic/passes/pass-semantic-llmlingua2.js";
import { toolPayloadTrimPass } from "../../atomic/passes/pass-tool-payload-trim.js";
import { execOutputTruncationPass, execOutputTruncationBeforeCall } from "../../atomic/passes/pass-exec-output-truncation.js";
import { repeatedReadDedupPass } from "../../atomic/passes/pass-repeated-read-dedup.js";
import { formatCleaningPass } from "../../atomic/passes/pass-format-cleaning.js";
import { pathTruncationPass } from "../../atomic/passes/pass-path-truncation.js";
import { imageDownsamplePass } from "../../atomic/passes/pass-image-downsample.js";
import { lineNumberStripPass } from "../../atomic/passes/pass-line-number-strip.js";
import { agentsStartupOptimizationPass } from "../../atomic/passes/pass-agents-startup-optimization.js";
import type {
  BuiltinReductionPassId,
  ReductionPassId,
  ReductionPassRegistry,
  ReductionPassHandler,
} from "./types.js";

const BUILTIN_PASSES: Record<BuiltinReductionPassId, ReductionPassHandler> = {
  tool_payload_trim: toolPayloadTrimPass,
  html_slimming: htmlSlimmingPass,
  format_slimming: formatSlimmingPass,
  semantic_llmlingua2: semanticLlmlingua2Pass,
  exec_output_truncation: execOutputTruncationPass,
  repeated_read_dedup: repeatedReadDedupPass,
  format_cleaning: formatCleaningPass,
  path_truncation: pathTruncationPass,
  image_downsample: imageDownsamplePass,
  line_number_strip: lineNumberStripPass,
  agents_startup_optimization: agentsStartupOptimizationPass,
};

// Passes that need both beforeCall and afterCall handlers
export const execOutputTruncationBeforeCallPass = execOutputTruncationBeforeCall;

export function resolveReductionPass(
  id: ReductionPassId,
  overrides?: ReductionPassRegistry,
): ReductionPassHandler | undefined {
  return overrides?.[id] ?? BUILTIN_PASSES[id as BuiltinReductionPassId];
}

export function listBuiltinReductionPasses(): BuiltinReductionPassId[] {
  return Object.keys(BUILTIN_PASSES) as BuiltinReductionPassId[];
}
