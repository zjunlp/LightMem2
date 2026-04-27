import { MEMORY_FAULT_RECOVER_TOOL_NAME } from "@ecoclaw/runtime-core";

const MEMORY_FAULT_PROTOCOL_INSTRUCTIONS = [
  "[EcoClaw Recovery Protocol]",
  `If a prior tool result contains \`[Tool payload trimmed]\`, that notice gives you a dataKey for the internal tool \`${MEMORY_FAULT_RECOVER_TOOL_NAME}\`.`,
  `When you need omitted content, call \`${MEMORY_FAULT_RECOVER_TOOL_NAME}\` with that dataKey instead of replying with plain text.`,
  `\`${MEMORY_FAULT_RECOVER_TOOL_NAME}\` behaves like an internal read of archived content. Do not call the original tool again for the same content.`,
  `After the recovery tool returns, continue your analysis normally in the next assistant step.`,
].join("\n");

export function injectMemoryFaultProtocolInstructions(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const current = typeof payload.instructions === "string" ? payload.instructions : "";
  if (current.includes("[EcoClaw Recovery Protocol]")) return false;
  payload.instructions = current
    ? `${current}\n\n${MEMORY_FAULT_PROTOCOL_INSTRUCTIONS}`
    : MEMORY_FAULT_PROTOCOL_INSTRUCTIONS;
  return true;
}

export function stripInternalPayloadMarkers(payload: any): void {
  if (!payload || typeof payload !== "object") return;
  if (Object.prototype.hasOwnProperty.call(payload, "__ecoclaw_reduction_applied")) {
    delete payload.__ecoclaw_reduction_applied;
  }
  if (!Array.isArray(payload.input)) return;
  payload.input = payload.input.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    let changed = false;
    const clone: Record<string, unknown> = { ...item };
    if (Object.prototype.hasOwnProperty.call(clone, "__ecoclaw_replay_raw")) {
      delete clone.__ecoclaw_replay_raw;
      changed = true;
    }
    return changed ? clone : item;
  });
}
