import {
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
  readCodexMcpServerFromToml,
  readCodexProviderFromToml,
  resolveUpstreamProvider,
} from "../src/config.js";
import { readDaemonStatus } from "../src/daemon.js";
import { inspectCodexDoctor } from "../src/doctor.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

async function main() {
  const codexConfigPath = process.env.CODEX_CONFIG_PATH ?? defaultCodexConfigPath();
  const hooksConfigPath = process.env.CODEX_HOOKS_CONFIG_PATH ?? defaultHooksConfigPath();
  const tokenPilotConfigPath = process.env.TOKENPILOT_CODEX_CONFIG ?? defaultTokenPilotConfigPath();
  const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
  const doctor = await inspectCodexDoctor({
    config,
    configPath: codexConfigPath,
    tokenPilotConfigPath,
    hooksConfigPath,
  });
  const tokenpilotProvider = await readCodexProviderFromToml(config.providerName, codexConfigPath);
  const recoveryMcp = await readCodexMcpServerFromToml("tokenpilot_memory_fault_recover", codexConfigPath);
  const upstream = await resolveUpstreamProvider(config, codexConfigPath).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  const daemon = await readDaemonStatus(config);
  const hooksText = existsSync(hooksConfigPath) ? await readFile(hooksConfigPath, "utf8").catch(() => "") : "";
  const hookHandlerCount = (hooksText.match(/hooks-handler\.js/g) ?? []).length;
  console.log(JSON.stringify({
    ok: Boolean(tokenpilotProvider) && !("error" in upstream),
    codexConfigPath,
    hooksConfigPath,
    tokenPilotConfigPath,
    tokenpilotProvider: tokenpilotProvider ?? null,
    hooks: {
      installed: doctor.hooksInstalled,
      handlerCount: hookHandlerCount,
      duplicateWarning: hookHandlerCount > 4
        ? "multiple TokenPilot hooks are registered; rerun install to dedupe hooks.json"
        : undefined,
    },
    recoveryMcp,
    upstream,
    proxy: {
      baseUrl: doctor.proxyBaseUrl,
      healthOk: doctor.proxyHealthy,
      note: doctor.proxyHealthy ? "proxy is running" : "proxy is not running; start tokenpilot-codex serve",
    },
    daemon,
    modules: config.modules,
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
