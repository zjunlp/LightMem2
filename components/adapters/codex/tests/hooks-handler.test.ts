import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { writeTokenPilotCodexConfig, normalizeTokenPilotCodexConfig } from "../src/config.js";
import { processCodexHookEvent } from "../src/hooks-handler.js";
import { indexCodexHostSessionAlias, upsertCodexSessionSnapshot } from "../src/session-state.js";

test("processCodexHookEvent records hook snapshot metadata without overriding the latest synthesized session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-hooks-handler-"));
  const originalCodexConfig = process.env.TOKENPILOT_CODEX_CONFIG;
  try {
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    process.env.TOKENPILOT_CODEX_CONFIG = configPath;

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        stateDir,
        proxyPort: 17667,
      }),
      configPath,
    );
    await upsertCodexSessionSnapshot(stateDir, "codex-synth-existing", {
      latestResponseId: "resp-1",
    });

    await processCodexHookEvent({
      hook_event_name: "PostToolUse",
      session_id: "019f-real-codex-session",
      cwd: "/repo/from-hook",
      tool_name: "read",
      tool_input: "file.ts",
      tool_response: "content",
    });

    const latestRaw = await readFile(join(stateDir, "session-state", "latest.json"), "utf8");
    const latest = JSON.parse(latestRaw) as { sessionId?: string };
    assert.equal(latest.sessionId, "codex-synth-existing");

    const hookSnapshotRaw = await readFile(
      join(stateDir, "session-state", "sessions", encodeURIComponent("019f-real-codex-session") + ".json"),
      "utf8",
    );
    const hookSnapshot = JSON.parse(hookSnapshotRaw) as {
      workspaceHint?: string;
      lastHookEvent?: string;
      lastToolName?: string;
    };
    assert.equal(hookSnapshot.workspaceHint, "/repo/from-hook");
    assert.equal(hookSnapshot.lastHookEvent, "PostToolUse");
    assert.equal(hookSnapshot.lastToolName, "read");
  } finally {
    if (originalCodexConfig === undefined) {
      delete process.env.TOKENPILOT_CODEX_CONFIG;
    } else {
      process.env.TOKENPILOT_CODEX_CONFIG = originalCodexConfig;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("processCodexHookEvent writes directly into the synthesized session after alias binding exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-hooks-handler-alias-"));
  const originalCodexConfig = process.env.TOKENPILOT_CODEX_CONFIG;
  try {
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    process.env.TOKENPILOT_CODEX_CONFIG = configPath;

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        stateDir,
        proxyPort: 17667,
      }),
      configPath,
    );
    await upsertCodexSessionSnapshot(stateDir, "codex-synth-existing", {
      latestResponseId: "resp-1",
    });

    await indexCodexHostSessionAlias(stateDir, "019f-real-codex-session", "codex-synth-existing");

    await processCodexHookEvent({
      hook_event_name: "PostToolUse",
      session_id: "019f-real-codex-session",
      cwd: "/repo/from-hook",
      tool_name: "grep",
      tool_input: "query",
      tool_response: "result",
    });

    const synthSnapshotRaw = await readFile(
      join(stateDir, "session-state", "sessions", encodeURIComponent("codex-synth-existing") + ".json"),
      "utf8",
    );
    const synthSnapshot = JSON.parse(synthSnapshotRaw) as {
      workspaceHint?: string;
      lastHookEvent?: string;
      lastToolName?: string;
    };
    assert.equal(synthSnapshot.workspaceHint, "/repo/from-hook");
    assert.equal(synthSnapshot.lastHookEvent, "PostToolUse");
    assert.equal(synthSnapshot.lastToolName, "grep");
  } finally {
    if (originalCodexConfig === undefined) {
      delete process.env.TOKENPILOT_CODEX_CONFIG;
    } else {
      process.env.TOKENPILOT_CODEX_CONFIG = originalCodexConfig;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("processCodexHookEvent returns minimal JSON output for Stop hooks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-hooks-handler-stop-"));
  const originalCodexConfig = process.env.TOKENPILOT_CODEX_CONFIG;
  try {
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    process.env.TOKENPILOT_CODEX_CONFIG = configPath;

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        stateDir,
        proxyPort: 17667,
      }),
      configPath,
    );

    const output = await processCodexHookEvent({
      hook_event_name: "Stop",
      session_id: "019f-real-codex-session",
      cwd: "/repo/from-hook",
    });

    assert.equal(output, "{}\n");
  } finally {
    if (originalCodexConfig === undefined) {
      delete process.env.TOKENPILOT_CODEX_CONFIG;
    } else {
      process.env.TOKENPILOT_CODEX_CONFIG = originalCodexConfig;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("processCodexHookEvent handles deeply nested tool output without overflowing the stack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-hooks-handler-deep-"));
  const originalCodexConfig = process.env.TOKENPILOT_CODEX_CONFIG;
  try {
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    process.env.TOKENPILOT_CODEX_CONFIG = configPath;

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({ stateDir, proxyPort: 17667 }),
      configPath,
    );

    const toolResponse: Record<string, unknown> = {};
    let cursor = toolResponse;
    for (let depth = 0; depth < 12_000; depth += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    cursor.output = "complete";

    await processCodexHookEvent({
      hook_event_name: "PostToolUse",
      session_id: "deep-hook-session",
      cwd: "/repo/from-hook",
      tool_name: "Bash",
      tool_response: toolResponse,
    });

    const snapshotRaw = await readFile(
      join(stateDir, "session-state", "sessions", "deep-hook-session.json"),
      "utf8",
    );
    const snapshot = JSON.parse(snapshotRaw) as { lastToolOutputChars?: number };
    assert.equal(snapshot.lastToolOutputChars, "complete".length);
  } finally {
    if (originalCodexConfig === undefined) {
      delete process.env.TOKENPILOT_CODEX_CONFIG;
    } else {
      process.env.TOKENPILOT_CODEX_CONFIG = originalCodexConfig;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("processCodexHookEvent treats observation persistence failures as best effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-hooks-handler-best-effort-"));
  const originalCodexConfig = process.env.TOKENPILOT_CODEX_CONFIG;
  const originalConsoleError = console.error;
  const errors: string[] = [];
  try {
    const blockedStateDir = join(dir, "blocked-state");
    const configPath = join(dir, "tokenpilot.json");
    await writeFile(blockedStateDir, "not a directory", "utf8");
    process.env.TOKENPILOT_CODEX_CONFIG = configPath;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({ stateDir: blockedStateDir, proxyPort: 17667 }),
      configPath,
    );

    const output = await processCodexHookEvent({
      hook_event_name: "PostToolUse",
      session_id: "best-effort-hook-session",
      cwd: "/repo/from-hook",
      tool_name: "Bash",
      tool_response: "complete",
    });

    assert.equal(output, undefined);
    assert.ok(errors.some((message) => message.includes("continuing without hook telemetry")));
  } finally {
    console.error = originalConsoleError;
    if (originalCodexConfig === undefined) {
      delete process.env.TOKENPILOT_CODEX_CONFIG;
    } else {
      process.env.TOKENPILOT_CODEX_CONFIG = originalCodexConfig;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
