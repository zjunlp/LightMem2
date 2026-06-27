import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
