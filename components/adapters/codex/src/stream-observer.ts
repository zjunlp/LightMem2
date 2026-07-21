/* eslint-disable @typescript-eslint/no-explicit-any */

export type CodexStreamSnapshot = {
  assistantText: string;
  usage?: Record<string, unknown>;
  responseId?: string;
  previousResponseId?: string;
  responsePromptCacheKey?: string;
  rawStreamText: string;
};

function safeJsonParse(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractTextParts(value: unknown, sink: string[]): void {
  if (!value) return;
  if (typeof value === "string") {
    sink.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractTextParts(item, sink);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === "string") sink.push(obj.text);
  if (typeof obj.content === "string") sink.push(obj.content);
  if (typeof obj.output_text === "string") sink.push(obj.output_text);
  if (typeof obj.delta === "string") sink.push(obj.delta);
  extractTextParts(obj.delta, sink);
  extractTextParts(obj.content, sink);
  extractTextParts(obj.output, sink);
  extractTextParts(obj.response, sink);
}

export function snapshotCodexResponsesStream(rawStreamText: string): CodexStreamSnapshot {
  const assistantParts: string[] = [];
  let usage: Record<string, unknown> | undefined;
  let responseId: string | undefined;
  let previousResponseId: string | undefined;
  let responsePromptCacheKey: string | undefined;

  for (const chunk of rawStreamText.split("\n\n")) {
    const dataLines = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (const data of dataLines) {
      if (data === "[DONE]") continue;
      const payload = safeJsonParse(data);
      if (!payload || typeof payload !== "object") continue;
      if (typeof payload.response?.id === "string") responseId = payload.response.id;
      if (typeof payload.id === "string" && !responseId) responseId = payload.id;
      if (typeof payload.response?.previous_response_id === "string") {
        previousResponseId = payload.response.previous_response_id;
      }
      if (typeof payload.previous_response_id === "string" && !previousResponseId) {
        previousResponseId = payload.previous_response_id;
      }
      if (typeof payload.response?.prompt_cache_key === "string") {
        responsePromptCacheKey = payload.response.prompt_cache_key;
      }
      if (typeof payload.prompt_cache_key === "string" && !responsePromptCacheKey) {
        responsePromptCacheKey = payload.prompt_cache_key;
      }
      if (payload.usage && typeof payload.usage === "object") {
        usage = payload.usage as Record<string, unknown>;
      }
      if (payload.response?.usage && typeof payload.response.usage === "object" && !usage) {
        usage = payload.response.usage as Record<string, unknown>;
      }
      extractTextParts(payload.delta, assistantParts);
      extractTextParts(payload.output, assistantParts);
      extractTextParts(payload.response?.output, assistantParts);
      if (typeof payload.output_text === "string") assistantParts.push(payload.output_text);
    }
  }

  return {
    assistantText: assistantParts.join(""),
    usage,
    responseId,
    previousResponseId,
    responsePromptCacheKey,
    rawStreamText,
  };
}
