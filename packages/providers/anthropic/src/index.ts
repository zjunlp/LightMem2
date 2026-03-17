import type { ProviderAdapter } from "@ecoclaw/kernel";

export const anthropicAdapter: ProviderAdapter = {
  provider: "anthropic",
  async annotatePrompt(ctx) {
    // Hook point to add cache_control on stable segments.
    return {
      ...ctx,
      metadata: {
        ...(ctx.metadata ?? {}),
        anthropicCache: { annotateStableSegments: true },
      },
    };
  },
  normalizeUsage(raw) {
    const usage = raw as any;
    return {
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheWriteTokens: usage?.cache_creation_input_tokens,
      providerRaw: raw,
    };
  },
};

