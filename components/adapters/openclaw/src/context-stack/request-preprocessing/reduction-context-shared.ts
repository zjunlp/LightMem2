/* eslint-disable @typescript-eslint/no-explicit-any */

export type BuildLayeredReductionContextDeps = {
  memoryFaultRecoverToolName: string;
  hasRecoveryMarker: (details: unknown) => boolean;
  inferObservationPayloadKind: (
    text: string,
    fallback?: unknown,
  ) => "stdout" | "stderr" | "json" | "blob" | undefined;
};

export function isLikelyToolLikeInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const role = String(item.role ?? "").toLowerCase();
  const type = String(item.type ?? "").toLowerCase();
  if (role === "tool" || role === "observation" || role === "toolresult") return true;
  if (
    type === "function_call"
    || type === "function_call_output"
    || type === "tool_result"
    || type === "tool_call_output"
  ) return true;
  if (typeof item.name === "string" && item.name.trim().length > 0) return true;
  if (typeof item.tool_name === "string" && item.tool_name.trim().length > 0) return true;
  if (typeof item.toolName === "string" && item.toolName.trim().length > 0) return true;
  if (typeof item.tool_call_id === "string" && item.tool_call_id.trim().length > 0) return true;
  if (typeof item.toolCallId === "string" && item.toolCallId.trim().length > 0) return true;
  return false;
}

export function isContextSafePersistedInputItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  const details = item.details;
  if (details && typeof details === "object") {
    const contextSafe = (details as Record<string, unknown>).contextSafe;
    if (contextSafe && typeof contextSafe === "object") {
      const mode = String((contextSafe as Record<string, unknown>).resultMode ?? "").toLowerCase();
      if (mode === "artifact" || mode === "inline-fallback") return true;
      if ((contextSafe as Record<string, unknown>).excludedFromContext === true) return true;
    }
  }
  const markers = ["[persisted tool result]"];
  if (typeof item.content === "string" && markers.some((marker) => item.content.includes(marker))) return true;
  if (Array.isArray(item.content)) {
    for (const block of item.content) {
      if (!block || typeof block !== "object") continue;
      const text =
        typeof (block as Record<string, unknown>).text === "string"
          ? String((block as Record<string, unknown>).text)
          : typeof (block as Record<string, unknown>).content === "string"
            ? String((block as Record<string, unknown>).content)
            : "";
      if (markers.some((marker) => text.includes(marker))) return true;
    }
  }
  return false;
}

export function detectToolPayloadKind(
  text: string,
  deps: BuildLayeredReductionContextDeps,
): "stdout" | "stderr" | "json" | "blob" | undefined {
  return deps.inferObservationPayloadKind(text);
}

export function extractPathLike(value: any): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value.path ?? value.file_path ?? value.filePath;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

export function extractReadWindow(
  value: any,
): { offset?: number; limit?: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const rawOffset = value.offset;
  const rawLimit = value.limit;
  const offset =
    typeof rawOffset === "number" && Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.floor(rawOffset)
      : undefined;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : undefined;
  if (offset == null && limit == null) return undefined;
  return { offset, limit };
}

export function buildReadWindowKey(
  dataPath: string,
  readWindow?: { offset?: number; limit?: number },
): string {
  const offset = readWindow?.offset;
  const limit = readWindow?.limit;
  if (offset == null && limit == null) return `${dataPath}#full`;
  return `${dataPath}#offset=${offset ?? "?"}:limit=${limit ?? "?"}`;
}

export function parseFunctionCallArgsMapFromInput(
  input: any[],
): Map<string, { toolName?: string; path?: string; readWindow?: { offset?: number; limit?: number } }> {
  const map = new Map<string, { toolName?: string; path?: string; readWindow?: { offset?: number; limit?: number } }>();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type ?? "").toLowerCase();
    const callId = String(
      item.call_id
      ?? item.tool_call_id
      ?? item.toolCallId
      ?? item.id
      ?? "",
    ).trim();
    if (!callId) continue;

    const toolName =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : typeof item.tool_name === "string" && item.tool_name.trim().length > 0
          ? item.tool_name.trim()
          : typeof item.toolName === "string" && item.toolName.trim().length > 0
            ? item.toolName.trim()
            : undefined;

    let path = extractPathLike(item) ?? extractPathLike(item?.details);
    let readWindow = extractReadWindow(item) ?? extractReadWindow(item?.details);
    if (!path) {
      try {
        const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
        path = extractPathLike(args);
        readWindow = readWindow ?? extractReadWindow(args);
      } catch {
        // Ignore malformed tool arguments.
      }
    } else if (!readWindow) {
      try {
        const args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
        readWindow = extractReadWindow(args);
      } catch {
        // Ignore malformed tool arguments.
      }
    }

    if ((type === "message" || !type) && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (!block || typeof block !== "object") continue;
        const blockType = String(block.type ?? "").toLowerCase();
        if (blockType !== "toolcall" && blockType !== "tool_call") continue;
        const nestedCallId = String(block.id ?? block.call_id ?? "").trim();
        if (!nestedCallId) continue;
        const nestedToolName =
          typeof block.name === "string" && block.name.trim().length > 0 ? block.name.trim() : undefined;
        let nestedPath = extractPathLike(block);
        let nestedReadWindow = extractReadWindow(block);
        if (!nestedPath || !nestedReadWindow) {
          try {
            const args = typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments;
            nestedPath = nestedPath ?? extractPathLike(args);
            nestedReadWindow = nestedReadWindow ?? extractReadWindow(args);
          } catch {
            // Ignore malformed tool arguments.
          }
        }
        map.set(nestedCallId, { toolName: nestedToolName, path: nestedPath, readWindow: nestedReadWindow });
      }
    }

    map.set(callId, { toolName, path, readWindow });
  }
  return map;
}
