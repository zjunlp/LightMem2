import type { ProviderAdapter } from "@ecoclaw/kernel";

export const openaiAdapter: ProviderAdapter = {
  provider: "openai",
  async annotatePrompt(ctx) {
    // OpenAI prompt caching is mostly automatic; keep prefix stable.
    return ctx;
  },
  normalizeUsage(raw) {
    const usage = raw as any;
    return {
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
      providerRaw: raw,
    };
  },
};

