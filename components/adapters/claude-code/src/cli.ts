#!/usr/bin/env node
import {
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
} from "./config.js";
import {
  readClaudeCodeDaemonStatus,
  startClaudeCodeDaemon,
  stopClaudeCodeDaemon,
} from "./daemon.js";
import { startClaudeCodeGatewayRuntime } from "./gateway-runtime.js";
import { createConsoleLogger } from "./logger.js";

function usage(): string {
  return [
    "Usage: tokenpilot-claude-code <command>",
    "",
    "Runtime commands:",
    "  serve      Start the local Claude Code gateway in the foreground",
    "  start      Start the gateway in the background",
    "  stop       Stop the background gateway",
    "  restart    Restart the background gateway",
    "  status     Print current adapter runtime status",
  ].join("\n");
}

async function main() {
  const [command] = process.argv.slice(2);
  const configPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG ?? defaultTokenPilotClaudeCodeConfigPath();
  const config = await loadTokenPilotClaudeCodeConfig(configPath);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  if (command === "serve") {
    const logger = createConsoleLogger(config.logLevel === "debug");
    await startClaudeCodeGatewayRuntime({ config, logger });
    await new Promise(() => undefined);
    return;
  }

  if (command === "start") {
    const result = await startClaudeCodeDaemon(config, {
      configPath,
      cliPath: process.argv[1],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "stop") {
    const result = await stopClaudeCodeDaemon(config);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "restart") {
    await stopClaudeCodeDaemon(config);
    const result = await startClaudeCodeDaemon(config, {
      configPath,
      cliPath: process.argv[1],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "status") {
    const daemon = await readClaudeCodeDaemonStatus(config);
    console.log(JSON.stringify({
      enabled: config.enabled,
      stateDir: config.stateDir,
      proxyBaseUrl: `http://127.0.0.1:${config.proxyPort}`,
      daemon,
      upstreamBaseUrl: config.upstreamBaseUrl,
      modules: config.modules,
      reduction: config.reduction,
    }, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
