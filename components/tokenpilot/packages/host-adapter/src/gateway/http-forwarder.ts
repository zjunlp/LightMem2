/* eslint-disable @typescript-eslint/no-explicit-any */
import { Readable } from "node:stream";
import type {
  HostGatewayForwarder,
  HostGatewayHttpResponse,
  HostGatewayStreamResponse,
  HostGatewayUpstreamConfig,
} from "../contracts/gateway-runtime.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

function stripKnownAnthropicPathSuffix(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  for (const suffix of [
    "/v1/messages/count_tokens",
    "/v1/messages",
    "/v1/models",
    "/messages/count_tokens",
    "/messages",
    "/models",
  ]) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length);
    }
  }
  return trimmed;
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return undefined;
}

function shouldSkipForwardHeader(name: string): boolean {
  switch (name.toLowerCase()) {
    case "host":
    case "connection":
    case "content-length":
    case "content-encoding":
    case "transfer-encoding":
      return true;
    default:
      return false;
  }
}

function resolveAuthorization(
  upstream: HostGatewayUpstreamConfig,
  inboundAuthorization?: string,
): string | undefined {
  if (upstream.apiKey) return `Bearer ${upstream.apiKey}`;
  if (typeof inboundAuthorization === "string" && inboundAuthorization.trim()) {
    return inboundAuthorization;
  }
  return undefined;
}

export function resolveGatewayRequestUrl(
  upstream: HostGatewayUpstreamConfig,
  requestPath?: string,
): string {
  const trimmedBaseUrl = trimTrailingSlash(upstream.baseUrl);
  if (upstream.protocol !== "anthropic-messages") {
    return requestPath ? `${trimmedBaseUrl}/${trimLeadingSlash(requestPath)}` : trimmedBaseUrl;
  }
  const root = stripKnownAnthropicPathSuffix(trimmedBaseUrl);
  const nextPath = requestPath ?? "/v1/messages";
  return `${root}/${trimLeadingSlash(nextPath)}`;
}

export function buildGatewayForwardHeaders(params: {
  upstream: HostGatewayUpstreamConfig;
  inboundAuthorization?: string;
  inboundHeaders?: Record<string, string | string[] | undefined>;
  includeJsonContentType?: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(params.inboundHeaders ?? {})) {
    if (shouldSkipForwardHeader(key)) continue;
    const value = normalizeHeaderValue(rawValue);
    if (typeof value === "string" && value) {
      headers[key] = value;
    }
  }
  if (params.includeJsonContentType) {
    headers["content-type"] = "application/json";
  }

  if (params.upstream.protocol === "anthropic-messages" && params.upstream.apiKey) {
    headers.authorization = `Bearer ${params.upstream.apiKey}`;
    headers["x-api-key"] = params.upstream.apiKey;
    return headers;
  }

  const authorization = resolveAuthorization(params.upstream, params.inboundAuthorization);
  if (authorization && !headers.authorization) {
    headers.authorization = authorization;
  }
  return headers;
}

function headersFrom(resp: Response): Record<string, string> {
  return Object.fromEntries(resp.headers.entries());
}

export async function forwardGatewayRequest(params: {
  upstream: HostGatewayUpstreamConfig;
  method?: "GET" | "POST";
  requestPath?: string;
  payload?: unknown;
  inboundAuthorization?: string;
  inboundHeaders?: Record<string, string | string[] | undefined>;
}): Promise<Response> {
  const method = params.method ?? "POST";
  const hasPayload = params.payload !== undefined;
  const headers = buildGatewayForwardHeaders({
    upstream: params.upstream,
    inboundAuthorization: params.inboundAuthorization,
    inboundHeaders: params.inboundHeaders,
    includeJsonContentType: hasPayload,
  });
  return fetch(resolveGatewayRequestUrl(params.upstream, params.requestPath), {
    method,
    headers,
    body: hasPayload ? JSON.stringify(params.payload) : undefined,
  });
}

export async function forwardGatewayJsonRequest(params: {
  upstream: HostGatewayUpstreamConfig;
  payload: unknown;
  inboundAuthorization?: string;
  inboundHeaders?: Record<string, string | string[] | undefined>;
}): Promise<HostGatewayHttpResponse> {
  const resp = await forwardGatewayRequest(params);
  return {
    status: resp.status,
    headers: headersFrom(resp),
    text: await resp.text(),
  };
}

export async function forwardGatewayJsonStreamRequest(params: {
  upstream: HostGatewayUpstreamConfig;
  payload: unknown;
  inboundAuthorization?: string;
  inboundHeaders?: Record<string, string | string[] | undefined>;
}): Promise<HostGatewayStreamResponse> {
  const resp = await forwardGatewayRequest(params);
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
  };
}

export function createDefaultGatewayForwarder(): HostGatewayForwarder {
  return {
    request: forwardGatewayJsonRequest,
    requestStream: forwardGatewayJsonStreamRequest,
  };
}
