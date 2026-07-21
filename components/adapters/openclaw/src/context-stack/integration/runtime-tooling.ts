/* eslint-disable @typescript-eslint/no-explicit-any */
import { isAbsolute, resolve } from "node:path";

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeWebSearchDateFilters(target: Record<string, unknown>): Record<string, unknown> {
  const freshness = typeof target.freshness === "string" ? target.freshness.trim() : "";
  const dateAfter = typeof target.date_after === "string" ? target.date_after.trim() : "";
  const dateBefore = typeof target.date_before === "string" ? target.date_before.trim() : "";
  if (!freshness || (!dateAfter && !dateBefore)) {
    return target;
  }
  return {
    ...target,
    freshness: "",
  };
}

export function applyBeforeToolCallDefaults(event: any): Record<string, unknown> {
  const toolName = String(
    event?.toolName
    ?? event?.tool_name
    ?? event?.name
    ?? event?.params?.toolName
    ?? event?.params?.tool_name
    ?? event?.params?.name
    ?? "",
  ).trim().toLowerCase();
  const params = event?.params && typeof event.params === "object"
    ? { ...(event.params as Record<string, unknown>) }
    : {};
  const args =
    params.args && typeof params.args === "object"
      ? { ...(params.args as Record<string, unknown>) }
      : null;
  const argumentsObject =
    params.arguments && typeof params.arguments === "object"
      ? { ...(params.arguments as Record<string, unknown>) }
      : null;

  if (toolName === "read") {
    const readTarget = args ?? argumentsObject ?? params;
    if (!isPositiveNumber(readTarget.limit)) readTarget.limit = 200;
    if (!isPositiveNumber(readTarget.offset)) readTarget.offset = 1;
    if (args) params.args = readTarget;
    if (argumentsObject) params.arguments = readTarget;
    return params;
  }
  if (toolName === "web_fetch") {
    const fetchTarget = args ?? argumentsObject ?? params;
    if (!isPositiveNumber(fetchTarget.maxChars)) fetchTarget.maxChars = 12_000;
    if (args) params.args = fetchTarget;
    if (argumentsObject) params.arguments = fetchTarget;
    return params;
  }
  if (toolName === "web_search") {
    const searchTarget = args ?? argumentsObject ?? params;
    const normalized = normalizeWebSearchDateFilters(searchTarget);
    if (args) params.args = normalized;
    if (argumentsObject) params.arguments = normalized;
    if (!args && !argumentsObject) return normalized;
  }
  return params;
}

function resolvePathField(target: Record<string, unknown>, fieldName: string, workspaceDir: string): boolean {
  const current = trimText(target[fieldName]);
  if (!current || isAbsolute(current)) return false;
  target[fieldName] = resolve(workspaceDir, current);
  return true;
}

export function applyWorkspacePathHintToToolParams(
  event: any,
  workspaceDir: string | undefined,
): Record<string, unknown> | undefined {
  const normalizedWorkspaceDir = trimText(workspaceDir);
  const toolName = String(
    event?.toolName
    ?? event?.tool_name
    ?? event?.name
    ?? event?.params?.toolName
    ?? event?.params?.tool_name
    ?? event?.params?.name
    ?? "",
  ).trim().toLowerCase();
  if (!normalizedWorkspaceDir) return event?.params;
  if (!new Set(["read", "write", "edit"]).has(toolName)) return event?.params;

  const params = event?.params && typeof event.params === "object"
    ? { ...(event.params as Record<string, unknown>) }
    : {};
  const args =
    params.args && typeof params.args === "object"
      ? { ...(params.args as Record<string, unknown>) }
      : null;
  const argumentsObject =
    params.arguments && typeof params.arguments === "object"
      ? { ...(params.arguments as Record<string, unknown>) }
      : null;

  const target = args ?? argumentsObject ?? params;
  resolvePathField(target, "path", normalizedWorkspaceDir);

  if (args) params.args = target;
  if (argumentsObject) params.arguments = target;
  return params;
}

export function extractWorkspaceDirFromMessages(
  messages: any[],
  contentToTextFn: (value: unknown) => string,
): string | undefined {
  const patterns = [
    /Your working directory is:\s*([^\n\r]+)/i,
    /(?:^|\n)-\s*WORKDIR:\s*([^\n\r]+)/i,
  ];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const text = contentToTextFn(message?.content ?? message);
    if (!text.trim()) continue;
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const candidate = trimText(match?.[1]);
      if (!candidate || candidate === "<WORKDIR>") continue;
      if (candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function isToolResultLikeMessage(message: Record<string, unknown>): boolean {
  const role = String(message.role ?? "").toLowerCase();
  const type = String(message.type ?? "").toLowerCase();
  return (
    role === "toolresult" ||
    role === "tool" ||
    type === "toolresult" ||
    type === "tool_result" ||
    type === "function_call_output"
  );
}

export function extractToolMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") return b.text;
      if (typeof b.content === "string") return b.content;
      return "";
    })
    .filter((v) => v.length > 0)
    .join("\n");
}

export function ensureContextSafeDetails(
  details: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const base = details && typeof details === "object" ? { ...(details as Record<string, unknown>) } : {};
  const contextSafe =
    base.contextSafe && typeof base.contextSafe === "object"
      ? { ...(base.contextSafe as Record<string, unknown>) }
      : {};
  base.contextSafe = { ...contextSafe, ...patch };
  return base;
}

export function messageToolCallId(message: Record<string, unknown>): string | undefined {
  const direct =
    typeof message.tool_call_id === "string" && message.tool_call_id.trim().length > 0
      ? message.tool_call_id.trim()
      : typeof message.toolCallId === "string" && message.toolCallId.trim().length > 0
        ? message.toolCallId.trim()
        : undefined;
  return direct;
}

export function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function canonicalMessageTaskIds(
  message: Record<string, unknown>,
  asRecord: (value: unknown) => Record<string, unknown> | undefined,
): string[] {
  const details = asRecord(message.details);
  const contextSafe = asRecord(details?.contextSafe);
  return Array.isArray(contextSafe?.taskIds)
    ? contextSafe.taskIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}
