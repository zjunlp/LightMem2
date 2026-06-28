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
    assert.match(visual.text, /TokenPilot Claude Code visual:/);
    assert.match(visual.text, /session: claude-session-pinned/);
    assert.match(visual.text, /workspace: \/repo\/pinned/);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
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
