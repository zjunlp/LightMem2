import { dispatchCli } from "./dispatch.js";
import { maybeRunVisualDaemon } from "./hosts/visual.js";
import { initializeTokenPilotPreset } from "@lightmem2/tokenpilot";
import { CODEX_TOKENPILOT_HOST_BINDING } from "../../../adapters/codex/src/preset.js";

initializeTokenPilotPreset(CODEX_TOKENPILOT_HOST_BINDING);

async function main() {
  if (await maybeRunVisualDaemon(process.argv.slice(2))) {
    return;
  }
  const result = await dispatchCli(process.argv.slice(2));
  process.stdout.write(`${result.text}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
