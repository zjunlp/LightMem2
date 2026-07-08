import { Readable } from "node:stream";
import type {
  HostGatewayForwarder,
  HostGatewayHttpResponse,
  HostGatewayStreamResponse,
  HostGatewayUpstreamConfig,
} from "@tokenpilot/host-adapter";
import {
  buildGatewayForwardHeaders,
  readJsonFile,
  resolveGatewayRequestUrl,
  writeJsonFileAtomic,
} from "@tokenpilot/host-adapter";
import { join } from "node:path";
import type { TokenPilotClaudeCodeConfig } from "./config.js";

type OptionalAnthropicField = "prompt_cache_key";

type UpstreamAnthropicCapabilityRecord = {
  endpoint: string;
  unsupportedOptionalFields: OptionalAnthropicField[];
  updatedAt: string;
};

export function resolveClaudeCodeUpstream(
  config: TokenPilotClaudeCodeConfig,
): HostGatewayUpstreamConfig {
  return {
    baseUrl: config.proxyBaseUrl?.replace(/\/+$/, "") || config.upstreamBaseUrl,
    apiKey: config.proxyApiKey || config.upstreamApiKey,
    name: "Anthropic",
    protocol: "anthropic-messages",
  };
}

function clonePayloadWithoutOptionalField(payload: unknown, field: OptionalAnthropicField): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!(field in payload)) return payload;
  const next = { ...(payload as Record<string, unknown>) };
  delete next[field];
  return next;
}

function clonePayloadWithoutUnsupportedFields(
  payload: unknown,
  unsupportedFields: Iterable<OptionalAnthropicField>,
): unknown {
  let next = payload;
  for (const field of unsupportedFields) {
    next = clonePayloadWithoutOptionalField(next, field);
  }
  return next;
}

function unsupportedOptionalFieldFromText(text: string): OptionalAnthropicField | undefined {
  if (!text) return undefined;
  if (/unsupported parameter:\s*prompt_cache_key/i.test(text)) {
    return "prompt_cache_key";
  }
  return undefined;
}

function capabilityPath(stateDir: string, upstream: HostGatewayUpstreamConfig): string {
  return join(
    stateDir,
    "upstream-capabilities",
    "anthropic-messages",
    `${encodeURIComponent(resolveGatewayRequestUrl(upstream, "/v1/messages"))}.json`,
  );
}

async function loadUnsupportedOptionalFields(
  stateDir: string,
  upstream: HostGatewayUpstreamConfig,
): Promise<Set<OptionalAnthropicField>> {
  const record = await readJsonFile<UpstreamAnthropicCapabilityRecord>(capabilityPath(stateDir, upstream));
  const fields = Array.isArray(record?.unsupportedOptionalFields)
    ? record.unsupportedOptionalFields.filter(
      (value): value is OptionalAnthropicField => value === "prompt_cache_key",
    )
    : [];
  return new Set(fields);
}

async function persistUnsupportedOptionalField(
  stateDir: string,
  upstream: HostGatewayUpstreamConfig,
  field: OptionalAnthropicField,
): Promise<void> {
  const unsupportedFields = await loadUnsupportedOptionalFields(stateDir, upstream);
  unsupportedFields.add(field);
  await writeJsonFileAtomic(capabilityPath(stateDir, upstream), {
    endpoint: resolveGatewayRequestUrl(upstream, "/v1/messages"),
    unsupportedOptionalFields: Array.from(unsupportedFields),
    updatedAt: new Date().toISOString(),
  } satisfies UpstreamAnthropicCapabilityRecord);
}

async function readResponseText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function headersFrom(resp: Response): Record<string, string> {
  return Object.fromEntries(resp.headers.entries());
}

export function createClaudeCodeGatewayForwarder(config: TokenPilotClaudeCodeConfig): HostGatewayForwarder {
  const send = async (params: {
    upstream: HostGatewayUpstreamConfig;
    payload: unknown;
    inboundAuthorization?: string;
    inboundHeaders?: Record<string, string | string[] | undefined>;
  }): Promise<Response> => {
    return fetch(resolveGatewayRequestUrl(params.upstream, "/v1/messages"), {
      method: "POST",
      headers: buildGatewayForwardHeaders({
        upstream: params.upstream,
        inboundAuthorization: params.inboundAuthorization,
        inboundHeaders: params.inboundHeaders,
        includeJsonContentType: true,
      }),
      body: JSON.stringify(params.payload),
    });
  };

  const request = async (params: {
    upstream: HostGatewayUpstreamConfig;
    payload: unknown;
    inboundAuthorization?: string;
    inboundHeaders?: Record<string, string | string[] | undefined>;
  }): Promise<HostGatewayHttpResponse> => {
    const unsupportedFields = await loadUnsupportedOptionalFields(config.stateDir, params.upstream);
    let payload = clonePayloadWithoutUnsupportedFields(params.payload, unsupportedFields);
    let resp = await send({ ...params, payload });
    let text = await readResponseText(resp);
    if (!resp.ok) {
      const unsupportedField = unsupportedOptionalFieldFromText(text);
      if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
        await persistUnsupportedOptionalField(config.stateDir, params.upstream, unsupportedField);
        const downgraded = clonePayloadWithoutOptionalField(payload, unsupportedField);
        if (downgraded !== payload) {
          payload = downgraded;
          resp = await send({ ...params, payload });
          text = await readResponseText(resp);
        }
      }
    }
    return {
      status: resp.status,
      headers: headersFrom(resp),
      text,
    };
  };

  const requestStream = async (params: {
    upstream: HostGatewayUpstreamConfig;
    payload: unknown;
    inboundAuthorization?: string;
    inboundHeaders?: Record<string, string | string[] | undefined>;
  }): Promise<HostGatewayStreamResponse> => {
    const unsupportedFields = await loadUnsupportedOptionalFields(config.stateDir, params.upstream);
    let payload = clonePayloadWithoutUnsupportedFields(params.payload, unsupportedFields);
    let resp = await send({ ...params, payload });
    if (!resp.ok) {
      const text = await readResponseText(resp);
      const unsupportedField = unsupportedOptionalFieldFromText(text);
      if (unsupportedField && !unsupportedFields.has(unsupportedField)) {
        await persistUnsupportedOptionalField(config.stateDir, params.upstream, unsupportedField);
        const downgraded = clonePayloadWithoutOptionalField(payload, unsupportedField);
        if (downgraded !== payload) {
          payload = downgraded;
          resp = await send({ ...params, payload });
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
  };

  return {
    request,
    requestStream,
  };
}
