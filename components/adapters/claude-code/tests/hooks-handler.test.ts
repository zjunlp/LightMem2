import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../src/config.js";
import { readClaudeCodeDaemonStatus } from "../src/daemon.js";
import { runClaudeCodeHooksHandler } from "../src/hooks-handler.js";

test("hooks-handler entry function records Claude Code observability events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-hooks-handler-"));
  try {
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        stateDir,
      }),
      configPath,
    );

    await runClaudeCodeHooksHandler({
      hook_event_name: "PreToolUse",
      session_id: "sess-script-1",
      cwd: "/repo/script-demo",
      tool_name: "grep",
      tool_input: {
        pattern: "TODO",
      },
    }, configPath);

    const latest = JSON.parse(
      await readFile(join(stateDir, "session-state", "latest.json"), "utf8"),
    ) as { sessionId: string };
    assert.equal(latest.sessionId, "sess-script-1");

    const snapshot = JSON.parse(
      await readFile(join(stateDir, "session-state", "sessions", "sess-script-1.json"), "utf8"),
    ) as { lastHookEvent?: string; lastToolName?: string; workspaceHint?: string };
    assert.equal(snapshot.lastHookEvent, "PreToolUse");
    assert.equal(snapshot.lastToolName, "grep");
    assert.equal(snapshot.workspaceHint, "/repo/script-demo");

    const trace = await readFile(join(stateDir, "event-trace.jsonl"), "utf8");
    assert.match(trace, /claude_code_hook_pre_tool_use/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hooks-handler SessionStart auto-starts the Claude Code gateway daemon", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-hooks-autostart-"));
  try {
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    const proxyPort = 18668;
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        stateDir,
        proxyPort,
      }),
      configPath,
    );

    await runClaudeCodeHooksHandler({
      hook_event_name: "SessionStart",
      session_id: "sess-start-1",
      cwd: "/repo/start-demo",
    }, configPath);

    const status = await readClaudeCodeDaemonStatus(
      normalizeTokenPilotClaudeCodeConfig({
        stateDir,
        proxyPort,
      }),
    );
    assert.equal(status.running, true);

    const resp = await fetch(`http://127.0.0.1:${proxyPort}/health`);
    assert.equal(resp.ok, true);

    if (status.pid) {
      try {
        process.kill(status.pid, "SIGTERM");
      } catch {
        // ignore shutdown races
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
