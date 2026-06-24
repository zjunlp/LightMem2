#!/usr/bin/env node
import {
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
} from "./config.js";
import {
  readDaemonStatus,
  startDaemon,
  stopDaemon,
} from "./daemon.js";
import { createConsoleLogger } from "./logger.js";
import { startCodexResponsesProxy } from "./proxy-runtime.js";

function usage(): string {
  return [
    "Usage: tokenpilot-codex <command>",
    "",
    "Runtime commands:",
    "  serve      Start the local Codex Responses proxy in the foreground",
    "  start      Start the proxy in the background",
    "  stop       Stop the background proxy",
    "  restart    Restart the background proxy",
    "  status     Print current adapter runtime status",
  ].join("\n");
}

async function main() {
  const [command] = process.argv.slice(2);
  const configPath = process.env.TOKENPILOT_CODEX_CONFIG ?? defaultTokenPilotConfigPath();
  const config = await loadTokenPilotCodexConfig(configPath);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "serve") {
    const logger = createConsoleLogger(config.logLevel === "debug");
    await startCodexResponsesProxy({ config, logger });
    await new Promise(() => undefined);
    return;
  }

  if (command === "start") {
    const result = await startDaemon(config, {
      configPath,
      codexConfigPath: process.env.CODEX_CONFIG_PATH,
      cliPath: process.argv[1],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "stop") {
    const result = await stopDaemon(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "restart") {
    await stopDaemon(config);
    const result = await startDaemon(config, {
      configPath,
      codexConfigPath: process.env.CODEX_CONFIG_PATH,
      cliPath: process.argv[1],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    const daemon = await readDaemonStatus(config);
    console.log(JSON.stringify({
      enabled: config.enabled,
      stateDir: config.stateDir,
      proxyBaseUrl: `http://127.0.0.1:${config.proxyPort}/v1`,
      daemon,
      upstreamProvider: config.upstreamProvider,
      modules: config.modules,
      reduction: config.reduction,
      proxyMode: config.proxyMode,
    }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
