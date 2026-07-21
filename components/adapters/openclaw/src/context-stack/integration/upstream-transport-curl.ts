/* eslint-disable @typescript-eslint/no-explicit-any */
import { execFile } from "node:child_process";
import { readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpstreamConfig, UpstreamHttpResponse } from "./upstream-types.js";
import { chatCompletionsToResponsesText, isCompletionsApiFamily } from "./upstream-adapter.js";
import { convertChatCompletionsSseToResponsesText, isSseContentType } from "./upstream-sse.js";
import { buildUpstreamCurlEnv, resolveUpstreamProxySettings } from "./upstream-transport-proxy.js";
import { buildNonStreamingUpstreamRequestPayload, upstreamEndpoint } from "./upstream-transport-shared.js";
import { appendUpstreamTransportTrace } from "./upstream-transport-trace.js";

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

export async function requestUpstreamWithCurl(
  upstream: UpstreamConfig,
  payload: any,
  stateDir: string,
): Promise<UpstreamHttpResponse> {
  const realTempDir = await mkdtemp(join(tmpdir(), "tokenpilot-curl-"));
  const bodyPath = join(realTempDir, "request.json");
  const headersPath = join(realTempDir, "headers.txt");
  const curlEnv = buildUpstreamCurlEnv();
  const proxySettings = resolveUpstreamProxySettings();
  try {
    await writeFile(bodyPath, JSON.stringify(buildNonStreamingUpstreamRequestPayload(upstream, payload)), "utf8");
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
        const endpoint = upstreamEndpoint(upstream);
        const args = [
          "-sS",
          "-X",
          "POST",
          endpoint,
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
        const targetUrl = new URL(endpoint);
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
    const rawHeaders = await readFile(headersPath, "utf8");
    const parsedHeaders = parseCurlHeaders(rawHeaders);
    const rawContentType = parsedHeaders["content-type"];
    const text = isCompletionsApiFamily(upstream.apiFamily)
      ? isSseContentType(rawContentType)
        ? convertChatCompletionsSseToResponsesText(rawText)
        : chatCompletionsToResponsesText(rawText)
      : rawText;
    const status = Number.parseInt(stdout.slice(idx + marker.length).trim(), 10);
    await appendUpstreamTransportTrace(stateDir, {
      stage: "curl_ok",
      upstreamBaseUrl: upstream.baseUrl,
      status: Number.isFinite(status) ? status : 502,
    });
    return {
      status: Number.isFinite(status) ? status : 502,
      headers: isCompletionsApiFamily(upstream.apiFamily) && isSseContentType(rawContentType)
        ? { ...parsedHeaders, "content-type": "application/json; charset=utf-8" }
        : parsedHeaders,
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
