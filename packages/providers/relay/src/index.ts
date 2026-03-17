import type { ProviderAdapter } from "@ecoclaw/kernel";

export const relayAdapter: ProviderAdapter = {
  provider: "relay",
  async annotatePrompt(ctx) {
    return {
      ...ctx,
      metadata: {
        ...(ctx.metadata ?? {}),
        relay: {
          routeStabilityKey: `${ctx.provider}:${ctx.model}:${ctx.sessionId}`,
        },
      },
    };
  },
  normalizeUsage(raw) {
    return {
      providerRaw: raw,
    };
  },
};

