/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ensureResponsesSseStarted,
  ensureToolCallState,
  extractChatCompletionDeltaText,
  finalizeChatCompletionsResponsesSse,
} from "./upstream-sse-events.js";
import { formatSseEvent, type ChatCompletionsSseState } from "./upstream-sse-shared.js";

export function processChatCompletionsSseBlock(block: string, state: ChatCompletionsSseState): string {
  const lines = block.split(/\r?\n/u);
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return "";
  const payloadText = dataLines.map((line) => line.slice(5).trim()).join("\n").trim();
  if (!payloadText) return "";
  if (payloadText === "[DONE]") {
    return finalizeChatCompletionsResponsesSse(state);
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return "";
  }

  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const deltaText = extractChatCompletionDeltaText(choice);
  state.responseId = String(parsed?.id ?? (state.responseId || `resp_${Date.now()}`));
  state.model = String(parsed?.model ?? state.model ?? "");
  if (parsed?.usage != null) {
    state.usage = parsed.usage;
  } else if (parsed?.response?.usage != null) {
    state.usage = parsed.response.usage;
  }

  const out: string[] = [];
  ensureResponsesSseStarted(state, out);
  const toolCallDeltas = Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : [];
  if (deltaText) {
    state.accumulatedText += deltaText;
    out.push(formatSseEvent({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: deltaText,
      item_id: "msg_0",
    }));
  }
  for (const tcDelta of toolCallDeltas) {
    const index = Number.isInteger(tcDelta?.index) ? tcDelta.index : 0;
    const toolState = ensureToolCallState(state, index + 1, tcDelta);
    if (!toolState.added) {
      out.push(formatSseEvent({
        type: "response.output_item.added",
        output_index: index + 1,
        item: {
          type: "function_call",
          id: toolState.id,
          call_id: toolState.callId,
          name: toolState.name,
          arguments: "",
          status: "in_progress",
        },
      }));
      toolState.added = true;
    }
    if (typeof tcDelta?.function?.arguments === "string" && tcDelta.function.arguments.length > 0) {
      out.push(formatSseEvent({
        type: "response.function_call_arguments.delta",
        item_id: toolState.id,
        output_index: index + 1,
        delta: tcDelta.function.arguments,
      }));
    }
  }

  return out.join("");
}
