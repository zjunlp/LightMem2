import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_TOKENPILOT_HOST_BINDING } from "../src/preset.js";

test("Codex binds only the TokenPilot features its runtime supports", () => {
  assert.equal(CODEX_TOKENPILOT_HOST_BINDING.presetId, "tokenpilot");
  assert.deepEqual(CODEX_TOKENPILOT_HOST_BINDING.supportedFeatures, ["stabilizer", "reduction"]);
});
