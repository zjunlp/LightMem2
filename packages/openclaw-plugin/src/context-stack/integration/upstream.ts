/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, appendFile, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { pluginStateSubdir } from "@tokenpilot/runtime-core";

export type UpstreamModelDef = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

export type UpstreamConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  apiFamily?: string;
  models: UpstreamModelDef[];
};

export type UpstreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  transport: "fetch" | "curl";
};

function runExecFile(
  file: string,
  args: string[],
  options?: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: options?.env,
        timeout: options?.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${file} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (options?.input != null) {
      child.stdin?.end(options.input);
    }
  });
}

function parseCurlHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("HTTP/")) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    headers[trimmed.slice(0, idx).trim().toLowerCase()] = trimmed.slice(idx + 1).trim();
  }
  return headers;
}

function resolveUpstreamProxySettings(): {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
} {
  const httpProxy =
    process.env.TOKENPILOT_UPSTREAM_HTTP_PROXY
    || process.env.tokenpilot_upstream_http_proxy
    || process.env.ECOCLAW_UPSTREAM_HTTP_PROXY
    || process.env.ecoclaw_upstream_http_proxy
    || process.env.http_proxy
    || process.env.HTTP_PROXY;
  const httpsProxy =
    process.env.TOKENPILOT_UPSTREAM_HTTPS_PROXY
    || process.env.tokenpilot_upstream_https_proxy
    || process.env.ECOCLAW_UPSTREAM_HTTPS_PROXY
    || process.env.ecoclaw_upstream_https_proxy
    || process.env.https_proxy
    || process.env.HTTPS_PROXY
    || httpProxy;
  const allProxy =
    process.env.TOKENPILOT_UPSTREAM_ALL_PROXY
    || process.env.tokenpilot_upstream_all_proxy
    || process.env.ECOCLAW_UPSTREAM_ALL_PROXY
    || process.env.ecoclaw_upstream_all_proxy
    || process.env.all_proxy
    || process.env.ALL_PROXY;
  const noProxy =
    process.env.TOKENPILOT_UPSTREAM_NO_PROXY
    || process.env.tokenpilot_upstream_no_proxy
    || process.env.ECOCLAW_UPSTREAM_NO_PROXY
    || process.env.ecoclaw_upstream_no_proxy
    || process.env.no_proxy
    || process.env.NO_PROXY
    || "127.0.0.1,localhost";
  return {
    httpProxy: httpProxy?.trim() || undefined,
    httpsProxy: httpsProxy?.trim() || undefined,
    allProxy: allProxy?.trim() || undefined,
    noProxy: noProxy?.trim() || undefined,
  };
}

function hasExplicitUpstreamProxyEnv(): boolean {
  const settings = resolveUpstreamProxySettings();
  return Boolean(settings.httpProxy || settings.httpsProxy || settings.allProxy);
}

function upstreamEndpoint(upstream: UpstreamConfig): string {
  const family = String(upstream.apiFamily ?? "openai-responses").toLowerCase();
  if (family.includes("completions")) {
    return `${upstream.baseUrl}/chat/completions`;
  }
  return `${upstream.baseUrl}/responses`;
}

function normalizeInputTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = String(b.type ?? "").toLowerCase();
    if ((t === "input_text" || t === "text" || t === "output_text") && typeof b.text === "string") {
      parts.push(b.text);
    } else if (typeof b.content === "string") {
      parts.push(b.content);
    }
  }
  return parts.join("\n");
}

function responsesPayloadToChatCompletions(payload: any): any {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const messages = input.map((item: any) => ({
    role: typeof item?.role === "string" ? item.role : "user",
    content: normalizeInputTextContent(item?.content),
  }));
  const model = typeof payload?.model === 'string' ? payload.model : undefined;
  return {
    model,
    messages,
    temperature: typeof payload?.temperature === 'number' ? payload.temperature : 0,
    max_tokens: typeof payload?.max_output_tokens === 'number' ? payload.max_output_tokens : undefined,
    stream: false,
  };
}

function chatCompletionsToResponsesText(raw: string): string {
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const message = choice?.message ?? {};
  const text = typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((x: any) => typeof x?.text === 'string' ? x.text : typeof x === 'string' ? x : '').filter(Boolean).join('\n')
      : '';
  const response = {
    id: parsed?.id ?? `resp_${Date.now()}`,
    object: 'response',
    model: parsed?.model ?? '',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
      },
    ],
    usage: parsed?.usage ?? null,
    output_text: text,
  };
  return JSON.stringify(response);
}

function buildUpstreamCurlEnv(): NodeJS.ProcessEnv {
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

async function appendUpstreamTransportTrace(
  stateDir: string,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    const tracePath = pluginStateSubdir(stateDir, "upstream-transport-trace.jsonl");
    await mkdir(dirname(tracePath), { recursive: true });
    await appendFile(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // best-effort trace only
  }
}

async function requestUpstreamWithCurl(
  upstream: UpstreamConfig,
  payload: any,
  stateDir: string,
  logger?: { warn: (message: string) => void },
): Promise<UpstreamHttpResponse> {
  const realTempDir = await mkdtemp(join(tmpdir(), "ecoclaw-curl-"));
  const bodyPath = join(realTempDir, "request.json");
  const headersPath = join(realTempDir, "headers.txt");
  const curlEnv = buildUpstreamCurlEnv();
  const proxySettings = resolveUpstreamProxySettings();
  try {
    await writeFile(bodyPath, JSON.stringify(String(upstream.apiFamily ?? "openai-responses").toLowerCase().includes("completions") ? responsesPayloadToChatCompletions(payload) : payload), "utf8");
    await appendUpstreamTransportTrace(stateDir, {
      stage: "curl_start",
      upstreamBaseUrl: upstream.baseUrl,
      httpProxy: curlEnv.http_proxy ?? curlEnv.HTTP_PROXY ?? "",
      httpsProxy: curlEnv.https_proxy ?? curlEnv.HTTPS_PROXY ?? "",
      noProxy: curlEnv.no_proxy ?? curlEnv.NO_PROXY ?? "",
    });
    const { stdout } = await runExecFile(
      "curl",
      (() => {
        const requestPayload = String(upstream.apiFamily ?? "openai-responses").toLowerCase().includes("completions")
          ? responsesPayloadToChatCompletions(payload)
          : payload;
        writeFile(bodyPath, JSON.stringify(requestPayload), "utf8");
        const args = [
          "-sS",
          "-X",
          "POST",
          upstreamEndpoint(upstream),
          "-H",
          "content-type: application/json",
          "-H",
          `authorization: Bearer ${upstream.apiKey}`,
          "--data-binary",
          `@${bodyPath}`,
          "--dump-header",
          headersPath,
          "--output",
          "-",
          "--write-out",
          "\n__UPSTREAM_CURL_STATUS__:%{http_code}",
        ];
        const targetUrl = new URL(upstreamEndpoint(upstream));
        const chosenProxy = targetUrl.protocol === "https:"
          ? (proxySettings.httpsProxy || proxySettings.allProxy || proxySettings.httpProxy)
          : (proxySettings.httpProxy || proxySettings.allProxy || proxySettings.httpsProxy);
        if (chosenProxy) args.push("--proxy", chosenProxy);
        if (proxySettings.noProxy) args.push("--noproxy", proxySettings.noProxy);
        return args;
      })(),
      { env: curlEnv, timeoutMs: 180000 },
    );
    const marker = "\n__UPSTREAM_CURL_STATUS__:";
    const idx = stdout.lastIndexOf(marker);
    if (idx < 0) throw new Error("curl missing status marker");
    const rawText = stdout.slice(0, idx);
    const text = String(upstream.apiFamily ?? "openai-responses").toLowerCase().includes("completions")
      ? chatCompletionsToResponsesText(rawText)
      : rawText;
    const status = Number.parseInt(stdout.slice(idx + marker.length).trim(), 10);
    const rawHeaders = await readFile(headersPath, "utf8");
    await appendUpstreamTransportTrace(stateDir, {
      stage: "curl_ok",
      upstreamBaseUrl: upstream.baseUrl,
      status: Number.isFinite(status) ? status : 502,
    });
    return {
      status: Number.isFinite(status) ? status : 502,
      headers: parseCurlHeaders(rawHeaders),
      text,
      transport: "curl",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendUpstreamTransportTrace(stateDir, {
      stage: "curl_error",
      upstreamBaseUrl: upstream.baseUrl,
      error: detail,
      httpProxy: curlEnv.http_proxy ?? curlEnv.HTTP_PROXY ?? "",
      httpsProxy: curlEnv.https_proxy ?? curlEnv.HTTPS_PROXY ?? "",
      noProxy: curlEnv.no_proxy ?? curlEnv.NO_PROXY ?? "",
    });
    throw err;
  } finally {
    await rm(realTempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function requestUpstreamResponses(
  upstream: UpstreamConfig,
  payload: any,
  logger: { warn: (message: string) => void; error: (message: string) => void },
  stateDir: string,
): Promise<UpstreamHttpResponse> {
  if (hasExplicitUpstreamProxyEnv()) {
    await appendUpstreamTransportTrace(stateDir, {
      stage: "transport_policy",
      upstreamBaseUrl: upstream.baseUrl,
      policy: "prefer_curl_due_to_proxy_env",
    });
    return requestUpstreamWithCurl(upstream, payload, stateDir, logger);
  }
  try {
    const endpoint = upstreamEndpoint(upstream);
    const requestPayload = String(upstream.apiFamily ?? "openai-responses").toLowerCase().includes("completions")
      ? responsesPayloadToChatCompletions(payload)
      : payload;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(requestPayload),
    });
    const rawText = await resp.text();
    const text = String(upstream.apiFamily ?? "openai-responses").toLowerCase().includes("completions")
      ? chatCompletionsToResponsesText(rawText)
      : rawText;
    return {
      status: resp.status,
      headers: Object.fromEntries(resp.headers.entries()),
      text,
      transport: "fetch",
    };
  } catch (err) {
    const fetchDetail = err instanceof Error ? err.message : String(err);
    await appendUpstreamTransportTrace(stateDir, {
      stage: "fetch_error",
      upstreamBaseUrl: upstream.baseUrl,
      error: fetchDetail,
    });
    logger.warn(`[plugin-runtime] upstream fetch failed, fallback to curl: ${fetchDetail}`);
    try {
      return await requestUpstreamWithCurl(upstream, payload, stateDir, logger);
    } catch (curlErr) {
      const curlDetail = curlErr instanceof Error ? curlErr.message : String(curlErr);
      await appendUpstreamTransportTrace(stateDir, {
        stage: "fetch_then_curl_error",
        upstreamBaseUrl: upstream.baseUrl,
        fetchError: fetchDetail,
        curlError: curlDetail,
      });
      logger.error(`[plugin-runtime] upstream curl fallback failed: ${curlDetail}`);
      throw new Error(`upstream fetch failed (${fetchDetail}); curl fallback failed (${curlDetail})`);
    }
  }
}

export async function detectUpstreamConfig(
  logger: { warn: (message: string) => void },
): Promise<UpstreamConfig | null> {
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as any;
    const providers = parsed?.models?.providers ?? {};
    const preferred = ["tuzi", "dica", "openai", "qwen-portal", "bailian", "gmn"];
    const selectedProvider = preferred.find((id) => providers?.[id]?.baseUrl && providers?.[id]?.apiKey)
      ?? Object.keys(providers).find((id) => id !== "tokenpilot" && id !== "ecoclaw" && providers[id]?.baseUrl && providers[id]?.apiKey)
      ?? Object.keys(providers)[0];
    if (!selectedProvider) return null;
    const p = providers[selectedProvider];
    const models = Array.isArray(p?.models) ? p.models : [];
    const normalized: UpstreamModelDef[] = models
      .filter((m: any) => typeof m?.id === "string" && m.id.trim())
      .map((m: any) => ({
        id: String(m.id),
        name: String(m.name ?? m.id),
        reasoning: Boolean(m.reasoning ?? false),
        input: Array.isArray(m.input) ? m.input.filter((x: any) => x === "text" || x === "image") : ["text"],
        contextWindow: Number(m.contextWindow ?? 128000),
        maxTokens: Number(m.maxTokens ?? 8192),
      }));
    if (!p?.baseUrl || !p?.apiKey) return null;
    return {
      providerId: selectedProvider,
      baseUrl: String(p.baseUrl).replace(/\/+$/, ""),
      apiKey: String(p.apiKey),
      apiFamily: typeof p.api === 'string' ? String(p.api) : 'openai-responses',
      models: normalized.length > 0 ? normalized : [{
        id: "gpt-5.4",
        name: "gpt-5.4",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 8192,
      }],
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
  const cfgPath = join(homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = await readFile(cfgPath, "utf8");
    const doc = JSON.parse(raw) as any;
    doc.models = doc.models ?? {};
    doc.models.providers = doc.models.providers ?? {};
    doc.agents = doc.agents ?? {};
    doc.agents.defaults = doc.agents.defaults ?? {};
    doc.agents.defaults.models = doc.agents.defaults.models ?? {};

    const existingProvider = doc.models.providers.tokenpilot ?? {};
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
      ...existingProvider,
      baseUrl: proxyBaseUrl,
      apiKey: "tokenpilot-local",
      api: "openai-responses",
      authHeader: false,
      models: desiredModels,
    };

    for (const model of upstream.models) {
      const key = `tokenpilot/${model.id}`;
      if (!doc.agents.defaults.models[key]) doc.agents.defaults.models[key] = {};
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
    : value.startsWith("ecoclaw/")
      ? value.slice("ecoclaw/".length)
      : value;
  return stripped.replace("gpt-5-4-mini", "gpt-5.4-mini");
}
