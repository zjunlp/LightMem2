import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeModuleRegistry } from "@lightmem2/runtime-core";
import {
  TOKENPILOT_FEATURE_MODULE_IDS,
  TOKENPILOT_HISTORY_MODULE_ORDER,
  TOKENPILOT_MODULE_COMBINATIONS,
  TOKENPILOT_PRESET_ID,
  TOKENPILOT_PRESET_VERSION,
  TOKENPILOT_REQUEST_MODULE_ORDER,
  buildTokenPilotCombinationConfig,
  createTokenPilotHostBinding,
} from "../src/index.js";

test("TokenPilot preset freezes identity, feature membership, and execution order", () => {
  assert.equal(TOKENPILOT_PRESET_ID, "tokenpilot");
  assert.equal(TOKENPILOT_PRESET_VERSION, "1");
  assert.deepEqual(TOKENPILOT_FEATURE_MODULE_IDS, ["stabilizer", "reduction", "eviction"]);
  assert.deepEqual(TOKENPILOT_REQUEST_MODULE_ORDER, [
    "stabilizer",
    "memory-injection",
    "stabilizer-trace",
    "reduction-snapshot",
    "lifecycle-planning",
    "reduction",
  ]);
  assert.deepEqual(TOKENPILOT_HISTORY_MODULE_ORDER, [
    "canonical-sync",
    "eviction",
    "memory-consumer",
    "canonical-persistence",
  ]);
});

test("TokenPilot preset exposes the complete three-feature combination matrix", () => {
  assert.equal(TOKENPILOT_MODULE_COMBINATIONS.length, 8);
  assert.equal(
    new Set(TOKENPILOT_MODULE_COMBINATIONS.map(({ enablement }) => JSON.stringify(enablement))).size,
    8,
  );
  const evictionOnly = TOKENPILOT_MODULE_COMBINATIONS.find(({ id }) => id === "eviction-only");
  assert.deepEqual(buildTokenPilotCombinationConfig(evictionOnly!.enablement), {
    modules: {
      stabilizer: false,
      policy: true,
      reduction: false,
      eviction: true,
    },
    eviction: { enabled: true },
  });
});

test("shared registry deduplicates eviction across TokenPilot and future writeback presets", () => {
  const registry = new RuntimeModuleRegistry();
  const tokenPilotEviction = { owner: "tokenpilot" };
  const writebackEviction = { owner: "memory-writeback" };

  assert.equal(
    registry.register({ id: "eviction", version: "1", instance: tokenPilotEviction }),
    tokenPilotEviction,
  );
  assert.equal(
    registry.register({ id: "eviction", version: "1", instance: writebackEviction }),
    tokenPilotEviction,
  );
  assert.equal(registry.list().filter(({ id }) => id === "eviction").length, 1);
});

test("TokenPilot host binding declares an explicit supported feature subset", () => {
  assert.deepEqual(
    createTokenPilotHostBinding({
      hostId: "codex",
      supportedFeatures: ["stabilizer", "reduction", "stabilizer"],
    }),
    {
      hostId: "codex",
      presetId: "tokenpilot",
      presetVersion: "1",
      supportedFeatures: ["stabilizer", "reduction"],
    },
  );
  assert.throws(
    () => createTokenPilotHostBinding({ hostId: " ", supportedFeatures: [] }),
    /non-empty hostId/,
  );
});
