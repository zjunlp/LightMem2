import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTokenPilotCodexConfig } from "../src/config.js";

test("normalizeTokenPilotCodexConfig applies stable defaults", () => {
  const config = normalizeTokenPilotCodexConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.logLevel, "info");
  assert.equal(config.proxyPort, 17667);
  assert.equal(config.upstreamProvider, "OpenAI");
  assert.match(config.stateDir, /\.codex\/tokenpilot-state\/tokenpilot$/);
});

test("normalizeTokenPilotCodexConfig derives default stateDir from the tokenpilot config path", () => {
  const config = normalizeTokenPilotCodexConfig({}, {
    configPath: "/tmp/custom-codex-root/tokenpilot.json",
  });
  assert.equal(config.stateDir, "/tmp/custom-codex-root/tokenpilot-state/tokenpilot");
});

test("normalizeTokenPilotCodexConfig trims and clamps values", () => {
  const config = normalizeTokenPilotCodexConfig({
    logLevel: "debug",
    proxyPort: 999999,
    upstreamProvider: "  OPENAI  ",
  });
  assert.equal(config.logLevel, "debug");
  assert.equal(config.proxyPort, 65535);
  assert.equal(config.upstreamProvider, "OPENAI");
});
