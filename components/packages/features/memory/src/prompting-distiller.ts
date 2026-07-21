import { distillQueueEntriesWithLlm } from "./llm-distill.js";
import type { DistillProviderConfig, SkillDistiller } from "./types.js";

export function createPromptingDistiller(provider: DistillProviderConfig): SkillDistiller {
  return {
    async distill(params) {
      return distillQueueEntriesWithLlm({
        provider,
        entries: params.entries,
      });
    },
  };
}
