export const MEMORY_FAULT_RECOVER_TOOL_NAME = "memory_fault_recover";

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
