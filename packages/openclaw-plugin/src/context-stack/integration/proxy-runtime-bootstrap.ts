import type { UpstreamConfig } from "./upstream.js";

export async function resolveProxyUpstream(
  cfg: any,
  logger: any,
  helpers: any,
): Promise<UpstreamConfig | null> {
  let upstream: UpstreamConfig | null = null;
  const configuredProviderId = String((cfg as any).proxyProviderId ?? process.env.TOKENPILOT_UPSTREAM_PROVIDER ?? "").trim();
  if (cfg.proxyBaseUrl && cfg.proxyApiKey) {
    const detected = await helpers.detectUpstreamConfig(logger, {
      preferredProviderId: configuredProviderId || undefined,
      preferredBaseUrl: cfg.proxyBaseUrl,
      preferredApiKey: cfg.proxyApiKey,
    });
    upstream = {
      providerId: configuredProviderId || detected?.providerId || "configured",
      baseUrl: cfg.proxyBaseUrl.replace(/\/+$/, ""),
      apiKey: cfg.proxyApiKey,
      apiFamily: detected?.apiFamily ?? "openai-responses",
      models: detected?.models ?? [],
    };
    logger.info(
      `[plugin-runtime] proxy using configured upstream provider=${upstream.providerId} api=${upstream.apiFamily ?? "unknown"} baseUrl=${upstream.baseUrl}`,
    );
    return upstream;
  }
  return helpers.detectUpstreamConfig(logger, {
    preferredProviderId: configuredProviderId || undefined,
  });
}
