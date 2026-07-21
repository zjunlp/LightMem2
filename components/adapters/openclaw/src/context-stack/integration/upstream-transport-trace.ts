import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pluginStateSubdir } from "@lightmem2/artifact-store";

export async function appendUpstreamTransportTrace(
  stateDir: string,
  record: Record<string, unknown>,
): Promise<void> {
  try {
    const tracePath = pluginStateSubdir(stateDir, "upstream-transport-trace.jsonl");
    await mkdir(dirname(tracePath), { recursive: true });
    await appendFile(tracePath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, "utf8");
  } catch {
    // best-effort trace only
  }
}
