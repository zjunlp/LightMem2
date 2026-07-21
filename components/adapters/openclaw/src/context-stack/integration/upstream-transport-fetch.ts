/* eslint-disable @typescript-eslint/no-explicit-any */
import { readJsonFile, writeJsonFileAtomic } from "@tokenpilot/host-adapter";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { UpstreamConfig, UpstreamHttpResponse, UpstreamStreamResponse } from "./upstream-types.js";
import { chatCompletionsToResponsesText, isCompletionsApiFamily } from "./upstream-adapter.js";
import { convertChatCompletionsSseToResponsesText, createChatCompletionsToResponsesSseTransform, isSseContentType } from "./upstream-sse.js";
import { requestUpstreamWithCurl } from "./upstream-transport-curl.js";
import { hasExplicitUpstreamProxyEnv } from "./upstream-transport-proxy.js";
import { buildNonStreamingUpstreamRequestPayload, buildUpstreamRequestPayload, upstreamEndpoint } from "./upstream-transport-shared.js";
import { appendUpstreamTransportTrace } from "./upstream-transport-trace.js";

type TransportLogger = {
  warn: (message: string) => void;
  error: (message: string) => void;
};

type OptionalResponsesField = "prompt_cache_retention" | "prompt_cache_key";

type UpstreamResponsesCapabilityRecord = {
  endpoint: string;
  unsupportedOptionalFields: OptionalResponsesField[];
  updatedAt: string;
};

function clonePayloadWithoutOptionalField(payload: any, field: OptionalResponsesField): any {
  if (!payload || typeof payload !== "object") return payload;
  if (!(field in payload)) return payload;
  const next = { ...(payload as Record<string, unknown>) };
  delete next[field];
  return next;
}

function clonePayloadWithoutUnsupportedFields(
  payload: any,
  unsupportedFields: Iterable<OptionalResponsesField>,
): any {
  let next = payload;
  for (const field of unsupportedFields) {
    next = clonePayloadWithoutOptionalField(next, field);
  }
  return next;
}

function unsupportedOptionalFieldFromText(text: string): OptionalResponsesField | undefined {
  if (!text) return undefined;
  if (/unsupported parameter:\s*prompt_cache_retention/i.test(text)) {
    return "prompt_cache_retention";
  }
  if (/unsupported parameter:\s*prompt_cache_key/i.test(text)) {
    return "prompt_cache_key";
  }
  return undefined;
}

function upstreamCapabilityPath(stateDir: string, upstream: UpstreamConfig): string {
  return join(
    stateDir,
    "upstream-capabilities",
    "responses",
    `${encodeURIComponent(upstreamEndpoint(upstream))}.json`,
  );
}

async function loadUnsupportedOptionalFields(
  stateDir: string,
  upstream: UpstreamConfig,
): Promise<Set<OptionalResponsesField>> {
  const record = await readJsonFile<UpstreamResponsesCapabilityRecord>(
    upstreamCapabilityPath(stateDir, upstream),
  );
  const fields = Array.isArray(record?.unsupportedOptionalFields)
    ? record.unsupportedOptionalFields.filter(
      (value): value is OptionalResponsesField =>
        value === "prompt_cache_retention" || value === "prompt_cache_key",
    )
    : [];
  return new Set(fields);
}

async function persistUnsupportedOptionalField(
  stateDir: string,
  upstream: UpstreamConfig,
  field: OptionalResponsesField,
): Promise<void> {
  const unsupportedFields = await loadUnsupportedOptionalFields(stateDir, upstream);
  unsupportedFields.add(field);
  await writeJsonFileAtomic(upstreamCapabilityPath(stateDir, upstream), {
    endpoint: upstreamEndpoint(upstream),
    unsupportedOptionalFields: Array.from(unsupportedFields),
    updatedAt: new Date().toISOString(),
  } satisfies UpstreamResponsesCapabilityRecord);
}

export async function requestUpstreamResponses(
  upstream: UpstreamConfig,
  payload: any,
  logger: TransportLogger,
  stateDir: string,
): Promise<UpstreamHttpResponse> {
  const unsupportedFields = await loadUnsupportedOptionalFields(stateDir, upstream);
  const activePayload = clonePayloadWithoutUnsupportedFields(payload, unsupportedFields);
  if (hasExplicitUpstreamProxyEnv()) {
    await appendUpstreamTransportTrace(stateDir, {
      stage: "transport_policy",
      upstreamBaseUrl: upstream.baseUrl,
      policy: "prefer_curl_due_to_proxy_env",
    });
    return requestUpstreamWithCurl(upstream, activePayload, stateDir);
  }
  try {
    const endpoint = upstreamEndpoint(upstream);
    let requestPayload = buildNonStreamingUpstreamRequestPayload(upstream, activePayload);
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(requestPayload),
    });
    let headers = Object.fromEntries(resp.headers.entries());
    let rawText = await resp.text();
    if (!resp.ok) {
      const unsupportedField = unsupportedOptionalFieldFromText(rawText);
      if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
        await persistUnsupportedOptionalField(stateDir, upstream, unsupportedField);
        const downgradedPayload = clonePayloadWithoutOptionalField(activePayload, unsupportedField);
        if (downgradedPayload !== activePayload) {
          requestPayload = buildNonStreamingUpstreamRequestPayload(upstream, downgradedPayload);
          const retryResp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${upstream.apiKey}`,
            },
            body: JSON.stringify(requestPayload),
          });
          headers = Object.fromEntries(retryResp.headers.entries());
          rawText = await retryResp.text();
          const rawContentType = headers["content-type"];
          const text = isCompletionsApiFamily(upstream.apiFamily)
            ? isSseContentType(rawContentType)
              ? convertChatCompletionsSseToResponsesText(rawText)
              : chatCompletionsToResponsesText(rawText)
            : rawText;
          return {
            status: retryResp.status,
            headers: isCompletionsApiFamily(upstream.apiFamily) && isSseContentType(rawContentType)
              ? { ...headers, "content-type": "application/json; charset=utf-8" }
              : headers,
            text,
            transport: "fetch",
          };
        }
      }
    }
    const rawContentType = headers["content-type"];
    const text = isCompletionsApiFamily(upstream.apiFamily)
      ? isSseContentType(rawContentType)
        ? convertChatCompletionsSseToResponsesText(rawText)
        : chatCompletionsToResponsesText(rawText)
      : rawText;
    return {
      status: resp.status,
      headers: isCompletionsApiFamily(upstream.apiFamily) && isSseContentType(rawContentType)
        ? { ...headers, "content-type": "application/json; charset=utf-8" }
        : headers,
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
      return await requestUpstreamWithCurl(upstream, activePayload, stateDir);
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

export async function requestUpstreamResponsesStream(
  upstream: UpstreamConfig,
  payload: any,
  logger: TransportLogger,
  stateDir: string,
): Promise<UpstreamStreamResponse> {
  const endpoint = upstreamEndpoint(upstream);
  const unsupportedFields = await loadUnsupportedOptionalFields(stateDir, upstream);
  const activePayload = clonePayloadWithoutUnsupportedFields(payload, unsupportedFields);
  let requestPayload = buildUpstreamRequestPayload(upstream, activePayload);
  try {
    let resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${upstream.apiKey}`,
      },
      body: JSON.stringify(requestPayload),
    });
    if (!resp.ok) {
      const rawText = await resp.text();
      const unsupportedField = unsupportedOptionalFieldFromText(rawText);
      if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
        await persistUnsupportedOptionalField(stateDir, upstream, unsupportedField);
        const downgradedPayload = clonePayloadWithoutOptionalField(activePayload, unsupportedField);
        if (downgradedPayload !== activePayload) {
          requestPayload = buildUpstreamRequestPayload(upstream, downgradedPayload);
          resp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${upstream.apiKey}`,
            },
            body: JSON.stringify(requestPayload),
          });
        } else {
          return {
            status: resp.status,
            headers: { "content-type": "text/plain; charset=utf-8" },
            stream: Readable.from([rawText]),
            transport: "fetch",
          };
        }
      } else {
        return {
          status: resp.status,
          headers: { "content-type": "text/plain; charset=utf-8" },
          stream: Readable.from([rawText]),
          transport: "fetch",
        };
      }
    }
    const headers = Object.fromEntries(resp.headers.entries());
    if (!resp.body) {
      return {
        status: resp.status,
        headers,
        stream: Readable.from([""]),
        transport: "fetch",
      };
    }
    const rawStream = Readable.fromWeb(resp.body as any);
    const stream = isCompletionsApiFamily(upstream.apiFamily) && isSseContentType(headers["content-type"])
      ? rawStream.pipe(createChatCompletionsToResponsesSseTransform())
      : rawStream;
    const normalizedHeaders =
      isCompletionsApiFamily(upstream.apiFamily) && isSseContentType(headers["content-type"])
        ? { ...headers, "content-type": "text/event-stream; charset=utf-8" }
        : headers;
    return {
      status: resp.status,
      headers: normalizedHeaders,
      stream,
      transport: "fetch",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await appendUpstreamTransportTrace(stateDir, {
      stage: "fetch_stream_error",
      upstreamBaseUrl: upstream.baseUrl,
      error: detail,
    });
    logger.error(`[plugin-runtime] upstream stream fetch failed: ${detail}`);
    throw new Error(`upstream stream fetch failed (${detail})`);
  }
}
