import type { HostRequestEnvelope } from "../model/host-request.js";
import { extractContentText, replaceContentText } from "@tokenpilot/kernel";

export const DEFAULT_RECOVERY_TOOL_NAME = "memory_fault_recover";

const DEFAULT_RECOVERY_PROTOCOL = [
  "[Recovery Protocol]",
  `If a prior tool result contains \`[Tool payload trimmed]\`, use \`${DEFAULT_RECOVERY_TOOL_NAME}\` with the provided dataKey instead of re-calling the original tool.`,
  `For code or file reads, you may recover only the needed window with \`startLine\` and \`endLine\` to avoid pulling back the whole archive.`,
  `Treat \`${DEFAULT_RECOVERY_TOOL_NAME}\` as an internal archive read, then continue your analysis normally after recovery.`,
].join("\n");

function recoveryProtocolDisabled(): boolean {
  const raw = String(process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function appendRecoveryProtocolText(params: {
  currentInstructions?: string;
  protocolText: string;
  disableEnvVar?: string;
}): {
  changed: boolean;
  instructions: string;
} {
  const disableEnvVar = String(params.disableEnvVar ?? "TOKENPILOT_DISABLE_RECOVERY_PROTOCOL");
  const rawDisable = String(process.env[disableEnvVar] ?? "").trim().toLowerCase();
  const disabled =
    rawDisable === "1" ||
    rawDisable === "true" ||
    rawDisable === "yes" ||
    rawDisable === "on";
  const current = String(params.currentInstructions ?? "");
  if (disabled || current.includes("[Recovery Protocol]")) {
    return {
      changed: false,
      instructions: current,
    };
  }
  return {
    changed: true,
    instructions: current.trim()
      ? `${current}\n\n${params.protocolText}`
      : params.protocolText,
  };
}

export function stripInternalPayloadFields(
  rawPayload: any,
  options?: {
    topLevelKeys?: string[];
    inputField?: string;
    inputItemKeys?: string[];
  },
): void {
  if (!rawPayload || typeof rawPayload !== "object") return;
  const topLevelKeys = options?.topLevelKeys ?? [];
  const inputField = String(options?.inputField ?? "input");
  const inputItemKeys = options?.inputItemKeys ?? [];

  for (const key of topLevelKeys) {
    if (Object.prototype.hasOwnProperty.call(rawPayload, key)) {
      delete rawPayload[key];
    }
  }

  const input = rawPayload[inputField];
  if (!Array.isArray(input) || inputItemKeys.length === 0) return;
  rawPayload[inputField] = input.map((item: any) => {
    if (!item || typeof item !== "object") return item;
    let changed = false;
    const clone: Record<string, unknown> = { ...item };
    for (const key of inputItemKeys) {
      if (Object.prototype.hasOwnProperty.call(clone, key)) {
        delete clone[key];
        changed = true;
      }
    }
    return changed ? clone : item;
  });
}

export function defaultInjectRecoveryProtocol(
  envelope: HostRequestEnvelope,
): HostRequestEnvelope {
  if (recoveryProtocolDisabled()) return envelope;

  const instructionResult = appendRecoveryProtocolText({
    currentInstructions: typeof envelope.instructions === "string" ? envelope.instructions : "",
    protocolText: DEFAULT_RECOVERY_PROTOCOL,
  });

  if (instructionResult.changed && instructionResult.instructions.trim()) {
    return {
      ...envelope,
      instructions: instructionResult.instructions,
    };
  }

  const systemIndex = envelope.messages.findIndex((message) => message?.role === "system");
  if (systemIndex >= 0) {
    const systemMessage = envelope.messages[systemIndex];
    const systemText = extractContentText(systemMessage.content);
    if (systemText.includes("[Recovery Protocol]")) return envelope;
    const nextMessages = envelope.messages.slice();
    nextMessages[systemIndex] = {
      ...systemMessage,
      content: replaceContentText(
        systemMessage.content,
        systemText.trim()
          ? `${systemText}\n\n${DEFAULT_RECOVERY_PROTOCOL}`
          : DEFAULT_RECOVERY_PROTOCOL,
      ),
    };
    return {
      ...envelope,
      messages: nextMessages,
    };
  }

  return {
    ...envelope,
    messages: [
      {
        role: "system",
        content: DEFAULT_RECOVERY_PROTOCOL,
      },
      ...envelope.messages,
    ],
  };
}

export function injectRecoveryProtocolEnvelope(
  envelope: HostRequestEnvelope,
  transform?: (envelope: HostRequestEnvelope) => HostRequestEnvelope,
): { envelope: HostRequestEnvelope; applied: boolean } {
  const next = (transform ?? defaultInjectRecoveryProtocol)(envelope);
  return { envelope: next, applied: next !== envelope };
}
