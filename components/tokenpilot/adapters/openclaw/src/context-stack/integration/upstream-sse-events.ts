/* eslint-disable @typescript-eslint/no-explicit-any */
import { formatSseEvent, type ChatCompletionsSseState } from "./upstream-sse-shared.js";

function cloneUsageDetails(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return { ...(value as Record<string, unknown>) };
}

function readCachedTokens(...details: Array<Record<string, unknown> | undefined>): number | undefined {
  for (const detail of details) {
    const value = Number(detail?.cached_tokens);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

export function extractChatCompletionDeltaText(choice: any): string {
  const content = choice?.delta?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item: any) => {
      if (typeof item?.text === "string") return item.text;
      if (typeof item === "string") return item;
      return "";
    })
    .filter(Boolean)
    .join("");
}

export function buildResponsesCompletedPayload(state: ChatCompletionsSseState): any {
  const promptTokensDetails = cloneUsageDetails(state.usage?.prompt_tokens_details);
  const inputTokensDetails = cloneUsageDetails(state.usage?.input_tokens_details) ?? promptTokensDetails;
  const completionTokensDetails = cloneUsageDetails(state.usage?.completion_tokens_details);
  const outputTokensDetails = cloneUsageDetails(state.usage?.output_tokens_details) ?? completionTokensDetails;
  const cachedInputTokens = readCachedTokens(inputTokensDetails, promptTokensDetails);
  const usage = state.usage != null
    ? {
      input_tokens: Number(state.usage?.input_tokens ?? state.usage?.prompt_tokens ?? 0),
      cache_read_input_tokens: cachedInputTokens,
      cached_tokens: cachedInputTokens,
      input_tokens_details: inputTokensDetails,
      output_tokens: Number(state.usage?.output_tokens ?? state.usage?.completion_tokens ?? 0),
      output_tokens_details: outputTokensDetails,
      total_tokens: Number(
        state.usage?.total_tokens
          ?? (
            Number(state.usage?.input_tokens ?? state.usage?.prompt_tokens ?? 0)
            + Number(state.usage?.output_tokens ?? state.usage?.completion_tokens ?? 0)
          ),
      ),
      prompt_tokens_details: promptTokensDetails,
      completion_tokens_details: completionTokensDetails,
    }
    : {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };
  return {
    id: state.responseId || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: state.toolCallsByIndex.size > 0 ? "incomplete" : "completed",
    model: state.model,
    output: [
      ...(
        state.textItemAdded || state.textItemDone
          ? [{
            id: "msg_0",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: state.accumulatedText }],
          }]
          : []
      ),
      ...[...state.toolCallsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tool]) => ({
          type: "function_call",
          id: tool.id,
          call_id: tool.callId,
          name: tool.name,
          arguments: tool.arguments,
          status: "completed",
        })),
    ],
    usage,
    output_text: state.accumulatedText,
  };
}

export function ensureResponsesSseStarted(state: ChatCompletionsSseState, out: string[]): void {
  if (state.started) return;
  state.started = true;
  const response = {
    id: state.responseId || `resp_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    model: state.model,
    output: [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
  out.push(formatSseEvent({
    type: "response.created",
    response,
  }));
  out.push(formatSseEvent({
    type: "response.in_progress",
    response,
  }));
  out.push(formatSseEvent({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "msg_0",
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: [{ type: "output_text", text: "" }],
    },
  }));
  out.push(formatSseEvent({
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    item_id: "msg_0",
    part: { type: "output_text", text: "" },
  }));
  state.textItemAdded = true;
}

export function finalizeChatCompletionsResponsesSse(state: ChatCompletionsSseState): string {
  if (state.completed) return "";
  state.completed = true;
  const out: string[] = [];
  if (!state.started && (state.accumulatedText || state.toolCallsByIndex.size > 0)) {
    ensureResponsesSseStarted(state, out);
  }
  if (state.textItemAdded && !state.textItemDone) {
    out.push(formatSseEvent({
      type: "response.output_text.done",
      item_id: "msg_0",
      output_index: 0,
      content_index: 0,
      text: state.accumulatedText,
    }));
    out.push(formatSseEvent({
      type: "response.content_part.done",
      item_id: "msg_0",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: state.accumulatedText },
    }));
    out.push(formatSseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_0",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: state.accumulatedText }],
      },
    }));
    state.textItemDone = true;
  }
  for (const [index, tool] of [...state.toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (tool.done) continue;
    out.push(formatSseEvent({
      type: "response.output_item.done",
      output_index: index,
      item: {
        type: "function_call",
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
        status: "completed",
      },
    }));
    tool.done = true;
  }
  out.push(formatSseEvent({
    type: "response.completed",
    response: buildResponsesCompletedPayload(state),
  }));
  out.push("data: [DONE]\n\n");
  return out.join("");
}

export function ensureToolCallState(
  state: ChatCompletionsSseState,
  index: number,
  delta: any,
): {
  id: string;
  callId: string;
  name: string;
  arguments: string;
  added: boolean;
  done: boolean;
} {
  const existing = state.toolCallsByIndex.get(index);
  if (existing) {
    if (typeof delta?.id === "string" && delta.id.length > 0) {
      existing.id = delta.id;
      if (!existing.callId) existing.callId = delta.id;
    }
    if (typeof delta?.function?.name === "string" && delta.function.name.length > 0) {
      existing.name = delta.function.name;
    }
    if (typeof delta?.function?.arguments === "string" && delta.function.arguments.length > 0) {
      existing.arguments += delta.function.arguments;
    }
    return existing;
  }
  const created = {
    id: String(delta?.id ?? `fc_${index}`),
    callId: String(delta?.id ?? `call_${index}`),
    name: String(delta?.function?.name ?? ""),
    arguments: typeof delta?.function?.arguments === "string" ? delta.function.arguments : "",
    added: false,
    done: false,
  };
  state.toolCallsByIndex.set(index, created);
  return created;
}
