/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import type {
  HostMessage,
  HostPayloadCodec,
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionContext,
  HostSessionResolver,
} from "@tokenpilot/host-adapter";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeSessionId(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizeRole(role: unknown): "system" | "user" | "assistant" | "tool" {
  const text = String(role ?? "").trim().toLowerCase();
  if (text === "user" || text === "assistant" || text === "tool" || text === "system") {
    return text;
  }
  return "user";
}

function extractTextFromBlock(block: unknown): string {
  const obj = asRecord(block);
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.input === "string") return obj.input;
  if (typeof obj.output === "string") return obj.output;
  return "";
}

function ensureSyntheticSessionId(payload: Record<string, unknown>): string {
  const metadata = asRecord(payload.metadata);
  const existing = normalizeSessionId(metadata.tokenpilotSyntheticSessionId);
  if (existing) return existing;
  const next = `claude-synth-${randomUUID()}`;
  payload.metadata = {
    ...metadata,
    tokenpilotSyntheticSessionId: next,
  };
  return next;
}

function anthropicMessageToHostMessage(message: unknown): HostMessage {
  const item = asRecord(message);
  const content = item.content;
  const hostContent = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .map((block) => {
          const entry = asRecord(block);
          const type = String(entry.type ?? "").trim().toLowerCase();
          if (type === "image") {
            return {
              type: "image" as const,
              imageUrl: typeof entry.source === "string" ? entry.source : undefined,
              mediaType: typeof entry.media_type === "string" ? entry.media_type : undefined,
            };
          }
          if (type === "tool_use") {
            return {
              type: "tool_call" as const,
              toolCallId: typeof entry.id === "string" ? entry.id : "",
              toolName: typeof entry.name === "string" ? entry.name : "",
              argumentsJson: asRecord(entry.input),
            };
          }
          if (type === "tool_result") {
            return {
              type: "tool_result" as const,
              toolCallId: typeof entry.tool_use_id === "string" ? entry.tool_use_id : undefined,
              toolName: typeof entry.name === "string" ? entry.name : undefined,
              status: (entry.is_error === true ? "error" : "success") as "error" | "success",
              text: extractTextFromBlock(block),
            };
          }
          return {
            type: "text" as const,
            text: extractTextFromBlock(block),
          };
        })
        .filter((block) => block.type !== "text" || block.text)
      : "";

  return {
    role: normalizeRole(item.role),
    content: hostContent,
    metadata: {
      __anthropicRawMessage: item,
    },
  };
}

function hostMessageToAnthropicMessage(message: HostMessage): Record<string, unknown> {
  const metadata = asRecord(message.metadata);
  const raw = asRecord(metadata.__anthropicRawMessage);
  const content = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content.map((block) => {
        if (block.type === "text") return { type: "text", text: block.text };
        if (block.type === "tool_call") {
          return {
            type: "tool_use",
            id: block.toolCallId,
            name: block.toolName,
            input: block.argumentsJson ?? {},
          };
        }
        if (block.type === "tool_result") {
          return {
            type: "tool_result",
            tool_use_id: block.toolCallId,
            name: block.toolName,
            is_error: block.status === "error",
            content: block.text,
          };
        }
        if (block.type === "image") {
          return {
            type: "image",
            source: block.imageUrl,
            media_type: block.mediaType,
          };
        }
        return { type: "text", text: "" };
      });

  return {
    ...raw,
    role: message.role,
    content,
  };
}

export function createClaudeCodeSessionResolver(): HostSessionResolver {
  return {
    resolve(headers, rawPayload): HostSessionContext {
      const payload = asRecord(rawPayload);
      const metadata = asRecord(payload.metadata);
      const sessionId = normalizeSessionId(
        headers?.["x-session-id"]
          ?? metadata.sessionId
          ?? metadata.threadId
          ?? payload.id,
      ) ?? ensureSyntheticSessionId(payload);
      return {
        host: {
          hostId: "claude-code",
          displayName: "Claude Code",
        },
        sessionId,
        threadId: typeof metadata.threadId === "string" ? metadata.threadId : undefined,
        sessionMode: "single",
        metadata: {
          source: "tokenpilot-claude-code-gateway",
        },
      };
    },
  };
}

export function extractMessagesInputText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    const item = asRecord(message);
    const content = item.content;
    if (typeof content === "string") {
      parts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = extractTextFromBlock(block);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

export function createClaudeMessagesPayloadCodec(
  sessionResolver = createClaudeCodeSessionResolver(),
): HostPayloadCodec {
  return {
    decodeRequest(rawPayload, ctx): HostRequestEnvelope {
      const payload = asRecord(rawPayload);
      const messages = Array.isArray(payload.messages)
        ? payload.messages.map((message) => anthropicMessageToHostMessage(message))
        : [];
      return {
        session: sessionResolver.resolve(ctx?.headers, payload),
        model: typeof payload.model === "string" ? payload.model : "",
        stream: payload.stream === true,
        instructions: typeof payload.system === "string" ? payload.system : undefined,
        messages,
        tools: Array.isArray(payload.tools) ? payload.tools : undefined,
        rawPayload: payload,
        metadata: {
          maxTokens: payload.max_tokens,
          inputText: extractMessagesInputText(payload.messages),
        },
      };
    },
    encodeRequest(envelope): unknown {
      const payload = asRecord(envelope.rawPayload);
      const nextPayload: Record<string, unknown> = {
        ...payload,
        model: envelope.model,
        stream: envelope.stream,
        messages: envelope.messages.map((message) => hostMessageToAnthropicMessage(message)),
      };
      if (Array.isArray(envelope.tools)) nextPayload.tools = envelope.tools;
      else delete nextPayload.tools;
      if (typeof envelope.instructions === "string") nextPayload.system = envelope.instructions;
      else delete nextPayload.system;
      if (typeof envelope.metadata?.promptCacheKey === "string") {
        nextPayload.prompt_cache_key = envelope.metadata.promptCacheKey;
      } else {
        delete nextPayload.prompt_cache_key;
      }
      return nextPayload;
    },
    decodeResponse(rawResponse): HostResponseEnvelope {
      const response = asRecord(rawResponse);
      const content = Array.isArray(response.content) ? response.content : [];
      const assistantText = content
        .map((block) => extractTextFromBlock(block))
        .filter(Boolean)
        .join("\n");
      const toolCalls = content
        .map((block) => {
          const item = asRecord(block);
          if (item.type !== "tool_use") return undefined;
          return {
            toolCallId: typeof item.id === "string" ? item.id : "",
            toolName: typeof item.name === "string" ? item.name : "",
            argumentsJson: asRecord(item.input),
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      return {
        assistantText,
        toolCalls,
        rawResponse,
        usage: asRecord(response.usage),
        metadata: {
          responseId: typeof response.id === "string" ? response.id : undefined,
          stopReason: typeof response.stop_reason === "string" ? response.stop_reason : undefined,
          promptCacheKey:
            typeof response.prompt_cache_key === "string"
              ? response.prompt_cache_key
              : undefined,
        },
      };
    },
    encodeResponse(envelope): unknown {
      return envelope.rawResponse;
    },
  };
}
