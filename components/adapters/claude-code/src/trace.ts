import { appendEventTrace } from "@lightmem2/host-adapter";

export async function appendClaudeCodeTrace(
  stateDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendEventTrace(stateDir, payload);
}
