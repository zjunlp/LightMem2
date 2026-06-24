/* eslint-disable @typescript-eslint/no-explicit-any */
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

export async function requestUpstreamResponses(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
}): Promise<UpstreamHttpResponse> {
  const resp = await fetch(endpointFor(params.upstream), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${upstreamApiKey(params.upstream, params.inboundAuthorization)}`,
    },
    body: JSON.stringify(params.payload),
  });
  return {
    status: resp.status,
    headers: headersFrom(resp),
    text: await resp.text(),
  };
}

export async function requestUpstreamResponsesStream(params: {
  upstream: CodexProviderConfig;
  payload: any;
  inboundAuthorization?: string;
}): Promise<UpstreamStreamResponse> {
  const resp = await fetch(endpointFor(params.upstream), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${upstreamApiKey(params.upstream, params.inboundAuthorization)}`,
    },
    body: JSON.stringify(params.payload),
  });
  return {
    status: resp.status,
    headers: headersFrom(resp),
    stream: resp.body ? Readable.fromWeb(resp.body as any) : Readable.from([""]),
  };
}
