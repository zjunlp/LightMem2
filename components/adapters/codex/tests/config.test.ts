import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { normalizeTokenPilotCodexConfig } from "../src/config.js";

test("normalizeTokenPilotCodexConfig applies stable defaults", () => {
  const config = normalizeTokenPilotCodexConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.logLevel, "info");
  assert.equal(config.proxyPort, 17667);
  assert.equal(config.upstreamProvider, "OpenAI");
  assert.match(config.stateDir.replace(/\\/g, "/"), /\.codex\/tokenpilot-state\/tokenpilot$/);
  assert.equal(config.contextRewrite.enabled, false);
  assert.equal(config.contextRewrite.mode, "response_chain_rebase");
  assert.equal(config.contextRewrite.failureMode, "bypass");
  assert.equal(config.contextRewrite.retryOriginalRequest, true);
  assert.equal(config.contextRewrite.cooldownMs, 300_000);
});

test("normalizeTokenPilotCodexConfig derives default stateDir from the tokenpilot config path", () => {
  const config = normalizeTokenPilotCodexConfig({}, {
    configPath: "/tmp/custom-codex-root/tokenpilot.json",
  });
  assert.equal(config.stateDir, join("/tmp/custom-codex-root", "tokenpilot-state", "tokenpilot"));
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

test("normalizeTokenPilotCodexConfig preserves context rewrite plan revisions", () => {
  const config = normalizeTokenPilotCodexConfig({
    contextRewrite: {
      providerCompatibilityProbe: "mock_fixture",
      mutationPlan: {
        baseRevision: "rev-base",
        operations: [{ type: "evict", stableItemId: "item-1" }],
      },
    },
  });

  assert.equal(config.contextRewrite.mutationPlan?.baseRevision, "rev-base");
  assert.equal(config.contextRewrite.providerCompatibilityProbe, "mock_fixture");
  assert.deepEqual(config.contextRewrite.mutationPlan?.operations, [
    { type: "evict", stableItemId: "item-1" },
  ]);
});

test("normalizeTokenPilotCodexConfig enables real-provider compatibility learning by default", () => {
  assert.equal(
    normalizeTokenPilotCodexConfig({}).contextRewrite.providerCompatibilityProbe,
    "real_provider",
  );
});
