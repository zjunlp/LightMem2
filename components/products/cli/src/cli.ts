import { dispatchCli } from "./dispatch.js";
import { maybeRunVisualDaemon } from "./hosts/visual.js";

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
