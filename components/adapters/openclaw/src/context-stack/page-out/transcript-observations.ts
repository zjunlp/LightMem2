/* eslint-disable @typescript-eslint/no-explicit-any */
import type { StructuredTurnObservation, TranscriptHelpers } from "./transcript-types.js";

export function inferObservationPayloadKind(
  text: string,
  fallback?: unknown,
): StructuredTurnObservation["payloadKind"] | undefined {
  if (typeof fallback === "string") {
    const normalized = fallback.trim().toLowerCase();
    if (
      normalized === "stdout" ||
      normalized === "stderr" ||
      normalized === "json" ||
      normalized === "blob"
    ) {
      return normalized;
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (/^stderr\s*[:=-]/i.test(trimmed)) return "stderr";
  if (/^stdout\s*[:=-]/i.test(trimmed)) return "stdout";
  if (/^blob\s*[:=-]/i.test(trimmed)) return "blob";
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {
    // fall through
  }
  if (/^data:[^;]+;base64,/i.test(trimmed)) return "blob";
  if (/^[A-Za-z0-9+/=\s]{512,}$/.test(trimmed.replace(/\n/g, ""))) return "blob";
  return undefined;
}

function buildToolCallArgsMap(messages: any[]): Map<string, { toolName?: string; path?: string }> {
  const map = new Map<string, { toolName?: string; path?: string }>();
  for (const msg of messages) {
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "assistant") continue;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "toolCall" && item.type !== "tool_call") continue;
      const callId =
        typeof item.id === "string" && item.id.trim().length > 0 ? item.id.trim() : undefined;
      if (!callId) continue;
      const toolName =
        typeof item.name === "string" && item.name.trim().length > 0
          ? item.name.trim()
          : undefined;
      const args =
        item.arguments && typeof item.arguments === "object"
          ? (item.arguments as Record<string, unknown>)
          : undefined;
      const path =
        typeof args?.path === "string" && args.path.trim().length > 0
          ? args.path.trim()
          : typeof args?.file_path === "string" && args.file_path.trim().length > 0
            ? args.file_path.trim()
            : typeof args?.filePath === "string" && args.filePath.trim().length > 0
              ? args.filePath.trim()
              : undefined;
      map.set(callId, { toolName, path });
    }
  }
  return map;
}

export function isWriteLikeToolName(toolName: string | undefined): boolean {
  const normalized = String(toolName ?? "").trim().toLowerCase();
  return normalized === "write" || normalized.endsWith(".write") || normalized.includes("write_file");
}

function extractTurnObservationsFromMessages(
  messages: any[],
  helpers: TranscriptHelpers,
): StructuredTurnObservation[] {
  const toolCallArgsMap = buildToolCallArgsMap(messages);
  const out: StructuredTurnObservation[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const role = String(msg?.role ?? "").toLowerCase();
    if (role !== "tool" && role !== "observation" && role !== "toolresult") continue;
    const text = helpers.contentToText(msg?.content ?? msg?.text ?? "").trim();
    if (!text) continue;
    const payloadKind = inferObservationPayloadKind(
      text,
      msg?.payloadKind ?? msg?.kind ?? msg?.type,
    );
    const toolName =
      typeof msg?.name === "string" && msg.name.trim().length > 0
        ? msg.name.trim()
        : typeof msg?.toolName === "string" && msg.toolName.trim().length > 0
          ? msg.toolName.trim()
          : typeof msg?.tool_name === "string" && msg.tool_name.trim().length > 0
            ? msg.tool_name.trim()
            : undefined;
    const callId =
      typeof msg?.tool_call_id === "string" && msg.tool_call_id.trim().length > 0
        ? msg.tool_call_id.trim()
        : typeof msg?.toolCallId === "string" && msg.toolCallId.trim().length > 0
          ? msg.toolCallId.trim()
          : undefined;
    const toolCallArgs = callId ? toolCallArgsMap.get(callId) : undefined;
    const resolvedPath = toolCallArgs?.path;
    const recovery = helpers.contextSafeRecovery(msg?.details);
    const metadata: Record<string, unknown> | undefined = resolvedPath
      ? { path: resolvedPath, file_path: resolvedPath }
      : undefined;
    out.push({
      id: callId ?? `msg-${i + 1}`,
      role: role === "tool" || role === "toolresult" ? "tool" : "observation",
      text,
      payloadKind,
      toolName: toolName ?? toolCallArgs?.toolName,
      source: "event.messages",
      messageIndex: i,
      mimeType:
        typeof msg?.mime_type === "string" && msg.mime_type.trim().length > 0
          ? msg.mime_type.trim()
          : typeof msg?.mimeType === "string" && msg.mimeType.trim().length > 0
            ? msg.mimeType.trim()
            : undefined,
      textChars: text.length,
      textPreview: text.length > 240 ? `${text.slice(0, 240)}...` : text,
      ...(metadata ? { metadata } : {}),
      ...(recovery
        ? {
            recovery: {
              source:
                typeof recovery.source === "string" && recovery.source.trim().length > 0
                  ? recovery.source.trim()
                  : helpers.memoryFaultRecoverToolName,
              skipReduction: recovery.skipReduction === true,
            },
          }
        : {}),
    });
  }
  return out;
}

export function extractTurnObservations(
  event: any,
  helpers: TranscriptHelpers,
): StructuredTurnObservation[] {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  return extractTurnObservationsFromMessages(messages, helpers);
}
