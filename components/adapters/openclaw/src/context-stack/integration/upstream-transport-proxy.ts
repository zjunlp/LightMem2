function resolveProxyEnvValue(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveUpstreamProxySettings(): {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
} {
  const httpProxy = resolveProxyEnvValue(
    "LIGHTMEM2_UPSTREAM_HTTP_PROXY",
    "TOKENPILOT_UPSTREAM_HTTP_PROXY",
    "tokenpilot_upstream_http_proxy",
    "http_proxy",
    "HTTP_PROXY",
  );
  const httpsProxy = resolveProxyEnvValue(
    "LIGHTMEM2_UPSTREAM_HTTPS_PROXY",
    "TOKENPILOT_UPSTREAM_HTTPS_PROXY",
    "tokenpilot_upstream_https_proxy",
    "https_proxy",
    "HTTPS_PROXY",
  ) ?? httpProxy;
  const allProxy = resolveProxyEnvValue(
    "LIGHTMEM2_UPSTREAM_ALL_PROXY",
    "TOKENPILOT_UPSTREAM_ALL_PROXY",
    "tokenpilot_upstream_all_proxy",
    "all_proxy",
    "ALL_PROXY",
  );
  const noProxy = resolveProxyEnvValue(
    "LIGHTMEM2_UPSTREAM_NO_PROXY",
    "TOKENPILOT_UPSTREAM_NO_PROXY",
    "tokenpilot_upstream_no_proxy",
    "no_proxy",
    "NO_PROXY",
  ) ?? "127.0.0.1,localhost";
  return { httpProxy, httpsProxy, allProxy, noProxy };
}

export function hasExplicitUpstreamProxyEnv(): boolean {
  const settings = resolveUpstreamProxySettings();
  return Boolean(settings.httpProxy || settings.httpsProxy || settings.allProxy);
}

export function buildUpstreamCurlEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "SHELL"]) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  const { httpProxy, httpsProxy, allProxy, noProxy } = resolveUpstreamProxySettings();
  if (httpProxy) {
    env.http_proxy = httpProxy;
    env.HTTP_PROXY = httpProxy;
  }
  if (httpsProxy) {
    env.https_proxy = httpsProxy;
    env.HTTPS_PROXY = httpsProxy;
  }
  if (allProxy) {
    env.all_proxy = allProxy;
    env.ALL_PROXY = allProxy;
  }
  if (noProxy) {
    env.no_proxy = noProxy;
    env.NO_PROXY = noProxy;
  }
  return env;
}
