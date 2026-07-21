import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProductSurfaceCommandHandler } from "@lightmem2/product-surface";
import { createOpenClawCliBridge } from "../src/hosts/openclaw.js";

test("openclaw CLI bridge reports empty-state and supported shared commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-openclaw-cli-bridge-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const bridge = createOpenClawCliBridge({ host: "openclaw" });
    const handleCommand = createProductSurfaceCommandHandler({
      bridge: bridge.bridge,
      configAdapter: bridge.configAdapter,
    });

    const status = await handleCommand({ args: "status" });
    assert.match(status.text, /TokenPilot status:/);

    const reduction = await handleCommand({ args: "reduction off" });
    assert.equal(reduction.text, "✅ Observation Reduction disabled");

    const settings = await handleCommand({ args: "settings details on" });
    assert.equal(settings.text, "✅ ux.details = true");

    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "TokenPilot stateDir is not configured.");

    const doctor = await handleCommand({ args: "doctor" });
    assert.match(doctor.text, /TokenPilot OpenClaw doctor:/);
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

test("openclaw CLI bridge resolves explicit session stats and missing aggregate fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-openclaw-cli-report-"));
  const originalHome = process.env.HOME;
  const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.HOME = dir;
  process.env.OPENCLAW_CONFIG_PATH = join(dir, ".openclaw", "openclaw.json");
  try {
    const stateDir = join(dir, ".openclaw", "tokenpilot-state", "tokenpilot");
    const pluginStateDir = join(stateDir, "tokenpilot");
    await mkdir(join(dir, ".openclaw"), { recursive: true });
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

    const bridge = createOpenClawCliBridge({ host: "openclaw", sessionId: "openclaw-session-1" });
    const handleCommand = createProductSurfaceCommandHandler({
      bridge: bridge.bridge,
      configAdapter: bridge.configAdapter,
    });

    await writeFile(
      join(pluginStateDir, "ux-effects", "latest.json"),
      JSON.stringify({
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "openclaw-session-1",
        model: "gpt-5.4-mini",
        countMode: "chars",
        beforeCount: 1200,
        afterCount: 400,
        savedCount: 800,
      }, null, 2),
      "utf8",
    );

    const noAggregate = await handleCommand({ args: "report", sessionId: "openclaw-session-1" });
    assert.equal(noAggregate.text, "No TokenPilot savings recorded yet for session openclaw-session-1.");

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

    const report = await handleCommand({ args: "report", sessionId: "openclaw-session-1" });
    assert.match(report.text, /TokenPilot report:/);
    assert.match(report.text, /session: openclaw-session-1/);
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
