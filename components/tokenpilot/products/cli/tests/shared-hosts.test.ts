import assert from "node:assert/strict";
import test from "node:test";
import type { TokenPilotProductSurfaceConfigAdapter } from "@tokenpilot/host-adapter";
import { buildSessionReportResult, resolvePreferredSessionId } from "../src/hosts/shared.js";

const passthroughConfigAdapter: TokenPilotProductSurfaceConfigAdapter = {
  pluginConfigRecord(config) {
    return (config.plugin as Record<string, unknown>) ?? {};
  },
  pluginEntryRecord(config) {
    return config;
  },
  ensurePluginConfig(config) {
    const plugin = (config.plugin as Record<string, unknown> | undefined) ?? {};
    config.plugin = plugin;
    return plugin;
  },
  ensurePluginEntry(config) {
    return config;
  },
  resolveStateDir(config) {
    return typeof config.stateDir === "string" ? config.stateDir : undefined;
  },
};

test("shared host helpers prefer explicit session then latest session then latest ux session", async () => {
  const explicit = await resolvePreferredSessionId({
    explicitSessionId: " session-explicit ",
    stateDir: "/tmp/state",
    async resolveLatestSessionId() {
      return "session-latest";
    },
    async readLatestUxEffect() {
      return { sessionId: "session-ux" };
    },
  });
  const latestSession = await resolvePreferredSessionId({
    stateDir: "/tmp/state",
    async resolveLatestSessionId() {
      return "session-latest";
    },
    async readLatestUxEffect() {
      return { sessionId: "session-ux" };
    },
  });
  const latestUx = await resolvePreferredSessionId({
    stateDir: "/tmp/state",
    async resolveLatestSessionId() {
      return undefined;
    },
    async readLatestUxEffect() {
      return { sessionId: "session-ux" };
    },
  });

  assert.equal(explicit, "session-explicit");
  assert.equal(latestSession, "session-latest");
  assert.equal(latestUx, "session-ux");
});

test("shared host helpers return shared report fallback messages and report text", async () => {
  const noStateDir = await buildSessionReportResult({
    currentConfig: {},
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return undefined;
    },
    async readLatestUxEffect() {
      return null;
    },
    async readSessionAggregate() {
      return null;
    },
  });

  const noStats = await buildSessionReportResult({
    currentConfig: { stateDir: "/tmp/state" },
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return undefined;
    },
    async readLatestUxEffect() {
      return null;
    },
    async readSessionAggregate() {
      return null;
    },
  });

  const noAggregate = await buildSessionReportResult({
    currentConfig: { stateDir: "/tmp/state" },
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return "session-latest";
    },
    async readLatestUxEffect() {
      return {
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "session-ux",
        model: "test-model",
        countMode: "chars",
        beforeCount: 1000,
        afterCount: 900,
        savedCount: 100,
      };
    },
    async readSessionAggregate(_stateDir, sessionId) {
      assert.equal(sessionId, "session-ux");
      return null;
    },
  });

  const report = await buildSessionReportResult({
    currentConfig: {
      stateDir: "/tmp/state",
      plugin: {
        ux: {
          details: true,
        },
      },
    },
    configAdapter: passthroughConfigAdapter,
    async resolveLatestSessionId() {
      return "session-a";
    },
    async readLatestUxEffect() {
      return {
        at: "2026-06-28T12:20:00.000Z",
        sessionId: "session-a",
        model: "test-model",
        countMode: "chars",
        beforeCount: 1000,
        afterCount: 600,
        savedCount: 400,
      };
    },
    async readSessionAggregate() {
      return {
        turns: 2,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 800,
        avgSavedCharsPerOptimizedTurn: 400,
      };
    },
  });

  assert.equal(noStateDir.text, "TokenPilot stateDir is not configured.");
  assert.equal(noStats.text, "No TokenPilot session stats yet.");
  assert.equal(noAggregate.text, "No TokenPilot savings recorded yet for session session-ux.");
  assert.match(report.text, /session: session-a/);
  assert.match(report.text, /saved chars: 800/);
});
