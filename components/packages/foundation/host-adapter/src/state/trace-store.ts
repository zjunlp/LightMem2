import { join } from "node:path";
import { appendJsonl } from "./file-store.js";

export function eventTracePath(stateDir: string): string {
  return join(stateDir, "event-trace.jsonl");
}

export async function appendEventTrace(
  stateDir: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await appendJsonl(eventTracePath(stateDir), {
    at: new Date().toISOString(),
    ...payload,
  });
}
