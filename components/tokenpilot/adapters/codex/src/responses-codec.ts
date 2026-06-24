/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  HostPayloadCodec,
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionContext,
  HostSessionResolver,
} from "@tokenpilot/host-adapter";

function normalizeSessionId(value: unknown): string {
  const text = String(value ?? "").trim();
  return text || "codex-proxy-session";
}

function normalizeMessageRole(role: unknown): "system" | "user" | "assistant" | "tool" {
  const text = String(role ?? "").trim().toLowerCase();
  if (text === "developer") return "system";
  if (text === "user" || text === "assistant" || text === "tool" || text === "system") {
    return text;
  }
  return "user";
}

function metadataOf(payload: any): Record<string, unknown> {
  return payload?.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
    ? payload.metadata
    : {};
}

export function createCodexSessionResolver(): HostSessionResolver {
  return {
    resolve(_headers, rawPayload): HostSessionContext {
      const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as any : {};
      const metadata = metadataOf(payload);
      const sessionId = normalizeSessionId(
        metadata.tokenpilotSessionId
          ?? metadata.sessionId
          ?? metadata.threadId
          ?? payload.previous_response_id
          ?? payload.prompt_cache_key,
      );
      return {
        host: {
          hostId: "codex",
          displayName: "Codex",
        },
        sessionId,
        threadId: typeof metadata.threadId === "string" ? metadata.threadId : undefined,
        turnId: typeof metadata.turnId === "string" ? metadata.turnId : undefined,
        sessionMode: "single",
        metadata: {
          source: "tokenpilot-codex-proxy",
        },
      };
    },
  };
}

export function extractResponsesInputText(input: any): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  const parts: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.content === "string") {
      parts.push(item.content);
      continue;
    }
    if (typeof item.output === "string") {
      parts.push(item.output);
      continue;
    }
    if (typeof item.arguments === "string") {
      parts.push(item.arguments);
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!block || typeof block !== "object") continue;
      if (typeof block.text === "string") parts.push(block.text);
      else if (typeof block.content === "string") parts.push(block.content);
    }
  }
  return parts.filter(Boolean).join("\n");
}

export function createCodexResponsesPayloadCodec(
  sessionResolver = createCodexSessionResolver(),
): HostPayloadCodec {
  return {
    decodeRequest(rawPayload): HostRequestEnvelope {
      const payload = rawPayload && typeof rawPayload === "object" ? rawPayload as any : {};
      const messages = Array.isArray(payload.input)
        ? payload.input.map((item: any) => {
            if (!item || typeof item !== "object") return item;
            const originalRole = typeof item.role === "string" ? item.role : undefined;
            const normalizedRole = normalizeMessageRole(originalRole);
            return {
              ...item,
              role: normalizedRole,
              metadata: {
                ...(item.metadata && typeof item.metadata === "object" ? item.metadata : {}),
                __codexOriginalRole: originalRole,
              },
            };
          })
        : [];
      return {
        session: sessionResolver.resolve(undefined, payload),
        model: typeof payload.model === "string" ? payload.model : "",
        stream: payload.stream === true,
        instructions: typeof payload.instructions === "string" ? payload.instructions : undefined,
        messages,
        tools: Array.isArray(payload.tools) ? payload.tools : undefined,
        rawPayload: payload,
        metadata: {
          previousResponseId: typeof payload.previous_response_id === "string" ? payload.previous_response_id : undefined,
          promptCacheKey: typeof payload.prompt_cache_key === "string" ? payload.prompt_cache_key : undefined,
          promptCacheRetention: typeof payload.prompt_cache_retention === "string" ? payload.prompt_cache_retention : undefined,
          inputText: extractResponsesInputText(payload.input),
        },
      };
    },
    encodeRequest(envelope): unknown {
      const payload = envelope.rawPayload && typeof envelope.rawPayload === "object"
        ? { ...(envelope.rawPayload as Record<string, unknown>) }
        : {};
      payload.model = envelope.model;
      payload.stream = envelope.stream;
      if (typeof envelope.instructions === "string") payload.instructions = envelope.instructions;
      else delete payload.instructions;
      payload.input = Array.isArray(envelope.messages)
        ? envelope.messages.map((item: any) => {
            if (!item || typeof item !== "object") return item;
            const metadata = item.metadata && typeof item.metadata === "object"
              ? item.metadata as Record<string, unknown>
              : undefined;
            const originalRole = typeof metadata?.__codexOriginalRole === "string"
              ? metadata.__codexOriginalRole
              : undefined;
            const nextMetadata = metadata ? { ...metadata } : undefined;
            if (nextMetadata && "__codexOriginalRole" in nextMetadata) {
              delete nextMetadata.__codexOriginalRole;
            }
            const nextItem: Record<string, unknown> = {
              ...item,
              role: originalRole ?? item.role,
            };
            if (nextMetadata && Object.keys(nextMetadata).length > 0) {
              nextItem.metadata = nextMetadata;
            } else {
              delete nextItem.metadata;
            }
            return nextItem;
          })
        : envelope.messages;
      if (Array.isArray(envelope.tools)) payload.tools = envelope.tools;
      else delete payload.tools;
      if (typeof envelope.metadata?.previousResponseId === "string") payload.previous_response_id = envelope.metadata.previousResponseId;
      else delete payload.previous_response_id;
      if (typeof envelope.metadata?.promptCacheKey === "string") payload.prompt_cache_key = envelope.metadata.promptCacheKey;
      else delete payload.prompt_cache_key;
      if (typeof envelope.metadata?.promptCacheRetention === "string") payload.prompt_cache_retention = envelope.metadata.promptCacheRetention;
      else delete payload.prompt_cache_retention;
      return payload;
    },
    decodeResponse(rawResponse): HostResponseEnvelope {
      const response = rawResponse && typeof rawResponse === "object" ? rawResponse as any : {};
      const output = Array.isArray(response.output) ? response.output : [];
      const assistantText = output
        .map((item: any) => {
          if (!item || typeof item !== "object") return "";
          if (typeof item.text === "string") return item.text;
          if (typeof item.content === "string") return item.content;
          if (!Array.isArray(item.content)) return "";
          return item.content
            .map((entry: any) => entry && typeof entry === "object" && typeof entry.text === "string" ? entry.text : "")
            .filter(Boolean)
            .join("\n");
        })
        .filter(Boolean)
        .join("\n");
      const toolCalls = output
        .filter((item: any) => item && typeof item === "object" && String(item.type ?? "").toLowerCase() === "function_call")
        .map((item: any) => ({
          toolCallId: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : "",
          toolName: typeof item.name === "string" ? item.name : "",
          argumentsText: typeof item.arguments === "string" ? item.arguments : undefined,
          metadata: {
            id: typeof item.id === "string" ? item.id : undefined,
            status: typeof item.status === "string" ? item.status : undefined,
          },
        }))
        .filter((item: any) => item.toolCallId || item.toolName);
      return {
        assistantText,
        toolCalls,
        rawResponse,
        usage: response?.usage && typeof response.usage === "object" ? response.usage : undefined,
        metadata: {
          responseId: typeof response.id === "string" ? response.id : undefined,
          previousResponseId: typeof response.previous_response_id === "string" ? response.previous_response_id : undefined,
          promptCacheKey: typeof response.prompt_cache_key === "string" ? response.prompt_cache_key : undefined,
        },
      };
    },
    encodeResponse(envelope): unknown {
      return envelope.rawResponse;
    },
  };
}

export function syncPayloadFromEnvelope(
  rawPayload: any,
  envelope: HostRequestEnvelope,
  codec: HostPayloadCodec,
): any {
  const encoded = codec.encodeRequest(envelope) as any;
  if (!rawPayload || typeof rawPayload !== "object" || !encoded || typeof encoded !== "object") {
    return encoded;
  }
  for (const key of Object.keys(rawPayload)) {
    if (!(key in encoded)) delete rawPayload[key];
  }
  Object.assign(rawPayload, encoded);
  return rawPayload;
}
