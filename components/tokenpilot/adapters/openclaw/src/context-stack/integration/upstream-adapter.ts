/* eslint-disable @typescript-eslint/no-explicit-any */

export function isCompletionsApiFamily(apiFamily: string | undefined): boolean {
  return String(apiFamily ?? "openai-responses").toLowerCase().includes("completions");
}

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

function normalizeCacheWriteTokens(usage: any): number {
  const direct = Number(
    usage?.cache_write_tokens
      ?? usage?.cache_creation_input_tokens
      ?? usage?.cacheWriteTokens
      ?? usage?.cacheWrite
      ?? 0,
  );
  return Number.isFinite(direct) && direct >= 0 ? direct : 0;
}

function normalizeInputTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = String(b.type ?? "").toLowerCase();
    if ((t === "input_text" || t === "text" || t === "output_text") && typeof b.text === "string") {
      parts.push(b.text);
    } else if (typeof b.content === "string") {
      parts.push(b.content);
    }
  }
  return parts.join("\n");
}

function normalizeChatCompletionsRole(role: unknown): string {
  const normalized = String(role ?? "user").toLowerCase();
  if (normalized === "developer") return "system";
  if (normalized === "system" || normalized === "assistant" || normalized === "tool") return normalized;
  return "user";
}

function normalizeToolOutputContent(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function responsesInputItemToChatCompletionsMessages(item: any): any[] {
  if (!item || typeof item !== "object") return [];

  const type = String(item.type ?? "").toLowerCase();
  if (type === "function_call") {
    const callId = String(item.call_id ?? item.id ?? "").trim();
    const name = String(item.name ?? "").trim();
    if (!name) return [];
    return [{
      role: "assistant",
      content: "",
      tool_calls: [{
        id: callId || undefined,
        type: "function",
        function: {
          name,
          arguments: String(item.arguments ?? ""),
        },
      }],
    }];
  }

  if (type === "function_call_output") {
    const toolCallId = String(item.call_id ?? item.tool_call_id ?? "").trim();
    if (!toolCallId) return [];
    return [{
      role: "tool",
      tool_call_id: toolCallId,
      content: normalizeToolOutputContent(item.output),
    }];
  }

  return [{
    role: normalizeChatCompletionsRole(item.role),
    content: normalizeInputTextContent(item.content),
  }];
}

function responsesToolToChatCompletionsTool(tool: any): any | null {
  if (!tool || typeof tool !== "object") return null;
  const type = String(tool.type ?? "").toLowerCase();
  if (type !== "function") return null;
  const fn = tool.function && typeof tool.function === "object" ? tool.function : null;
  const name = String(fn?.name ?? tool.name ?? "").trim();
  if (!name) return null;
  return {
    type: "function",
    function: {
      name,
      description:
        typeof fn?.description === "string"
          ? fn.description
          : typeof tool.description === "string"
            ? tool.description
            : undefined,
      parameters:
        fn?.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : tool.parameters && typeof tool.parameters === "object"
            ? tool.parameters
            : undefined,
      strict:
        fn?.strict === true
          ? true
          : tool.strict === true
            ? true
            : undefined,
    },
  };
}

function responsesToolChoiceToChatCompletionsToolChoice(toolChoice: any): any {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  const type = String(toolChoice.type ?? "").toLowerCase();
  if (type !== "function") return undefined;
  const fn = toolChoice.function && typeof toolChoice.function === "object" ? toolChoice.function : null;
  const name = String(fn?.name ?? toolChoice.name ?? "").trim();
  if (!name) return undefined;
  return {
    type: "function",
    function: { name },
  };
}

export function responsesPayloadToChatCompletions(payload: any): any {
  const stream = payload?.stream === true;
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const messages = input.flatMap((item: any) => responsesInputItemToChatCompletionsMessages(item));
  const model = typeof payload?.model === "string" ? payload.model : undefined;
  const tools = Array.isArray(payload?.tools)
    ? payload.tools.map((tool: any) => responsesToolToChatCompletionsTool(tool)).filter(Boolean)
    : undefined;
  const toolChoice = responsesToolChoiceToChatCompletionsToolChoice(payload?.tool_choice);
  return {
    model,
    messages,
    temperature: typeof payload?.temperature === "number" ? payload.temperature : 0,
    max_tokens: typeof payload?.max_output_tokens === "number" ? payload.max_output_tokens : undefined,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: toolChoice,
    parallel_tool_calls: payload?.parallel_tool_calls === false ? false : undefined,
  };
}

export function chatCompletionsToResponsesText(raw: string): string {
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
  const message = choice?.message ?? {};
  const text = typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((x: any) => typeof x?.text === "string" ? x.text : typeof x === "string" ? x : "").filter(Boolean).join("\n")
      : "";
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const promptTokensDetails = cloneUsageDetails(parsed?.usage?.prompt_tokens_details);
  const inputTokensDetails = cloneUsageDetails(parsed?.usage?.input_tokens_details) ?? promptTokensDetails;
  const completionTokensDetails = cloneUsageDetails(parsed?.usage?.completion_tokens_details);
  const outputTokensDetails = cloneUsageDetails(parsed?.usage?.output_tokens_details) ?? completionTokensDetails;
  const cachedInputTokens = readCachedTokens(inputTokensDetails, promptTokensDetails);
  const inputTokens = Number(parsed?.usage?.input_tokens ?? parsed?.usage?.prompt_tokens ?? 0);
  const outputTokens = Number(parsed?.usage?.output_tokens ?? parsed?.usage?.completion_tokens ?? 0);
  const totalTokens = Number(parsed?.usage?.total_tokens ?? (inputTokens + outputTokens));
  const cacheWriteTokens = normalizeCacheWriteTokens(parsed?.usage);
  const response = {
    id: parsed?.id ?? `resp_${Date.now()}`,
    object: "response",
    created_at: typeof parsed?.created === "number" ? parsed.created : Math.floor(Date.now() / 1000),
    status: toolCalls.length > 0 ? "incomplete" : "completed",
    model: parsed?.model ?? "",
    output: [
      ...(
        text
          ? [{
              id: "msg_0",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text }],
            }]
          : []
      ),
      ...toolCalls
        .filter((call: any) => String(call?.type ?? "").toLowerCase() === "function")
        .map((call: any, index: number) => ({
          type: "function_call",
          id: String(call?.id ?? `fc_${index}`),
          call_id: String(call?.id ?? `call_${index}`),
          name: String(call?.function?.name ?? ""),
          arguments: String(call?.function?.arguments ?? ""),
        })),
    ],
    usage: {
      input_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      cache_read_input_tokens: cachedInputTokens,
      cacheReadTokens: cachedInputTokens,
      cacheRead: cachedInputTokens,
      cached_tokens: cachedInputTokens,
      cachedTokens: cachedInputTokens,
      input_tokens_details: inputTokensDetails,
      output_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      output_tokens_details: outputTokensDetails,
      total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
      cache_write_tokens: cacheWriteTokens,
      cacheWriteTokens: cacheWriteTokens,
      cacheWrite: cacheWriteTokens,
      prompt_tokens_details: promptTokensDetails,
      completion_tokens_details: completionTokensDetails,
      providerRaw: parsed?.usage && typeof parsed.usage === "object" ? parsed.usage : undefined,
    },
    output_text: text,
  };
  return JSON.stringify(response);
}
