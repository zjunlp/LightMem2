import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
