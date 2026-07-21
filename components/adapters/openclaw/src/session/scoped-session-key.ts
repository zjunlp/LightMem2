/* eslint-disable @typescript-eslint/no-explicit-any */

function normalizeScopedPart(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function extractScopedSessionKey(event: any): string | undefined {
  const channel = normalizeScopedPart(event?.channel ?? event?.from?.channel ?? "unknown");
  const channelId = normalizeScopedPart(event?.channelId ?? event?.to?.id ?? event?.conversationId ?? "");
  const threadId = normalizeScopedPart(event?.messageThreadId ?? event?.threadId ?? "");
  const senderId = normalizeScopedPart(event?.senderId ?? event?.from?.id ?? "");
  const scoped = [channel, channelId, threadId, senderId].filter((value) => value.length > 0);
  if (scoped.length === 0) return undefined;
  return `scoped:${scoped.join(":")}`;
}
