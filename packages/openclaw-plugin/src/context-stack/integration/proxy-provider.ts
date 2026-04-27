/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UpstreamConfig } from "../../proxy/upstream.js";

export function maybeRegisterProxyProvider(
  api: any,
  cfg: { proxyApiKey?: string },
  logger: { warn: (message: string) => void; info: (message: string) => void; error: (message: string) => void },
  baseUrl: string,
  upstream: UpstreamConfig,
) {
  if (typeof api.registerProvider !== "function") {
    logger.warn("[plugin-runtime] registerProvider not supported by this OpenClaw version.");
    return;
  }

  try {
    const modelIds = upstream.models.map((m) => m.id);
    const modelDefs = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: "openai-responses",
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    api.registerProvider({
      id: "ecoclaw",
      name: "TokenPilot Router",
      label: "TokenPilot Router",
      api: "openai-responses",
      baseUrl,
      apiKey: cfg.proxyApiKey ?? "ecoclaw-local",
      authHeader: false,
      models: modelIds.length > 0 ? modelDefs : ["gpt-5.4"],
    });
    logger.info(
      `[plugin-runtime] Registered provider ecoclaw/* via embedded proxy. mirrored=${modelIds.slice(0, 6).join(",")}${modelIds.length > 6 ? "..." : ""}`,
    );
  } catch (err: unknown) {
    logger.error(`[plugin-runtime] Failed to register provider: ${err instanceof Error ? err.message : String(err)}`);
  }
}
