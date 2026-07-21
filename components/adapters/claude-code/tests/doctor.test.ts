import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLAUDE_TOOL_SEARCH_DEFAULT,
  CLAUDE_TOOL_SEARCH_ENV,
  normalizeTokenPilotClaudeCodeConfig,
  proxyBaseUrlForPort,
} from "../src/config.js";
import { formatClaudeCodeDoctorReport, inspectClaudeCodeDoctor } from "../src/doctor.js";

test("inspectClaudeCodeDoctor reports missing settings honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-doctor-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const report = await inspectClaudeCodeDoctor({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir: join(dir, "state"),
        proxyPort: 18777,
      }),
      mcpConfigPath,
      settingsPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.settingsInstalled, false);
    assert.equal(report.hooksInstalled, false);
    assert.equal(report.hooksComplete, false);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, []);
    assert.deepEqual(report.missingHookEvents, [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    assert.equal(report.mcpInstalled, false);
    assert.equal(report.mcpStateDirMatches, false);
    assert.equal(report.mcpCommandMatches, false);
    assert.equal(report.mcpArgsMatch, false);
    assert.equal(report.routedViaGateway, false);
    assert.equal(report.toolSearchEnabled, false);
    assert.equal(report.stateDirExists, false);
    assert.equal(report.sessionStateAvailable, false);
    assert.equal(report.uxEffectsAvailable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectClaudeCodeDoctor detects gateway routing from settings env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-doctor-env-"));
  try {
    const proxyPort = 18778;
    const stateDir = join(dir, "state");
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(settingsPath, `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: proxyBaseUrlForPort(proxyPort),
        [CLAUDE_TOOL_SEARCH_ENV]: CLAUDE_TOOL_SEARCH_DEFAULT,
      },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        Stop: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({
      mcpServers: {
        tokenpilot_memory_fault_recover: {
          command: process.execPath,
          args: ["/tmp/server.js"],
          env: {
            TOKENPILOT_STATE_DIR: stateDir,
          },
          startup_timeout_sec: 90,
        },
      },
    }, null, 2)}\n`, "utf8");
    await mkdir(join(stateDir, "session-state"), { recursive: true });
    await mkdir(join(stateDir, "ux-effects"), { recursive: true });
    await writeFile(join(stateDir, "session-state", "latest.json"), "{\"sessionId\":\"sess-1\"}\n", "utf8");
    await writeFile(join(stateDir, "ux-effects", "latest.json"), "{\"sessionId\":\"sess-1\"}\n", "utf8");

    const report = await inspectClaudeCodeDoctor({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir,
        proxyPort,
      }),
      mcpConfigPath,
      settingsPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.settingsInstalled, true);
    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, true);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    assert.deepEqual(report.missingHookEvents, []);
    assert.equal(report.mcpInstalled, true);
    assert.equal(report.mcpStateDirMatches, true);
    assert.equal(report.mcpCommandMatches, true);
    assert.equal(report.mcpArgsMatch, false);
    assert.equal(report.mcpStartupTimeoutSecMatches, true);
    assert.equal(report.routedViaGateway, true);
    assert.equal(report.toolSearchEnabled, true);
    assert.equal(report.stateDirExists, true);
    assert.equal(report.sessionStateAvailable, true);
    assert.equal(report.uxEffectsAvailable, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectClaudeCodeDoctor reports partial hook installs explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-doctor-partial-hooks-"));
  try {
    const proxyPort = 18779;
    const stateDir = join(dir, "state");
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(settingsPath, `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: proxyBaseUrlForPort(proxyPort),
        [CLAUDE_TOOL_SEARCH_ENV]: CLAUDE_TOOL_SEARCH_DEFAULT,
      },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({
      mcpServers: {
        tokenpilot_memory_fault_recover: {
          command: process.execPath,
          args: ["/tmp/server.js"],
          env: {
            TOKENPILOT_STATE_DIR: stateDir,
          },
          startup_timeout_sec: 90,
        },
      },
    }, null, 2)}\n`, "utf8");

    const report = await inspectClaudeCodeDoctor({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir,
        proxyPort,
      }),
      mcpConfigPath,
      settingsPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, false);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, [
      "SessionStart",
      "PostToolUse",
    ]);
    assert.deepEqual(report.missingHookEvents, [
      "PreToolUse",
      "Stop",
      "SessionEnd",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectClaudeCodeDoctor detects hook command drift explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-doctor-hook-drift-"));
  try {
    const proxyPort = 18780;
    const stateDir = join(dir, "state");
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(settingsPath, `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: proxyBaseUrlForPort(proxyPort),
        [CLAUDE_TOOL_SEARCH_ENV]: CLAUDE_TOOL_SEARCH_DEFAULT,
      },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "node /old/path/hooks-handler.js" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "node /old/path/hooks-handler.js" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "node /old/path/hooks-handler.js" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node /old/path/hooks-handler.js" }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: "node /old/path/hooks-handler.js" }] }],
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({
      mcpServers: {
        tokenpilot_memory_fault_recover: {
          command: process.execPath,
          args: ["/tmp/server.js"],
          env: {
            TOKENPILOT_STATE_DIR: stateDir,
          },
          startup_timeout_sec: 90,
        },
      },
    }, null, 2)}\n`, "utf8");

    const report = await inspectClaudeCodeDoctor({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir,
        proxyPort,
      }),
      mcpConfigPath,
      settingsPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, true);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.equal(report.mcpCommandMatches, true);
    assert.equal(report.mcpArgsMatch, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectClaudeCodeDoctor detects MCP command and args drift explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-doctor-mcp-drift-"));
  try {
    const proxyPort = 18781;
    const stateDir = join(dir, "state");
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(settingsPath, `${JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: proxyBaseUrlForPort(proxyPort),
        [CLAUDE_TOOL_SEARCH_ENV]: CLAUDE_TOOL_SEARCH_DEFAULT,
      },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "node /old/path/hooks-handler.js" }] }],
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({
      mcpServers: {
        tokenpilot_memory_fault_recover: {
          command: "/old/node",
          args: ["/old/server.js"],
          env: {
            TOKENPILOT_STATE_DIR: stateDir,
          },
          startup_timeout_sec: 90,
        },
      },
    }, null, 2)}\n`, "utf8");

    const report = await inspectClaudeCodeDoctor({
      config: normalizeTokenPilotClaudeCodeConfig({
        stateDir,
        proxyPort,
      }),
      mcpConfigPath,
      settingsPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.mcpInstalled, true);
    assert.equal(report.mcpStateDirMatches, true);
    assert.equal(report.mcpCommandMatches, false);
    assert.equal(report.mcpArgsMatch, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatClaudeCodeDoctorReport includes remediation hints for drifted installs", async () => {
  const report = await inspectClaudeCodeDoctor({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(tmpdir(), "lightmem2-claude-doctor-remediation-state"),
      proxyPort: 18782,
    }),
    settingsPath: join(tmpdir(), "lightmem2-missing-settings.json"),
    tokenPilotConfigPath: join(tmpdir(), "lightmem2-missing-tokenpilot.json"),
    mcpConfigPath: join(tmpdir(), "lightmem2-missing-claude.json"),
  });
  const text = formatClaudeCodeDoctorReport(report);
  assert.match(text, /Suggested fixes:/);
  assert.match(text, /install:claude-code/);
});

test("formatClaudeCodeDoctorReport shows degraded mode when core runtime is healthy but MCP recovery drifted", () => {
  const text = formatClaudeCodeDoctorReport({
    settingsPath: "/tmp/settings.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    stateDir: "/tmp/state",
    proxyBaseUrl: "http://127.0.0.1:17667",
    mcpConfigPath: "/tmp/.claude.json",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    settingsInstalled: true,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"],
    missingHookEvents: [],
    routedViaGateway: true,
    toolSearchEnabled: true,
    proxyHealthy: true,
    upstreamBaseUrl: "https://api.anthropic.com",
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: false,
    stateDirExists: true,
    sessionStateAvailable: true,
    uxEffectsAvailable: true,
    coreRuntimeHealthy: true,
    recoveryMcpHealthy: false,
    degradedMode: true,
  });

  assert.match(text, /core runtime healthy: yes/);
  assert.match(text, /recovery MCP healthy: no/);
  assert.match(text, /degraded mode: yes/);
  assert.match(text, /gateway routing and reduction remain available/);
  assert.match(text, /startup_timeout_sec/);
});

test("formatClaudeCodeDoctorReport explains first-run SessionStart remediation when the gateway is unhealthy", () => {
  const text = formatClaudeCodeDoctorReport({
    settingsPath: "/tmp/settings.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    stateDir: "/tmp/state",
    proxyBaseUrl: "http://127.0.0.1:17668",
    mcpConfigPath: "/tmp/.claude.json",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    settingsInstalled: true,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"],
    missingHookEvents: [],
    routedViaGateway: true,
    toolSearchEnabled: true,
    proxyHealthy: false,
    upstreamBaseUrl: "https://api.anthropic.com/v1/messages",
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: true,
    stateDirExists: true,
    sessionStateAvailable: false,
    uxEffectsAvailable: false,
    coreRuntimeHealthy: false,
    recoveryMcpHealthy: true,
    degradedMode: false,
  });
  assert.match(text, /start a new Claude Code session so SessionStart can boot the local TokenPilot gateway/);
  assert.match(text, /tokenpilot-claude-code start/);
});
