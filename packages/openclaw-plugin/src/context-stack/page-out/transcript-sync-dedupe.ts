import type { RawSemanticTurnRecord } from "../../../../layers/history/src/types.js";

export function dedupeRawSemanticMessages(
  record: RawSemanticTurnRecord["messages"],
): RawSemanticTurnRecord["messages"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["messages"] = [];
  for (const item of record) {
    const key = `${item.anchor.turnAbsId}:${item.role}:${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function dedupeRawSemanticToolCalls(
  record: RawSemanticTurnRecord["toolCalls"],
): RawSemanticTurnRecord["toolCalls"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["toolCalls"] = [];
  for (const item of record) {
    const key = `${item.toolCallId}:${item.toolName}:${item.argumentsText ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function dedupeRawSemanticToolResults(
  record: RawSemanticTurnRecord["toolResults"],
): RawSemanticTurnRecord["toolResults"] {
  const seen = new Set<string>();
  const out: RawSemanticTurnRecord["toolResults"] = [];
  for (const item of record) {
    const key = `${item.toolCallId}:${item.toolName}:${item.status}:${item.fullText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
