export const MEMORY_FAULT_RECOVER_TOOL_NAME = "memory_fault_recover";
export const MEMORY_FAULT_RECOVERY_TEXT_MARKER = "[Memory Fault Recovery]";

type AsRecord = (value: unknown) => Record<string, unknown> | undefined;

export function contextSafeRecovery(details: unknown, asRecord: AsRecord): Record<string, unknown> | undefined {
  const contextSafe = asRecord(asRecord(details)?.contextSafe);
  return asRecord(contextSafe?.recovery);
}

export function hasRecoveryMarker(details: unknown, asRecord: AsRecord): boolean {
  return Boolean(contextSafeRecovery(details, asRecord));
}

export function buildRecoveryContextSafePatch(source: string): Record<string, unknown> {
  return {
    recovery: {
      source,
      skipReduction: true,
    },
  };
}

export function hasRecoverySkipReductionFlag(details: unknown, asRecord: AsRecord): boolean {
  const directRecovery = asRecord(asRecord(details)?.recovery);
  if (directRecovery?.skipReduction === true) return true;
  const contextSafe = contextSafeRecovery(details, asRecord);
  return contextSafe?.skipReduction === true;
}

export function isRecoveryText(text: string): boolean {
  return text.includes(MEMORY_FAULT_RECOVERY_TEXT_MARKER);
}
