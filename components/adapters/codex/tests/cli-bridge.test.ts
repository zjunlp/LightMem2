import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createCodexCliBridge } from "../../../products/cli/src/hosts/codex.js";
import { loadTokenPilotCodexConfig, defaultTokenPilotConfigPath } from "../src/config.js";
import { indexCodexHostSessionAlias } from "../src/session-state.js";

test("codex cli bridge exposes only the supported Codex command surface", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-"));
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
    const { handleCommand } = createCodexCliBridge({ host: "codex" });

    const status = await handleCommand({ args: "status" });
    assert.match(status.text, /TokenPilot Codex status:/);
    assert.doesNotMatch(status.text, /lifecycle eviction/i);
    assert.doesNotMatch(status.text, /task-state estimator/i);

    const reduction = await handleCommand({ args: "reduction off" });
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const reductionStatus = await handleCommand({ args: "reduction status" });
    assert.match(reductionStatus.text, /Observation Reduction \(Codex\):/);
    assert.doesNotMatch(reductionStatus.text, /formatSlimming/);

    const stabilizer = await handleCommand({ args: "stabilizer target user" });
    assert.equal(stabilizer.text, "✅ hooks.dynamicContextTarget = user");

    const doctor = await handleCommand({ args: "doctor" });
    assert.match(doctor.text, /TokenPilot Codex doctor:/);

    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=codex/);

    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "No TokenPilot session stats yet.");

    const unsupportedSettings = await handleCommand({ args: "settings details on" });
    assert.equal(unsupportedSettings.text, "Codex does not expose shared runtime settings yet.");

    const unsupportedEviction = await handleCommand({ args: "eviction on" });
    assert.equal(unsupportedEviction.text, "Codex lifecycle eviction controls are not supported.");

    const aggressiveMode = await handleCommand({ args: "mode aggressive" });
    assert.equal(aggressiveMode.text, "Codex does not support lifecycle eviction mode. Use `mode normal` or `mode conservative`.");

    const unsupportedHook = await handleCommand({ args: "stabilizer hook on" });
    assert.equal(unsupportedHook.text, "Codex currently supports only `stabilizer on|off` and `stabilizer target <developer|user>`.");

    const unsupportedReductionPass = await handleCommand({ args: "reduction pass formatSlimming on" });
    assert.equal(unsupportedReductionPass.text, "Codex reduction supports only these passes: readStateCompaction, toolPayloadTrim, htmlSlimming, execOutputTruncation, agentsStartupOptimization");
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

test("codex cli bridge follows custom config env paths instead of the default home paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-custom-paths-"));
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

    const bridge = createCodexCliBridge({ host: "codex" });
    const status = await bridge.handleCommand({ args: "status" });
    assert.match(status.text, /proxyPort: 17667/);

    const doctor = await bridge.handleCommand({ args: "doctor" });
    assert.match(doctor.text, new RegExp(process.env.TOKENPILOT_CODEX_CONFIG!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(doctor.text, new RegExp(process.env.CODEX_CONFIG_PATH!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(doctor.text, new RegExp(process.env.CODEX_HOOKS_CONFIG_PATH!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const reloaded = await loadTokenPilotCodexConfig(process.env.TOKENPILOT_CODEX_CONFIG!);
    assert.equal(reloaded.stateDir, join(dir, "isolated", "tokenpilot-state", "tokenpilot"));
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

test("codex cli bridge visual opens the shared browser visual pinned to the codex session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-visual-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const stateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    const claudeStateDir = join(dir, ".claude", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(claudeStateDir, "visual", "reduction"), { recursive: true });
    await mkdir(join(stateDir, "session-state", "sessions"), { recursive: true });
    await mkdir(join(stateDir, "session-state", "bindings"), { recursive: true });
    await mkdir(join(dir, ".openclaw"), { recursive: true });
    await mkdir(join(dir, ".claude"), { recursive: true });
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
        latestResponseId: "resp-3",
        previousResponseId: "resp-2",
        latestModel: "gpt-5.4-mini",
        workspaceHint: "/repo/demo",
        lastHookEvent: "PostToolUse",
        lastToolName: "read",
        lastToolInputChars: 64,
        lastToolOutputChars: 512,
        updatedAt: "2026-06-26T10:00:00.000Z",
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(stateDir, "session-state", "bindings", "session-1.jsonl"),
      [
        JSON.stringify({
          sessionId: "session-1",
          responseId: "resp-2",
          previousResponseId: "resp-1",
          model: "gpt-5.4-mini",
          requestChars: 1000,
          responseChars: 500,
          assistantChars: 210,
          toolCallCount: 1,
          stream: false,
          updatedAt: "2026-06-26T09:59:00.000Z",
        }),
        JSON.stringify({
          sessionId: "session-1",
          responseId: "resp-3",
          previousResponseId: "resp-2",
          model: "gpt-5.4-mini",
          requestChars: 1200,
          responseChars: 720,
          assistantChars: 330,
          toolCallCount: 2,
          stream: true,
          updatedAt: "2026-06-26T10:00:00.000Z",
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const { handleCommand } = createCodexCliBridge({ host: "codex" });
    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=codex/);
    assert.match(visual.text, /session=session-1/);
    assert.match(visual.text, /Codex: 0 session snapshots/);
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

test("codex cli bridge report explains when a session has no recorded savings yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-report-empty-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const stateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "ux-effects"), { recursive: true });
    await writeFile(
      join(stateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-28T10:00:00.000Z",
        sessionId: "session-empty",
        model: "gpt-5.4-mini",
        countMode: "chars",
        beforeCount: 100,
        afterCount: 100,
        savedCount: 0,
      }, null, 2),
      "utf8",
    );

    const { handleCommand } = createCodexCliBridge({ host: "codex" });
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

test("codex cli bridge accepts a real codex session id and resolves it to the synthesized session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-real-session-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const stateDir = join(dir, ".codex", "tokenpilot-state", "tokenpilot");
    await mkdir(join(stateDir, "ux-effects", "sessions"), { recursive: true });
    await indexCodexHostSessionAlias(stateDir, "019f-real-codex-session", "codex-synth-a");
    await writeFile(
      join(stateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-28T10:00:00.000Z",
        sessionId: "codex-synth-a",
        model: "gpt-5.4-mini",
        countMode: "chars",
        beforeCount: 1000,
        afterCount: 700,
        savedCount: 300,
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(stateDir, "ux-effects", "sessions", "codex-synth-a.json"),
      JSON.stringify({
        sessionId: "codex-synth-a",
        turns: 2,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 1,
        charSavedCount: 300,
        avgSavedCharsPerOptimizedTurn: 300,
        latestAt: "2026-06-28T10:00:00.000Z",
      }, null, 2),
      "utf8",
    );

    const { handleCommand } = createCodexCliBridge({
      host: "codex",
      sessionId: "019f-real-codex-session",
    });
    const report = await handleCommand({ args: "report" });
    assert.match(report.text, /session: codex-synth-a/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("codex cli bridge persists only supported settings across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-persist-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const bridge = createCodexCliBridge({ host: "codex" });

    const reduction = await bridge.handleCommand({ args: "reduction off" });
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const target = await bridge.handleCommand({ args: "stabilizer target user" });
    assert.equal(target.text, "✅ hooks.dynamicContextTarget = user");

    const unsupported = await bridge.handleCommand({ args: "settings details on" });
    assert.equal(unsupported.text, "Codex does not expose shared runtime settings yet.");

    const reloaded = await loadTokenPilotCodexConfig(defaultTokenPilotConfigPath());
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

test("codex mode writes only codex-supported fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-mode-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const bridge = createCodexCliBridge({ host: "codex" });

    const result = await bridge.handleCommand({ args: "mode conservative" });
    assert.equal(result.text, "✅ Runtime mode = conservative");

    const reloaded = await loadTokenPilotCodexConfig(defaultTokenPilotConfigPath());
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

test("codex config normalization strips unsupported reduction pass options", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-bridge-sanitize-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const bridge = createCodexCliBridge({ host: "codex" });
    const current = await loadTokenPilotCodexConfig(defaultTokenPilotConfigPath());
    await bridge.bridge.writeConfig({
      ...current,
      reduction: {
        ...current.reduction,
        passOptions: {
          ...current.reduction.passOptions,
          formatSlimming: { enabled: true },
          pathTruncation: { enabled: true },
          htmlSlimming: { preserveTables: true },
        },
      },
    });

    const reloaded = await loadTokenPilotCodexConfig(defaultTokenPilotConfigPath());
    assert.equal("formatSlimming" in reloaded.reduction.passOptions, false);
    assert.equal("pathTruncation" in reloaded.reduction.passOptions, false);
    assert.deepEqual(reloaded.reduction.passOptions.htmlSlimming, { preserveTables: true });
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
