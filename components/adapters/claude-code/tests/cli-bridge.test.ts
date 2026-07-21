import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createClaudeCodeCliBridge } from "../../../products/cli/src/hosts/claude-code.js";
import {
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
} from "../src/config.js";

test("claude-code cli bridge exposes only the supported Claude Code command surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-bridge-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    await mkdir(join(dir, ".openclaw"), { recursive: true });
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      `${JSON.stringify({ plugins: { entries: {} } }, null, 2)}\n`,
      "utf8",
    );
    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });

    const status = await handleCommand({ args: "status" });
    assert.match(status.text, /TokenPilot Claude Code status:/);
    assert.doesNotMatch(status.text, /lifecycle eviction/i);
    assert.doesNotMatch(status.text, /task-state estimator/i);

    const reduction = await handleCommand({ args: "reduction off" });
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const reductionStatus = await handleCommand({ args: "reduction status" });
    assert.match(reductionStatus.text, /Observation Reduction \(Claude Code\):/);
    assert.doesNotMatch(reductionStatus.text, /formatSlimming/);

    const stabilizer = await handleCommand({ args: "stabilizer target user" });
    assert.equal(stabilizer.text, "✅ hooks.dynamicContextTarget = user");

    const doctor = await handleCommand({ args: "doctor" });
    assert.match(doctor.text, /TokenPilot Claude Code doctor:/);

    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=claude-code/);

    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "No TokenPilot session stats yet.");

    const unsupportedSettings = await handleCommand({ args: "settings details on" });
    assert.equal(unsupportedSettings.text, "Claude Code does not expose shared runtime settings yet.");

    const unsupportedEviction = await handleCommand({ args: "eviction on" });
    assert.equal(unsupportedEviction.text, "Claude Code lifecycle eviction controls are not supported.");

    const aggressiveMode = await handleCommand({ args: "mode aggressive" });
    assert.equal(aggressiveMode.text, "Claude Code does not support lifecycle eviction mode. Use `mode normal` or `mode conservative`.");

    const unsupportedHook = await handleCommand({ args: "stabilizer hook on" });
    assert.equal(unsupportedHook.text, "Claude Code currently supports only `stabilizer on|off` and `stabilizer target <developer|user>`.");

    const unsupportedReductionPass = await handleCommand({ args: "reduction pass formatSlimming on" });
    assert.equal(unsupportedReductionPass.text, "Claude Code reduction supports only these passes: readStateCompaction, toolPayloadTrim, htmlSlimming, execOutputTruncation, agentsStartupOptimization");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude-code cli bridge follows custom config env paths instead of the default home paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-bridge-custom-paths-"));
  const originalHome = process.env.HOME;
  const originalSettingsPath = process.env.CLAUDE_CODE_SETTINGS_PATH;
  const originalMcpConfigPath = process.env.CLAUDE_CODE_MCP_CONFIG_PATH;
  const originalTokenPilotConfigPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG;
  process.env.HOME = join(dir, "real-home");
  process.env.CLAUDE_CODE_SETTINGS_PATH = join(dir, "isolated", "settings.json");
  process.env.CLAUDE_CODE_MCP_CONFIG_PATH = join(dir, "isolated", ".claude.json");
  process.env.TOKENPILOT_CLAUDE_CODE_CONFIG = join(dir, "isolated", "tokenpilot.json");
  try {
    await mkdir(join(dir, "isolated"), { recursive: true });
    await writeFile(
      process.env.CLAUDE_CODE_SETTINGS_PATH!,
      JSON.stringify({ env: {}, hooks: {} }, null, 2),
      "utf8",
    );
    await writeFile(
      process.env.CLAUDE_CODE_MCP_CONFIG_PATH!,
      JSON.stringify({ mcpServers: {} }, null, 2),
      "utf8",
    );

    const bridge = createClaudeCodeCliBridge({ host: "claude-code" });
    const status = await bridge.handleCommand({ args: "status" });
    assert.match(status.text, /proxyPort: 17668/);

    const doctor = await bridge.handleCommand({ args: "doctor" });
    assert.match(doctor.text, new RegExp(process.env.TOKENPILOT_CLAUDE_CODE_CONFIG!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(doctor.text, new RegExp(process.env.CLAUDE_CODE_SETTINGS_PATH!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(doctor.text, new RegExp(process.env.CLAUDE_CODE_MCP_CONFIG_PATH!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const reloaded = await loadTokenPilotClaudeCodeConfig(process.env.TOKENPILOT_CLAUDE_CODE_CONFIG!);
    assert.equal(reloaded.stateDir, join(dir, "isolated", "tokenpilot-state", "tokenpilot"));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSettingsPath === undefined) delete process.env.CLAUDE_CODE_SETTINGS_PATH;
    else process.env.CLAUDE_CODE_SETTINGS_PATH = originalSettingsPath;
    if (originalMcpConfigPath === undefined) delete process.env.CLAUDE_CODE_MCP_CONFIG_PATH;
    else process.env.CLAUDE_CODE_MCP_CONFIG_PATH = originalMcpConfigPath;
    if (originalTokenPilotConfigPath === undefined) delete process.env.TOKENPILOT_CLAUDE_CODE_CONFIG;
    else process.env.TOKENPILOT_CLAUDE_CODE_CONFIG = originalTokenPilotConfigPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude-code cli bridge visual opens the shared browser visual pinned to the Claude session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-bridge-visual-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const stateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");
    const codexStateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(codexStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(stateDir, "session-state", "sessions"), { recursive: true });
    await mkdir(join(stateDir, "session-state", "bindings"), { recursive: true });
    await mkdir(join(dir, ".openclaw"), { recursive: true });
    await mkdir(join(dir, ".codex"), { recursive: true });
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      `${JSON.stringify({ plugins: { entries: {} } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(stateDir, "session-state", "latest.json"),
      JSON.stringify({ sessionId: "session-1", updatedAt: "2026-06-26T10:00:00.000Z" }, null, 2),
      "utf8",
    );
    await writeFile(
      join(stateDir, "session-state", "sessions", "session-1.json"),
      JSON.stringify({
        sessionId: "session-1",
        latestResponseId: "msg-3",
        previousResponseId: "msg-2",
        latestModel: "claude-sonnet-4-6",
        workspaceHint: "/repo/demo",
        lastHookEvent: "PostToolUse",
        lastToolName: "Read",
        lastToolInputChars: 64,
        lastToolOutputChars: 512,
        requestChars: 1200,
        responseChars: 720,
        assistantChars: 330,
        reductionSavedChars: 880,
        updatedAt: "2026-06-26T10:00:00.000Z",
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(stateDir, "session-state", "bindings", "session-1.jsonl"),
      [
        JSON.stringify({
          sessionId: "session-1",
          responseId: "msg-2",
          previousResponseId: "msg-1",
          model: "claude-sonnet-4-6",
          requestChars: 1000,
          responseChars: 500,
          assistantChars: 210,
          reductionSavedChars: 300,
          stream: false,
          updatedAt: "2026-06-26T09:59:00.000Z",
        }),
        JSON.stringify({
          sessionId: "session-1",
          responseId: "msg-3",
          previousResponseId: "msg-2",
          model: "claude-sonnet-4-6",
          requestChars: 1200,
          responseChars: 720,
          assistantChars: 330,
          reductionSavedChars: 880,
          stream: true,
          updatedAt: "2026-06-26T10:00:00.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });
    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=claude-code/);
    assert.match(visual.text, /session=session-1/);
    assert.match(visual.text, /Claude Code: 0 session snapshots/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude-code cli bridge report explains when a session has no recorded savings yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-bridge-report-empty-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const stateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "ux-effects"), { recursive: true });
    await writeFile(
      join(stateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-28T10:00:00.000Z",
        sessionId: "session-empty",
        model: "claude-sonnet-4-6",
        countMode: "chars",
        beforeCount: 100,
        afterCount: 100,
        savedCount: 0,
      }, null, 2),
      "utf8",
    );

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });
    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "No TokenPilot savings recorded yet for session session-empty.");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude-code cli bridge persists only supported settings across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-bridge-persist-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const bridge = createClaudeCodeCliBridge({ host: "claude-code" });

    const reduction = await bridge.handleCommand({ args: "reduction off" });
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const target = await bridge.handleCommand({ args: "stabilizer target user" });
    assert.equal(target.text, "✅ hooks.dynamicContextTarget = user");

    const unsupported = await bridge.handleCommand({ args: "settings details on" });
    assert.equal(unsupported.text, "Claude Code does not expose shared runtime settings yet.");

    const reloaded = await loadTokenPilotClaudeCodeConfig(defaultTokenPilotClaudeCodeConfigPath());
    assert.equal(reloaded.modules.reduction, false);
    assert.equal(reloaded.hooks.dynamicContextTarget, "user");
    assert.equal("ux" in (reloaded as unknown as Record<string, unknown>), false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude-code mode writes only claude-supported fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-bridge-mode-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const bridge = createClaudeCodeCliBridge({ host: "claude-code" });

    const result = await bridge.handleCommand({ args: "mode conservative" });
    assert.equal(result.text, "✅ Runtime mode = conservative");

    const reloaded = await loadTokenPilotClaudeCodeConfig(defaultTokenPilotClaudeCodeConfigPath());
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.modules.stabilizer, true);
    assert.equal(reloaded.modules.reduction, true);
    assert.equal(reloaded.reduction.triggerMinChars, 4000);
    assert.equal(reloaded.reduction.maxToolChars, 1800);

    const record = reloaded as unknown as Record<string, unknown>;
    assert.equal("taskStateEstimator" in record, false);
    assert.equal("eviction" in record, false);
    const modules = record.modules as Record<string, unknown>;
    assert.equal("policy" in modules, false);
    assert.equal("eviction" in modules, false);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
