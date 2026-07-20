import type { RuntimeTurnContext } from "@tokenpilot/kernel";

export function buildLifecyclePolicyContext(params: {
  sessionId: string;
  model: string;
  prompt: string;
}): RuntimeTurnContext {
  return {
    sessionId: params.sessionId.trim() || "proxy-session",
    sessionMode: "single",
    provider: "openai",
    model: params.model || "unknown",
    apiFamily: "openai-responses",
    prompt: params.prompt,
    segments: [],
    budget: {
      maxInputTokens: 1_000_000,
      reserveOutputTokens: 16_384,
    },
    metadata: {
      policyContext: {
        source: "lifecycle",
        reductionContextBuilt: false,
      },
    },
  };
}
