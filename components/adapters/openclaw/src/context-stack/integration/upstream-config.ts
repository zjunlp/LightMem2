/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile, writeFile } from "node:fs/promises";
import type { UpstreamConfig, UpstreamModelDef } from "./upstream-types.js";
import { resolveOpenClawConfigPath } from "./openclaw-paths.js";

type DetectUpstreamOptions = {
  preferredProviderId?: string;
  preferredBaseUrl?: string;
  preferredApiKey?: string;
};

function normalizeUpstreamModels(models: any[]): UpstreamModelDef[] {
  return models
    .filter((m: any) => typeof m?.id === "string" && m.id.trim())
    .map((m: any) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      reasoning: Boolean(m.reasoning ?? false),
      input: Array.isArray(m.input) ? m.input.filter((x: any) => x === "text" || x === "image") : ["text"],
      contextWindow: Number(m.contextWindow ?? 128000),
      maxTokens: Number(m.maxTokens ?? 8192),
    }));
}

function defaultUpstreamModels(): UpstreamModelDef[] {
  return [{
    id: "gpt-5.4",
    name: "gpt-5.4",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 8192,
  }];
}

export async function detectUpstreamConfig(
  logger: { warn: (message: string) => void },
  options?: DetectUpstreamOptions,
): Promise<UpstreamConfig | null> {
  const cfgPath = resolveOpenClawConfigPath();
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const providers = parsed?.models?.providers ?? {};
    const preferred = ["tuzi", "dica", "openai", "qwen-portal", "bailian", "gmn"];
    const preferredProviderId = String(options?.preferredProviderId ?? "").trim();
    const preferredBaseUrl = String(options?.preferredBaseUrl ?? "").trim().replace(/\/+$/, "");
    const preferredApiKey = String(options?.preferredApiKey ?? "").trim();
    const matchedProviderByBaseUrl = Object.keys(providers).find((id) => {
      const provider = providers?.[id];
      if (!provider?.baseUrl || !provider?.apiKey) return false;
      const normalizedBaseUrl = String(provider.baseUrl).trim().replace(/\/+$/, "");
      if (!normalizedBaseUrl || normalizedBaseUrl !== preferredBaseUrl) return false;
      if (!preferredApiKey) return true;
      return String(provider.apiKey).trim() === preferredApiKey;
    });
    const selectedProvider = (
      preferredProviderId
      && providers?.[preferredProviderId]?.baseUrl
      && providers?.[preferredProviderId]?.apiKey
    )
      ? preferredProviderId
      : matchedProviderByBaseUrl
        ? matchedProviderByBaseUrl
        : preferred.find((id) => providers?.[id]?.baseUrl && providers?.[id]?.apiKey)
          ?? Object.keys(providers).find((id) => id !== "tokenpilot" && providers[id]?.baseUrl && providers[id]?.apiKey)
          ?? Object.keys(providers)[0];
    if (!selectedProvider) return null;
    const provider = providers[selectedProvider];
    const models = Array.isArray(provider?.models) ? provider.models : [];
    if (!provider?.baseUrl || !provider?.apiKey) return null;
    const normalized = normalizeUpstreamModels(models);
    return {
      providerId: selectedProvider,
      baseUrl: String(provider.baseUrl).replace(/\/+$/, ""),
      apiKey: String(provider.apiKey),
      apiFamily: typeof provider.api === "string" ? String(provider.api) : "openai-responses",
      models: normalized.length > 0 ? normalized : defaultUpstreamModels(),
    };
  } catch (err) {
    logger.warn(`[plugin-runtime] detect upstream config failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function ensureExplicitProxyModelsInConfig(
  proxyBaseUrl: string,
  upstream: UpstreamConfig,
  logger: { warn: (message: string) => void; info: (message: string) => void },
): Promise<void> {
  const cfgPath = resolveOpenClawConfigPath();
  try {
    const raw = await readFile(cfgPath, "utf8");
    const doc = JSON.parse(raw) as any;
    doc.models = doc.models ?? {};
    doc.models.providers = doc.models.providers ?? {};
    doc.agents = doc.agents ?? {};
    doc.agents.defaults = doc.agents.defaults ?? {};
    doc.agents.defaults.models = doc.agents.defaults.models ?? {};

    const existingTokenPilotProvider = doc.models.providers.tokenpilot ?? {};
    const existingLightMem2Provider = doc.models.providers.lightmem2 ?? {};
    const desiredModels = upstream.models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    }));
    doc.models.providers.tokenpilot = {
      ...existingTokenPilotProvider,
      baseUrl: proxyBaseUrl,
      apiKey: "tokenpilot-local",
      api: "openai-responses",
      authHeader: false,
      models: desiredModels,
    };
    doc.models.providers.lightmem2 = {
      ...existingLightMem2Provider,
      baseUrl: proxyBaseUrl,
      apiKey: "tokenpilot-local",
      api: "openai-responses",
      authHeader: false,
      models: desiredModels,
    };

    for (const model of upstream.models) {
      for (const key of [`tokenpilot/${model.id}`, `lightmem2/${model.id}`]) {
        if (!doc.agents.defaults.models[key]) doc.agents.defaults.models[key] = {};
      }
    }

    const nextRaw = JSON.stringify(doc, null, 2);
    if (nextRaw !== raw) {
      await writeFile(cfgPath, nextRaw, "utf8");
      logger.info(`[plugin-runtime] synced explicit model keys into openclaw.json (${upstream.models.length} models).`);
    }
  } catch (err) {
    logger.warn(`[plugin-runtime] sync explicit proxy models failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function normalizeProxyModelId(model: string): string {
  const value = model.trim();
  if (!value) return value;
  const stripped = value.startsWith("tokenpilot/")
    ? value.slice("tokenpilot/".length)
    : value.startsWith("lightmem2/")
      ? value.slice("lightmem2/".length)
      : value;
  return stripped.replace("gpt-5-4-mini", "gpt-5.4-mini");
}
