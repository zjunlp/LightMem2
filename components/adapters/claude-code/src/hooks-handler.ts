#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultTokenPilotClaudeCodeConfigPath } from "./config.js";
import { startClaudeCodeDaemon } from "./daemon.js";
import { createConsoleLogger } from "./logger.js";
import { loadTokenPilotClaudeCodeConfig } from "./config.js";
import { processClaudeCodeHookEvent } from "./hook-runtime.js";

export async function readClaudeCodeHookStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

function resolveClaudeCodeCliLaunchArgs(): string[] {
  const override = process.env.TOKENPILOT_CLAUDE_CODE_CLI?.trim();
  if (override) {
    return [override, "serve"];
  }
  const distCli = resolve(__dirname, "cli.js");
  if (existsSync(distCli)) {
    return [distCli, "serve"];
  }
  const srcCli = resolve(__dirname, "cli.ts");
  if (existsSync(srcCli)) {
    return ["--import", "tsx", srcCli, "serve"];
  }
  return [process.argv[1] ?? "", "serve"];
}

export async function runClaudeCodeHooksHandler(input: Record<string, unknown>, configPath?: string): Promise<void> {
  const resolvedConfigPath = configPath ?? process.env.TOKENPILOT_CLAUDE_CODE_CONFIG ?? defaultTokenPilotClaudeCodeConfigPath();
  const hookEventName = typeof input.hook_event_name === "string"
    ? input.hook_event_name
    : typeof input.hookEventName === "string"
      ? input.hookEventName
      : typeof input.event === "string"
        ? input.event
        : undefined;
  if (hookEventName === "SessionStart") {
    const config = await loadTokenPilotClaudeCodeConfig(resolvedConfigPath);
    await startClaudeCodeDaemon(config, {
      configPath: resolvedConfigPath,
      cliArgs: resolveClaudeCodeCliLaunchArgs(),
    });
    createConsoleLogger(config.logLevel === "debug").debug("ensured Claude Code gateway is running from SessionStart");
  }
  await processClaudeCodeHookEvent({
    input,
    configPath: resolvedConfigPath,
  });
}

async function main() {
  const input = await readClaudeCodeHookStdinJson();
  const configPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG ?? defaultTokenPilotClaudeCodeConfigPath();
  await runClaudeCodeHooksHandler(input, configPath);
}

if (
  process.argv[1]
  && /(^|\/)hooks-handler\.(ts|js)$/.test(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
