import {
  appendRecoveryProtocolText,
  stripInternalPayloadFields,
} from "@tokenpilot/host-adapter";
import { MEMORY_FAULT_RECOVER_TOOL_NAME } from "@tokenpilot/artifact-store";

export const MEMORY_FAULT_PROTOCOL_INSTRUCTIONS = [
  "[Recovery Protocol]",
  `If a prior tool result contains \`[Tool payload trimmed]\`, that notice gives you a dataKey for the internal tool \`${MEMORY_FAULT_RECOVER_TOOL_NAME}\`.`,
  `When you need omitted content, call \`${MEMORY_FAULT_RECOVER_TOOL_NAME}\` with that dataKey instead of replying with plain text.`,
  `For code or file reads, prefer a focused recovery window with \`startLine\` and \`endLine\` when you only need part of the archive.`,
  `\`${MEMORY_FAULT_RECOVER_TOOL_NAME}\` behaves like an internal read of archived content. Do not call the original tool again for the same content.`,
  `After the recovery tool returns, continue your analysis normally in the next assistant step.`,
].join("\n");

export function injectMemoryFaultProtocolInstructionsText(currentInstructions?: string): {
  changed: boolean;
  instructions: string;
} {
  return appendRecoveryProtocolText({
    currentInstructions: typeof currentInstructions === "string" ? currentInstructions : "",
    protocolText: MEMORY_FAULT_PROTOCOL_INSTRUCTIONS,
    disableEnvVar: "TOKENPILOT_DISABLE_RECOVERY_PROTOCOL",
  });
}

export function injectMemoryFaultProtocolInstructions(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const result = injectMemoryFaultProtocolInstructionsText(
    typeof payload.instructions === "string" ? payload.instructions : "",
  );
  if (!result.changed) return false;
  payload.instructions = result.instructions;
  return true;
}

export function stripInternalPayloadMarkers(payload: any): void {
  stripInternalPayloadFields(payload, {
    topLevelKeys: ["__tokenpilot_reduction_applied"],
    inputItemKeys: ["__tokenpilot_replay_raw"],
  });
}
