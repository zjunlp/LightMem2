/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  HostPayloadCodec,
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionContext,
  HostSessionResolver,
  HostStreamCodec,
  HostStreamSnapshot,
} from "@tokenpilot/host-adapter";

type OpenClawHostAdapterDeps = {
  resolveSessionIdForPayload?: ((payload: any) => string | undefined) | undefined;
  extractInputText: (input: any) => string;
};

function normalizeSessionId(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "proxy-session";
}

export function createOpenClawSessionResolver(
  deps: OpenClawHostAdapterDeps,
): HostSessionResolver {
  return {
    resolve(_headers, rawPayload): HostSessionContext {
      const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as any : {};
      const metadata = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
      const sessionId = normalizeSessionId(deps.resolveSessionIdForPayload?.(payload));
      const threadId = typeof metadata.threadId === "string" ? metadata.threadId : undefined;
      const turnId = typeof metadata.turnId === "string" ? metadata.turnId : undefined;
      return {
        host: {
          hostId: "openclaw",
          displayName: "OpenClaw",
        },
        sessionId,
        threadId,
        turnId,
        sessionMode: "single",
        metadata: {
          source: "embedded-responses-proxy",
        },
      };
    },
  };
}

export function createOpenClawPayloadCodec(
  deps: OpenClawHostAdapterDeps,
  sessionResolver: HostSessionResolver,
): HostPayloadCodec {
  return {
    decodeRequest(rawPayload): HostRequestEnvelope {
      const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as any : {};
      return {
        session: sessionResolver.resolve(undefined, payload),
        model: typeof payload.model === "string" ? payload.model : "",
        stream: payload.stream === true,
        instructions: typeof payload.instructions === "string" ? payload.instructions : undefined,
        messages: Array.isArray(payload.input) ? payload.input : [],
        tools: Array.isArray(payload.tools) ? payload.tools : undefined,
        rawPayload: payload,
        metadata: {
          previousResponseId:
            typeof payload.previous_response_id === "string"
              ? payload.previous_response_id
              : undefined,
          promptCacheKey:
            typeof payload.prompt_cache_key === "string"
              ? payload.prompt_cache_key
              : undefined,
          promptCacheRetention:
            typeof payload.prompt_cache_retention === "string"
              ? payload.prompt_cache_retention
              : undefined,
          inputText: deps.extractInputText(payload.input),
        },
      };
    },
    encodeRequest(envelope): unknown {
      const payload = envelope.rawPayload && typeof envelope.rawPayload === "object"
        ? { ...(envelope.rawPayload as Record<string, unknown>) }
        : {};
      payload.model = envelope.model;
      payload.stream = envelope.stream;
      if (typeof envelope.instructions === "string") {
        payload.instructions = envelope.instructions;
      } else {
        delete payload.instructions;
      }
      payload.input = envelope.messages;
      if (Array.isArray(envelope.tools)) {
        payload.tools = envelope.tools;
      } else {
        delete payload.tools;
      }
      if (typeof envelope.metadata?.previousResponseId === "string") {
        payload.previous_response_id = envelope.metadata.previousResponseId;
      } else {
        delete payload.previous_response_id;
      }
      if (typeof envelope.metadata?.promptCacheKey === "string") {
        payload.prompt_cache_key = envelope.metadata.promptCacheKey;
      } else {
        delete payload.prompt_cache_key;
      }
      if (typeof envelope.metadata?.promptCacheRetention === "string") {
        payload.prompt_cache_retention = envelope.metadata.promptCacheRetention;
      } else {
        delete payload.prompt_cache_retention;
      }
      return payload;
    },
    decodeResponse(rawResponse): HostResponseEnvelope {
      const response = rawResponse && typeof rawResponse === "object" ? rawResponse as any : {};
      const output = Array.isArray(response.output) ? response.output : [];
      const toolCalls = output
        .filter((item: any) => item && typeof item === "object" && String(item.type ?? "").toLowerCase() === "function_call")
        .map((item: any) => ({
          toolCallId:
            typeof item.call_id === "string"
              ? item.call_id
              : typeof item.id === "string"
                ? item.id
                : "",
          toolName: typeof item.name === "string" ? item.name : "",
          argumentsText: typeof item.arguments === "string" ? item.arguments : undefined,
          metadata: {
            id: typeof item.id === "string" ? item.id : undefined,
            status: typeof item.status === "string" ? item.status : undefined,
          },
        }))
        .filter((item: any) => item.toolCallId || item.toolName);
      const assistantText = output
        .map((item: any) => {
          if (!item || typeof item !== "object") return "";
          if (typeof item.text === "string") return item.text;
          if (typeof item.content === "string") return item.content;
          if (Array.isArray(item.content)) {
            return item.content
              .map((entry: any) => (entry && typeof entry.text === "string" ? entry.text : ""))
              .filter(Boolean)
              .join("\n");
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return {
        assistantText,
        toolCalls,
        rawResponse,
        usage: response?.usage && typeof response.usage === "object" ? response.usage : undefined,
        metadata: {
          responseId: typeof response.id === "string" ? response.id : undefined,
          previousResponseId:
            typeof response.previous_response_id === "string"
              ? response.previous_response_id
              : undefined,
          promptCacheKey:
            typeof response.prompt_cache_key === "string"
              ? response.prompt_cache_key
              : undefined,
          promptCacheRetention:
            typeof response.prompt_cache_retention === "string"
              ? response.prompt_cache_retention
              : undefined,
        },
      };
    },
    encodeResponse(envelope): unknown {
      return envelope.rawResponse;
    },
  };
}

export function syncOpenClawPayloadFromEnvelope(
  rawPayload: any,
  envelope: HostRequestEnvelope,
  codec: HostPayloadCodec,
): any {
  const encoded = codec.encodeRequest(envelope) as any;
  if (!rawPayload || typeof rawPayload !== "object" || !encoded || typeof encoded !== "object") {
    return encoded;
  }
  for (const key of Object.keys(rawPayload)) {
    if (!(key in encoded)) {
      delete rawPayload[key];
    }
  }
  Object.assign(rawPayload, encoded);
  return rawPayload;
}

export function createOpenClawStreamCodec(deps: {
  extractProviderResponseText: (rawStreamText: string, parsed: any, contentToText: (value: unknown) => string) => string;
  contentToText: (value: unknown) => string;
}): HostStreamCodec {
  return {
    collectAssistantText(rawStreamText: string): string {
      return deps.extractProviderResponseText(rawStreamText, null, deps.contentToText);
    },
    extractUsage(rawStreamText: string): Record<string, unknown> | undefined {
      let usage: Record<string, unknown> | undefined;
      for (const line of String(rawStreamText ?? "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payloadText = trimmed.slice(5).trim();
        if (!payloadText || payloadText === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payloadText) as Record<string, unknown>;
          const candidate = parsed?.usage;
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
            usage = candidate as Record<string, unknown>;
            continue;
          }
          const nestedCandidate =
            parsed?.response && typeof parsed.response === "object"
              ? (parsed.response as Record<string, unknown>)?.usage
              : undefined;
          if (nestedCandidate && typeof nestedCandidate === "object" && !Array.isArray(nestedCandidate)) {
            usage = nestedCandidate as Record<string, unknown>;
          }
        } catch {
          // ignore malformed stream frames
        }
      }
      return usage;
    },
  };
}

export function createOpenClawStreamSnapshot(
  rawStreamText: string,
  codec: HostStreamCodec,
): HostStreamSnapshot {
  let promptCacheKey: string | undefined;
  for (const line of String(rawStreamText ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payloadText = trimmed.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payloadText) as Record<string, unknown>;
      if (typeof parsed?.prompt_cache_key === "string") {
        promptCacheKey = parsed.prompt_cache_key;
      } else if (
        parsed?.response
        && typeof parsed.response === "object"
        && typeof (parsed.response as Record<string, unknown>).prompt_cache_key === "string"
      ) {
        promptCacheKey = String((parsed.response as Record<string, unknown>).prompt_cache_key);
      }
    } catch {
      // ignore malformed stream frames
    }
  }
  return {
    rawStreamText,
    assistantText: codec.collectAssistantText(rawStreamText),
    usage: codec.extractUsage?.(rawStreamText),
    promptCacheKey,
  };
}
