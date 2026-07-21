import { appendEventTrace } from "@tokenpilot/host-adapter";

export async function appendTrace(stateDir: string, payload: Record<string, unknown>): Promise<void> {
  await appendEventTrace(stateDir, payload);
}
