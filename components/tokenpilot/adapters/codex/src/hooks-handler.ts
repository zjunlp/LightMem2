#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  defaultCodexConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
} from "./config.js";
import {
  readDaemonStatus,
  startDaemon,
} from "./daemon.js";
import { appendTrace } from "./trace.js";
import { dirname, join } from "node:path";

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = stringValue(obj[key]);
    if (direct) return direct;
  }
  for (const child of Object.values(obj)) {
    if (!child || typeof child !== "object") continue;
    const nested = findFirstString(child, keys);
    if (nested) return nested;
  }
  return undefined;
}

function estimateTextChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value == null) return 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTextChars(item), 0);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .reduce<number>((sum, item) => sum + estimateTextChars(item), 0);
  }
  return String(value).length;
}

function extractToolEvent(input: Record<string, unknown>): {
  toolName: string | null;
  toolInputChars: number;
  toolOutputChars: number;
} {
  const toolName = findFirstString(input, ["tool_name", "toolName", "name", "tool"]);
  const outputLike =
    (input.tool_response ?? input.toolResponse ?? input.response ?? input.result ?? input.output) as unknown;
  const inputLike =
    (input.tool_input ?? input.toolInput ?? input.input ?? input.arguments ?? input.args) as unknown;
  return {
    toolName: toolName ?? null,
    toolInputChars: estimateTextChars(inputLike),
    toolOutputChars: estimateTextChars(outputLike),
  };
}

function finishSuccess(): void {
  // Codex validates hook stdout against event-specific schemas. Empty stdout
  // with exit 0 is accepted as success for every hook event, so keep control
  // hooks silent unless we intentionally need to block or inject context.
}

async function main() {
  const event = await readStdinJson();
  const hookEventName = stringValue(event.hook_event_name) ?? stringValue(event.event) ?? "unknown";
  const configPath = process.env.TOKENPILOT_CODEX_CONFIG ?? defaultTokenPilotConfigPath();
  const codexConfigPath = process.env.CODEX_CONFIG_PATH ?? defaultCodexConfigPath();
  const config = await loadTokenPilotCodexConfig(configPath);
  const common = {
    hookEventName,
    codexSessionId: stringValue(event.session_id) ?? null,
    transcriptPath: stringValue(event.transcript_path) ?? null,
    cwd: stringValue(event.cwd) ?? null,
    model: stringValue(event.model) ?? null,
  };

  if (hookEventName === "SessionStart") {
    const defaultCliPath = join(dirname(process.argv[1]), "cli.js");
    const daemon = await startDaemon(config, {
      configPath,
      codexConfigPath,
      cliPath: process.env.TOKENPILOT_CODEX_CLI ?? defaultCliPath,
    });
    await appendTrace(config.stateDir, {
      stage: "codex_hook_session_start",
      ...common,
      daemon,
    });
    finishSuccess();
    return;
  }

  if (hookEventName === "PostToolUse") {
    const tool = extractToolEvent(event);
    await appendTrace(config.stateDir, {
      stage: "codex_hook_post_tool_use",
      ...common,
      ...tool,
    });
    finishSuccess();
    return;
  }

  if (hookEventName === "PreToolUse") {
    const tool = extractToolEvent(event);
    await appendTrace(config.stateDir, {
      stage: "codex_hook_pre_tool_use",
      ...common,
      ...tool,
    });
    finishSuccess();
    return;
  }

  if (hookEventName === "Stop") {
    const daemon = await readDaemonStatus(config);
    await appendTrace(config.stateDir, {
      stage: "codex_hook_stop",
      ...common,
      daemon,
    });
    finishSuccess();
    return;
  }

  await appendTrace(config.stateDir, {
    stage: "codex_hook_observed",
    ...common,
  });
  finishSuccess();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
