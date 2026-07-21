/* eslint-disable @typescript-eslint/no-explicit-any */
import type { UpstreamConfig } from "./upstream-types.js";
import { isCompletionsApiFamily, responsesPayloadToChatCompletions } from "./upstream-adapter.js";

export function upstreamEndpoint(upstream: UpstreamConfig): string {
  const family = String(upstream.apiFamily ?? "openai-responses").toLowerCase();
  if (family.includes("completions")) {
    return `${upstream.baseUrl}/chat/completions`;
  }
  return `${upstream.baseUrl}/responses`;
}

export function buildUpstreamRequestPayload(upstream: UpstreamConfig, payload: any): any {
  return isCompletionsApiFamily(upstream.apiFamily)
    ? responsesPayloadToChatCompletions(payload)
    : payload;
}

export function buildNonStreamingUpstreamRequestPayload(upstream: UpstreamConfig, payload: any): any {
  const requestPayload = buildUpstreamRequestPayload(upstream, payload);
  if (!requestPayload || typeof requestPayload !== "object") return requestPayload;
  return {
    ...requestPayload,
    stream: false,
  };
}
