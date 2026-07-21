/* eslint-disable @typescript-eslint/no-explicit-any */
import { readJsonFile, writeJsonFileAtomic } from "@lightmem2/host-adapter";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { CodexProviderConfig } from "./config.js";

export type UpstreamHttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
};

export type UpstreamStreamResponse = {
  status: number;
  headers: Record<string, string>;
  stream: Readable;
};

type OptionalResponsesField = "prompt_cache_retention" | "prompt_cache_key";

type UpstreamResponsesCapabilityRecord = {
  endpoint: string;
  unsupportedOptionalFields: OptionalResponsesField[];
  updatedAt: string;
};

function endpointFor(upstream: CodexProviderConfig): string {
  const base = upstream.baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/v1")) return `${base}/responses`;
  if (base.endsWith("/v1/responses")) return base;
  return `${base}/v1/responses`;
}

function upstreamApiKey(upstream: CodexProviderConfig, inboundAuthorization?: string): string {
  if (upstream.apiKey) return upstream.apiKey;
  if (inboundAuthorization?.toLowerCase().startsWith("bearer ")) {
    return inboundAuthorization.slice("bearer ".length).trim();
  }
  return process.env.OPENAI_API_KEY ?? "";
}

function headersFrom(resp: Response): Record<string, string> {
  return Object.fromEntries(resp.headers.entries());
}

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

function upstreamCapabilityPath(stateDir: string, upstream: CodexProviderConfig): string {
  return join(
    stateDir,
    "upstream-capabilities",
    "responses",
    `${encodeURIComponent(endpointFor(upstream))}.json`,
  );
}

async function loadUnsupportedOptionalFields(
  stateDir: string | undefined,
  upstream: CodexProviderConfig,
): Promise<Set<OptionalResponsesField>> {
  if (!stateDir) return new Set();
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
  stateDir: string | undefined,
  upstream: CodexProviderConfig,
  field: OptionalResponsesField,
): Promise<void> {
  if (!stateDir) return;
  const unsupportedFields = await loadUnsupportedOptionalFields(stateDir, upstream);
  unsupportedFields.add(field);
  await writeJsonFileAtomic(upstreamCapabilityPath(stateDir, upstream), {
    endpoint: endpointFor(upstream),
    unsupportedOptionalFields: Array.from(unsupportedFields),
    updatedAt: new Date().toISOString(),
  } satisfies UpstreamResponsesCapabilityRecord);
}

export async function requestUpstreamResponses(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
  stateDir?: string;
}): Promise<UpstreamHttpResponse> {
  const send = (payload: any) => fetch(endpointFor(params.upstream), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${upstreamApiKey(params.upstream, params.inboundAuthorization)}`,
    },
    body: JSON.stringify(payload),
  });
  const unsupportedFields = await loadUnsupportedOptionalFields(params.stateDir, params.upstream);
  let payload = clonePayloadWithoutUnsupportedFields(params.payload, unsupportedFields);
  let resp = await send(payload);
  let text = await resp.text();
  if (!resp.ok) {
    const unsupportedField = unsupportedOptionalFieldFromText(text);
    if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
      await persistUnsupportedOptionalField(params.stateDir, params.upstream, unsupportedField);
      const downgraded = clonePayloadWithoutOptionalField(payload, unsupportedField);
      if (downgraded !== payload) {
        payload = downgraded;
        resp = await send(payload);
        text = await resp.text();
      }
    }
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    text,
  };
}

export async function requestUpstreamResponsesStream(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
  stateDir?: string;
}): Promise<UpstreamStreamResponse> {
  const send = (payload: any) => fetch(endpointFor(params.upstream), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${upstreamApiKey(params.upstream, params.inboundAuthorization)}`,
    },
    body: JSON.stringify(payload),
  });
  const unsupportedFields = await loadUnsupportedOptionalFields(params.stateDir, params.upstream);
  let payload = clonePayloadWithoutUnsupportedFields(params.payload, unsupportedFields);
  let resp = await send(payload);
  if (!resp.ok) {
    const text = await resp.text();
    const unsupportedField = unsupportedOptionalFieldFromText(text);
    if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
      await persistUnsupportedOptionalField(params.stateDir, params.upstream, unsupportedField);
      const downgraded = clonePayloadWithoutOptionalField(payload, unsupportedField);
      if (downgraded !== payload) {
        payload = downgraded;
        resp = await send(payload);
      } else {
        return {
          status: resp.status,
          headers: headersFrom(resp),
          stream: Readable.from([text]),
        };
      }
    } else {
      return {
        status: resp.status,
        headers: headersFrom(resp),
        stream: Readable.from([text]),
      };
    }
  }
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
  };
}
