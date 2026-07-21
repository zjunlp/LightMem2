import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";

test("normalizeTokenPilotClaudeCodeConfig applies stable defaults", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.logLevel, "info");
  assert.equal(config.proxyPort, 17668);
  assert.equal(config.upstreamBaseUrl, "https://api.anthropic.com/v1/messages");
  assert.match(config.stateDir, /\.claude\/tokenpilot-state\/tokenpilot$/);
});

test("normalizeTokenPilotClaudeCodeConfig derives default stateDir from the tokenpilot config path", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({}, {
    configPath: "/tmp/custom-claude-root/tokenpilot.json",
  });
  assert.equal(config.stateDir, "/tmp/custom-claude-root/tokenpilot-state/tokenpilot");
});

test("normalizeTokenPilotClaudeCodeConfig trims and clamps values", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({
    logLevel: "debug",
    proxyPort: 999999,
    upstreamBaseUrl: "https://example.com/v1/messages///",
  });
  assert.equal(config.logLevel, "debug");
  assert.equal(config.proxyPort, 65535);
  assert.equal(config.upstreamBaseUrl, "https://example.com/v1/messages");
});

test("normalizeTokenPilotClaudeCodeConfig enables stabilizer and reduction defaults", () => {
  const config = normalizeTokenPilotClaudeCodeConfig({});
  assert.equal(config.modules.stabilizer, true);
  assert.equal(config.modules.reduction, true);
  assert.equal(config.reduction.triggerMinChars, 2200);
  assert.equal(config.reduction.maxToolChars, 1200);
  assert.equal(config.reduction.passes.readStateCompaction, true);
  assert.equal(config.reduction.passes.toolPayloadTrim, true);
  assert.equal(config.reduction.passes.htmlSlimming, true);
  assert.equal(config.reduction.passes.execOutputTruncation, true);
  assert.equal(config.reduction.passes.agentsStartupOptimization, true);
});
