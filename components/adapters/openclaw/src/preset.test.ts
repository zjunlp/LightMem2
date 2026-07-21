import assert from "node:assert/strict";
import test from "node:test";
import { OPENCLAW_TOKENPILOT_HOST_BINDING } from "./preset.js";

test("OpenClaw binds the complete TokenPilot preset", () => {
  assert.equal(OPENCLAW_TOKENPILOT_HOST_BINDING.presetId, "tokenpilot");
  assert.deepEqual(
    OPENCLAW_TOKENPILOT_HOST_BINDING.supportedFeatures,
    ["stabilizer", "reduction", "eviction"],
  );
});
