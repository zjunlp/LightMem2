import type { JsonObject } from "./types.js";

export type CodexReplayabilityMode = "replayable" | "observation_only" | "deferred";

export type CodexReplayabilityReason =
  | "default_replayable"
  | "tool_closure_required"
  | "tool_call_id_missing"
  | "exact_payload_required"
  | "exact_payload_missing"
  | "program_payload_required"
  | "program_payload_missing"
  | "provider_output_replay"
  | "provider_observation"
  | "turn_context_instruction"
  | "unsupported_item_type";

export type CodexItemReplayability = {
  mode: CodexReplayabilityMode;
  reason: CodexReplayabilityReason;
};

export type CodexReplayPairKind =
  | "function"
  | "custom"
  | "computer"
  | "local_shell"
  | "shell"
  | "apply_patch"
  | "tool_search";

export type CodexReplayPairRef = {
  callId?: string;
  kind?: CodexReplayPairKind;
  side?: "call" | "output";
  type: string;
};

const REPLAY_PAIR_TYPES = new Map<string, Omit<CodexReplayPairRef, "callId" | "type">>([
  ["function_call", { kind: "function", side: "call" }],
  ["function_call_output", { kind: "function", side: "output" }],
  ["custom_tool_call", { kind: "custom", side: "call" }],
  ["custom_tool_call_output", { kind: "custom", side: "output" }],
  ["computer_call", { kind: "computer", side: "call" }],
  ["computer_call_output", { kind: "computer", side: "output" }],
  ["local_shell_call", { kind: "local_shell", side: "call" }],
  ["local_shell_call_output", { kind: "local_shell", side: "output" }],
  ["shell_call", { kind: "shell", side: "call" }],
  ["shell_call_output", { kind: "shell", side: "output" }],
  ["apply_patch_call", { kind: "apply_patch", side: "call" }],
  ["apply_patch_call_output", { kind: "apply_patch", side: "output" }],
]);

const OPTIONAL_REPLAY_PAIR_TYPES = new Map<string, Omit<CodexReplayPairRef, "callId" | "type">>([
  ["tool_search_call", { kind: "tool_search", side: "call" }],
  ["tool_search_output", { kind: "tool_search", side: "output" }],
]);

// These are provider-produced Responses items that can be copied back into a
// stateless input array. Provider acceptance is still checked separately by
// the capability store before a rebase is committed.
const PROVIDER_OUTPUT_REPLAY_TYPES = new Set([
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "image_generation_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "tool_search_call",
  "tool_search_output",
  "additional_tools",
]);

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function codexReplayPairRef(item: JsonObject): CodexReplayPairRef {
  const type = String(item.type ?? "").toLowerCase();
  const callId = nonBlankString(item.call_id);
  const pair = REPLAY_PAIR_TYPES.get(type) ?? (callId ? OPTIONAL_REPLAY_PAIR_TYPES.get(type) : undefined);
  return pair
    ? { ...pair, type, callId }
    : { type };
}

export function codexProgramCallerId(item: JsonObject): string | undefined {
  const caller = item.caller;
  if (!caller || typeof caller !== "object" || Array.isArray(caller)) return undefined;
  const callerObject = caller as JsonObject;
  return String(callerObject.type ?? "").toLowerCase() === "program"
    ? nonBlankString(callerObject.caller_id)
    : undefined;
}

export function codexReplayabilityForItem(item: JsonObject): CodexItemReplayability {
  const type = String(item.type ?? "").toLowerCase();
  const role = String(item.role ?? "").toLowerCase();
  if (type === "event_msg") {
    return { mode: "observation_only", reason: "provider_observation" };
  }
  if (type === "turn_context") {
    return { mode: "observation_only", reason: "turn_context_instruction" };
  }
  if (REPLAY_PAIR_TYPES.has(type)) {
    return nonBlankString(item.call_id)
      ? { mode: "replayable", reason: "tool_closure_required" }
      : { mode: "deferred", reason: "tool_call_id_missing" };
  }
  if (OPTIONAL_REPLAY_PAIR_TYPES.has(type)
    && String(item.execution ?? "").toLowerCase() === "client") {
    return nonBlankString(item.call_id)
      ? { mode: "replayable", reason: "tool_closure_required" }
      : { mode: "deferred", reason: "tool_call_id_missing" };
  }
  if (type === "reasoning" || type === "compaction") {
    return nonBlankString(item.encrypted_content)
      ? { mode: "replayable", reason: "exact_payload_required" }
      : { mode: "deferred", reason: "exact_payload_missing" };
  }
  if (type === "program") {
    return nonBlankString(item.call_id)
      && nonBlankString(item.code)
      && nonBlankString(item.fingerprint)
      ? { mode: "replayable", reason: "program_payload_required" }
      : { mode: "deferred", reason: "program_payload_missing" };
  }
  if (type === "program_output") {
    const status = String(item.status ?? "").toLowerCase();
    return nonBlankString(item.call_id)
      && typeof item.result === "string"
      && (status === "completed" || status === "incomplete")
      ? { mode: "replayable", reason: "program_payload_required" }
      : { mode: "deferred", reason: "program_payload_missing" };
  }
  if (PROVIDER_OUTPUT_REPLAY_TYPES.has(type)) {
    return { mode: "replayable", reason: "provider_output_replay" };
  }
  if (type === "message" || (!type && ["system", "developer", "user", "assistant"].includes(role))) {
    return { mode: "replayable", reason: "default_replayable" };
  }
  return { mode: "deferred", reason: "unsupported_item_type" };
}

export function isCodexObservationOnlyItem(item: JsonObject): boolean {
  return codexReplayabilityForItem(item).mode === "observation_only";
}

export function isCodexDeferredItem(item: JsonObject): boolean {
  return codexReplayabilityForItem(item).mode === "deferred";
}
