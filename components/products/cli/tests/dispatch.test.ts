import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexCodexHostSessionAlias } from "../../../adapters/codex/src/session-state.js";
import { readCliContextState } from "../src/context-store.js";
import { dispatchCli } from "../src/dispatch.js";

test("dispatch supports context inspection and use host flow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-dispatch-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const context0 = await dispatchCli(["context"]);
    assert.match(context0.text, /lastActiveHost: \(unset\)/);

    const useHost = await dispatchCli(["use", "openclaw"]);
    assert.equal(useHost.text, "Default host = openclaw");

    const persisted = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(persisted.lastActiveHost, "openclaw");

    const context1 = await dispatchCli(["context"]);
    assert.match(context1.text, /lastActiveHost: openclaw/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch routes codex host commands through the shared CLI bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-codex-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexHome = join(dir, ".codex");
    await rm(codexHome, { recursive: true, force: true });

    const status = await dispatchCli(["codex", "status"]);
    assert.match(status.text, /TokenPilot Codex status:/);
    assert.doesNotMatch(status.text, /lifecycle eviction/i);

    const useHost = await dispatchCli(["use", "codex"]);
    assert.equal(useHost.text, "Default host = codex");

    const reduction = await dispatchCli(["codex", "reduction", "off"]);
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const unsupported = await dispatchCli(["codex", "settings", "details", "on"]);
    assert.equal(unsupported.text, "Codex does not expose shared runtime settings yet.");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch remembers custom codex config paths for later host commands without env vars", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-codex-custom-path-memory-"));
  const originalHome = process.env.HOME;
  const originalCodexConfigPath = process.env.CODEX_CONFIG_PATH;
  const originalHooksConfigPath = process.env.CODEX_HOOKS_CONFIG_PATH;
  const originalTokenPilotConfigPath = process.env.TOKENPILOT_CODEX_CONFIG;
  process.env.HOME = join(dir, "real-home");
  process.env.CODEX_CONFIG_PATH = join(dir, "isolated", "config.toml");
  process.env.CODEX_HOOKS_CONFIG_PATH = join(dir, "isolated", "hooks.json");
  process.env.TOKENPILOT_CODEX_CONFIG = join(dir, "isolated", "tokenpilot.json");
  try {
    await mkdir(join(dir, "isolated"), { recursive: true });
    await writeFile(
      process.env.CODEX_CONFIG_PATH!,
      [
        "model_provider = \"OPENAI\"",
        "",
        "[model_providers.OPENAI]",
        "name = \"OPENAI\"",
        "base_url = \"http://127.0.0.1:19999/v1\"",
        "wire_api = \"responses\"",
        "requires_openai_auth = true",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(process.env.CODEX_HOOKS_CONFIG_PATH!, JSON.stringify({ hooks: {} }, null, 2), "utf8");

    const first = await dispatchCli(["codex", "doctor"]);
    assert.match(first.text, new RegExp(process.env.CODEX_CONFIG_PATH!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    delete process.env.CODEX_CONFIG_PATH;
    delete process.env.CODEX_HOOKS_CONFIG_PATH;
    delete process.env.TOKENPILOT_CODEX_CONFIG;

    const second = await dispatchCli(["codex", "doctor"]);
    assert.match(second.text, new RegExp(join(dir, "isolated", "config.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(second.text, new RegExp(join(dir, "isolated", "tokenpilot.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(second.text, new RegExp(join(dir, "isolated", "hooks.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCodexConfigPath === undefined) delete process.env.CODEX_CONFIG_PATH;
    else process.env.CODEX_CONFIG_PATH = originalCodexConfigPath;
    if (originalHooksConfigPath === undefined) delete process.env.CODEX_HOOKS_CONFIG_PATH;
    else process.env.CODEX_HOOKS_CONFIG_PATH = originalHooksConfigPath;
    if (originalTokenPilotConfigPath === undefined) delete process.env.TOKENPILOT_CODEX_CONFIG;
    else process.env.TOKENPILOT_CODEX_CONFIG = originalTokenPilotConfigPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch routes claude-code host commands through the shared CLI bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-claude-code-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const status = await dispatchCli(["claude-code", "status"]);
    assert.match(status.text, /TokenPilot Claude Code status:/);
    assert.doesNotMatch(status.text, /lifecycle eviction/i);

    const useHost = await dispatchCli(["use", "claude-code"]);
    assert.equal(useHost.text, "Default host = claude-code");

    const reduction = await dispatchCli(["claude-code", "reduction", "off"]);
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const unsupported = await dispatchCli(["claude-code", "settings", "details", "on"]);
    assert.equal(unsupported.text, "Claude Code does not expose shared runtime settings yet.");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch remembers custom claude-code config paths for later host commands without env vars", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-claude-custom-path-memory-"));
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
    await writeFile(process.env.CLAUDE_CODE_SETTINGS_PATH!, JSON.stringify({ env: {}, hooks: {} }, null, 2), "utf8");
    await writeFile(process.env.CLAUDE_CODE_MCP_CONFIG_PATH!, JSON.stringify({ mcpServers: {} }, null, 2), "utf8");

    const first = await dispatchCli(["claude-code", "doctor"]);
    assert.match(first.text, new RegExp(process.env.CLAUDE_CODE_SETTINGS_PATH!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    delete process.env.CLAUDE_CODE_SETTINGS_PATH;
    delete process.env.CLAUDE_CODE_MCP_CONFIG_PATH;
    delete process.env.TOKENPILOT_CLAUDE_CODE_CONFIG;

    const second = await dispatchCli(["claude-code", "doctor"]);
    assert.match(second.text, new RegExp(join(dir, "isolated", "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(second.text, new RegExp(join(dir, "isolated", ".claude.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(second.text, new RegExp(join(dir, "isolated", "tokenpilot.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("dispatch uses the default host and latest resolved codex session for hostless report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-codex-default-report-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const stateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(stateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "codex-session-1",
        model: "gpt-5.4-mini",
        countMode: "chars",
        beforeCount: 1200,
        afterCount: 400,
        savedCount: 800,
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(stateDir, "ux-effects", "sessions", "codex-session-1.json"),
      JSON.stringify({
        sessionId: "codex-session-1",
        turns: 3,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 1600,
        avgSavedCharsPerOptimizedTurn: 800,
        latestAt: "2026-06-28T12:20:00.000Z",
      }, null, 2),
      "utf8",
    );

    const useHost = await dispatchCli(["use", "codex"]);
    assert.equal(useHost.text, "Default host = codex");

    const report = await dispatchCli(["report"]);
    assert.match(report.text, /TokenPilot report:/);
    assert.match(report.text, /session: codex-session-1/);

    const persisted = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(persisted.lastActiveHost, "codex");
    assert.equal(persisted.lastSessionByHost?.codex, "codex-session-1");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch hostless report prefers the host with the latest stats over lastActiveHost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-report-latest-host-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexStateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    const claudeStateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");
    await mkdir(join(codexStateDir, "ux-effects", "sessions"), { recursive: true });
    await mkdir(join(claudeStateDir, "ux-effects", "sessions"), { recursive: true });

    await writeFile(
      join(codexStateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-29T12:20:00.000Z",
        sessionId: "codex-session-latest",
        model: "gpt-5.4",
        countMode: "openai_tokens",
        beforeCount: 5000,
        afterCount: 2500,
        savedCount: 2500,
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(codexStateDir, "ux-effects", "sessions", "codex-session-latest.json"),
      JSON.stringify({
        sessionId: "codex-session-latest",
        turns: 10,
        latestCountMode: "openai_tokens",
        tokenOptimizedTurns: 4,
        tokenSavedCount: 2500,
        avgSavedTokensPerOptimizedTurn: 625,
        charOptimizedTurns: 0,
        charSavedCount: 0,
        avgSavedCharsPerOptimizedTurn: 0,
        latestAt: "2026-06-29T12:20:00.000Z",
      }, null, 2),
      "utf8",
    );

    await writeFile(
      join(claudeStateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "claude-session-older",
        model: "claude-sonnet-4-6",
        countMode: "chars",
        beforeCount: 1000,
        afterCount: 500,
        savedCount: 500,
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(claudeStateDir, "ux-effects", "sessions", "claude-session-older.json"),
      JSON.stringify({
        sessionId: "claude-session-older",
        turns: 3,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 1000,
        avgSavedCharsPerOptimizedTurn: 500,
        latestAt: "2026-06-28T12:20:00.000Z",
      }, null, 2),
      "utf8",
    );

    const useHost = await dispatchCli(["use", "claude-code"]);
    assert.equal(useHost.text, "Default host = claude-code");

    const report = await dispatchCli(["report"]);
    assert.match(report.text, /Showing latest TokenPilot report from Codex/);
    assert.match(report.text, /session: codex-session-latest/);

    const persisted = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(persisted.lastActiveHost, "codex");
    assert.equal(persisted.lastSessionByHost?.codex, "codex-session-latest");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch explicit host report does not fallback to another host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-report-explicit-host-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexStateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    await mkdir(join(codexStateDir, "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(codexStateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-29T12:20:00.000Z",
        sessionId: "codex-session-latest",
        model: "gpt-5.4",
        countMode: "openai_tokens",
        beforeCount: 5000,
        afterCount: 2500,
        savedCount: 2500,
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(codexStateDir, "ux-effects", "sessions", "codex-session-latest.json"),
      JSON.stringify({
        sessionId: "codex-session-latest",
        turns: 10,
        latestCountMode: "openai_tokens",
        tokenOptimizedTurns: 4,
        tokenSavedCount: 2500,
        avgSavedTokensPerOptimizedTurn: 625,
        charOptimizedTurns: 0,
        charSavedCount: 0,
        avgSavedCharsPerOptimizedTurn: 0,
        latestAt: "2026-06-29T12:20:00.000Z",
      }, null, 2),
      "utf8",
    );

    const report = await dispatchCli(["claude-code", "report"]);
    assert.equal(report.text, "No TokenPilot session stats yet.");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch canonicalizes pinned codex host session ids before persisting CLI context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-codex-canonical-context-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const stateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "session-state"), { recursive: true });
    await indexCodexHostSessionAlias(stateDir, "codex-host-session-1", "codex-synth-session-1");

    const useContext = await dispatchCli(["use", "codex", "session", "codex-host-session-1"]);
    assert.equal(useContext.text, "Default context = codex / codex-synth-session-1");

    const persisted = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(persisted.lastActiveHost, "codex");
    assert.equal(persisted.lastSessionByHost?.codex, "codex-synth-session-1");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch uses the pinned default claude-code session for hostless visual", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-claude-default-visual-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const stateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "session-state", "sessions"), { recursive: true });
    await mkdir(join(stateDir, "session-state", "bindings"), { recursive: true });
    await writeFile(
      join(stateDir, "session-state", "sessions", "claude-session-pinned.json"),
      JSON.stringify({
        sessionId: "claude-session-pinned",
        latestResponseId: "msg-9",
        previousResponseId: "msg-8",
        latestModel: "claude-sonnet-4-6",
        workspaceHint: "/repo/pinned",
        requestChars: 900,
        responseChars: 420,
        assistantChars: 200,
        reductionSavedChars: 500,
        updatedAt: "2026-06-28T12:20:00.000Z",
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(stateDir, "session-state", "bindings", "claude-session-pinned.jsonl"),
      `${JSON.stringify({
        sessionId: "claude-session-pinned",
        responseId: "msg-9",
        previousResponseId: "msg-8",
        model: "claude-sonnet-4-6",
        requestChars: 900,
        responseChars: 420,
        assistantChars: 200,
        reductionSavedChars: 500,
        stream: false,
        updatedAt: "2026-06-28T12:20:00.000Z",
      })}\n`,
      "utf8",
    );

    const useContext = await dispatchCli(["use", "claude-code", "session", "claude-session-pinned"]);
    assert.equal(useContext.text, "Default context = claude-code / claude-session-pinned");

    const visual = await dispatchCli(["visual"]);
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=claude-code/);
    assert.match(visual.text, /session=claude-session-pinned/);
    assert.match(visual.text, /Claude Code: 0 session snapshots/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatch keeps top-level visual multi-host even when a default host is selected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-default-host-visual-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const openclawStateDir = join(dir, ".openclaw", "tokenpilot-state", "tokenpilot");
    const openclawPluginStateDir = join(openclawStateDir, "tokenpilot");
    const codexStateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    const claudeStateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");

    await mkdir(join(openclawPluginStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(codexStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(claudeStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(dir, ".codex"), { recursive: true });
    await mkdir(join(dir, ".claude"), { recursive: true });

    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      `${JSON.stringify({
        plugins: {
          entries: {
            tokenpilot: {
              enabled: true,
              config: {
                stateDir: openclawStateDir,
              },
            },
          },
          slots: {
            contextEngine: "layered-context",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".codex", "tokenpilot.json"),
      `${JSON.stringify({
        enabled: true,
        stateDir: codexStateDir,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".claude", "tokenpilot.json"),
      `${JSON.stringify({
        enabled: true,
        stateDir: claudeStateDir,
        upstreamBaseUrl: "https://api.anthropic.com/v1/messages",
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(openclawPluginStateDir, "visual", "reduction", "openclaw-session-1.jsonl"),
      `${JSON.stringify({
        kind: "reduction",
        at: "2026-06-29T10:00:00.000Z",
        sessionId: "openclaw-session-1",
        requestId: "req-1",
        model: "gpt-5.4-mini",
        upstreamModel: "gpt-5.4-mini",
        segmentId: "seg-1",
        itemIndex: 0,
        field: "content",
        savedChars: 120,
        beforeText: "before",
        afterText: "after",
        report: [],
      })}\n`,
      "utf8",
    );

    const useHost = await dispatchCli(["use", "openclaw", "session", "openclaw-session-1"]);
    assert.equal(useHost.text, "Default context = openclaw / openclaw-session-1");

    const visual = await dispatchCli(["visual"]);
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=openclaw/);
    assert.match(visual.text, /session=openclaw-session-1/);
    assert.match(visual.text, /OpenClaw: 1 session snapshots/);
    assert.match(visual.text, /Codex: 0 session snapshots/);
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

test("dispatch uses the default openclaw host and latest session for hostless report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-openclaw-default-report-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const stateDir = join(dir, ".openclaw", "tokenpilot-state", "tokenpilot");
    const pluginStateDir = join(stateDir, "tokenpilot");
    await mkdir(join(pluginStateDir, "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      `${JSON.stringify({
        plugins: {
          entries: {
            tokenpilot: {
              enabled: true,
              config: {
                stateDir,
              },
            },
          },
          slots: {
            contextEngine: "layered-context",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(pluginStateDir, "ux-effects", "sessions", "openclaw-session-1.json"),
      JSON.stringify({
        sessionId: "openclaw-session-1",
        turns: 3,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 1600,
        avgSavedCharsPerOptimizedTurn: 800,
        latestAt: "2026-06-28T12:20:00.000Z",
      }, null, 2),
      "utf8",
    );

    const useHost = await dispatchCli(["use", "openclaw", "session", "openclaw-session-1"]);
    assert.equal(useHost.text, "Default context = openclaw / openclaw-session-1");

    const report = await dispatchCli(["report"]);
    assert.match(report.text, /TokenPilot report:/);
    assert.match(report.text, /session: openclaw-session-1/);

    const persisted = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(persisted.lastActiveHost, "openclaw");
    assert.equal(persisted.lastSessionByHost?.openclaw, "openclaw-session-1");
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

test("dispatch exposes standalone lightmem2 visual when no default host is selected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-standalone-visual-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const openclawStateDir = join(dir, ".openclaw", "tokenpilot-state", "tokenpilot");
    const openclawPluginStateDir = join(openclawStateDir, "tokenpilot");
    const codexStateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    const claudeStateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");

    await mkdir(join(openclawPluginStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(codexStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(claudeStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(dir, ".codex"), { recursive: true });
    await mkdir(join(dir, ".claude"), { recursive: true });

    await writeFile(
      process.env.OPENCLAW_CONFIG_PATH!,
      `${JSON.stringify({
        plugins: {
          entries: {
            tokenpilot: {
              enabled: true,
              config: {
                stateDir: openclawStateDir,
              },
            },
          },
          slots: {
            contextEngine: "layered-context",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".codex", "tokenpilot.json"),
      `${JSON.stringify({
        enabled: true,
        stateDir: codexStateDir,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, ".claude", "tokenpilot.json"),
      `${JSON.stringify({
        enabled: true,
        stateDir: claudeStateDir,
        upstreamBaseUrl: "https://api.anthropic.com/v1/messages",
      }, null, 2)}\n`,
      "utf8",
    );

    await writeFile(
      join(openclawPluginStateDir, "visual", "reduction", "openclaw-session-1.jsonl"),
      `${JSON.stringify({
        kind: "reduction",
        at: "2026-06-29T10:00:00.000Z",
        sessionId: "openclaw-session-1",
        requestId: "req-1",
        model: "gpt-5.4-mini",
        upstreamModel: "gpt-5.4-mini",
        segmentId: "seg-1",
        itemIndex: 0,
        field: "content",
        savedChars: 120,
        beforeText: "before",
        afterText: "after",
        report: [],
      })}\n`,
      "utf8",
    );

    const visual = await dispatchCli(["visual"]);
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /OpenClaw: 1 session snapshots/);
    assert.match(visual.text, /Codex: 0 session snapshots/);
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
