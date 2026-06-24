import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function appendTrace(stateDir: string, payload: Record<string, unknown>): Promise<void> {
  const path = join(stateDir, "event-trace.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`, "utf8");
}
