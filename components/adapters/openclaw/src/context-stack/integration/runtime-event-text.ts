/* eslint-disable @typescript-eslint/no-explicit-any */
import { basename } from "node:path";
import { extractScopedSessionKey } from "../../session/scoped-session-key.js";

export function extractSessionKey(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const direct =
    event?.sessionKey ??
    event?.SessionKey ??
    event?.result?.sessionKey ??
    event?.result?.SessionKey ??
    event?.meta?.sessionKey ??
    event?.meta?.SessionKey ??
    event?.ctx?.SessionKey ??
    event?.ctx?.CommandTargetSessionKey ??
    event?.session?.key ??
    event?.sessionId ??
    event?.result?.sessionId ??
    agentMeta?.sessionKey ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();

  const scoped = extractScopedSessionKey(event);
  if (scoped) return scoped;

  return "unknown";
}

export function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToText(item))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.type === "thinking" || obj.type === "reasoning") {
      return "";
    }
    if (obj.type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    const preferred = obj.text ?? obj.content ?? obj.value ?? obj.message;
    if (preferred !== undefined) {
      const nested = contentToText(preferred);
      if (nested.trim().length > 0) return nested;
    }
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(value);
}

export function extractLastUserMessage(event: any): string {
  const promptText = typeof event?.prompt === "string" ? event.prompt.trim() : "";
  if (promptText) return promptText;
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m?.role === "user");
  return contentToText(lastUser?.content ?? event?.message?.content ?? event?.message ?? "");
}

export function extractOpenClawSessionId(event: any): string {
  const agentMeta = event?.result?.meta?.agentMeta ?? event?.meta?.agentMeta ?? event?.agentMeta;
  const sessionFile =
    event?.sessionFile ??
    event?.result?.sessionFile ??
    event?.meta?.sessionFile ??
    agentMeta?.sessionFile ??
    "";
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    const fileBase = basename(sessionFile.trim()).replace(/\.jsonl$/i, "").trim();
    if (fileBase.length > 0) return fileBase;
  }
  const direct =
    event?.sessionId ??
    event?.SessionId ??
    event?.ctx?.SessionId ??
    event?.result?.sessionId ??
    event?.result?.SessionId ??
    event?.meta?.sessionId ??
    event?.meta?.SessionId ??
    event?.session?.id ??
    agentMeta?.sessionId ??
    "";
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return "";
}

export function extractResponseTextFromProviderNode(value: unknown, contentToTextFn: (value: unknown) => string): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return contentToTextFn(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => extractResponseTextFromProviderNode(item, contentToTextFn))
      .filter((s) => s.trim().length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = String(obj.type ?? "").toLowerCase();
    const role = String(obj.role ?? "").toLowerCase();
    if (type === "output_text" && typeof obj.text === "string") {
      return obj.text;
    }
    if (typeof obj.delta === "string" && obj.delta.trim().length > 0) {
      return obj.delta;
    }
    if (type === "message" || role === "assistant") {
      return extractResponseTextFromProviderNode(obj.content ?? obj.output ?? obj.text, contentToTextFn);
    }
    return extractResponseTextFromProviderNode(
      obj.response ?? obj.output ?? obj.item ?? obj.content ?? obj.text ?? obj.message,
      contentToTextFn,
    );
  }
  return "";
}

export function extractProviderResponseText(rawText: string, parsed: unknown, contentToTextFn: (value: unknown) => string): string {
  const parsedRecord = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const parsedType = String(parsedRecord?.type ?? "").toLowerCase();
  const fromParsed = parsedType === "response.created" ? "" : extractResponseTextFromProviderNode(parsed, contentToTextFn);
  if (fromParsed.trim().length > 0) return fromParsed.trim();

  let deltaText = "";
  const lines = String(rawText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const record = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
      const type = String(record.type ?? "").toLowerCase();
      if (type === "response.created") continue;
      const fromRecord = extractResponseTextFromProviderNode(
        record.response ?? record.output ?? record.item ?? record,
        contentToTextFn,
      );
      if (fromRecord.trim().length > 0) return fromRecord.trim();
      if (typeof record.delta === "string") {
        deltaText += record.delta;
      }
    } catch {
      // ignore malformed stream fragments
    }
  }
  return deltaText.trim();
}

export function extractItemText(item: any, extractInputTextFn: (input: any) => string): string {
  if (!item || typeof item !== "object") return "";
  return extractInputTextFn([item]).trim();
}

export function findLastUserItem(input: any): { userIndex: number; userItem: any | null } | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (String((item as any).role) === "user") {
      return { userIndex: i, userItem: item };
    }
  }
  return null;
}
