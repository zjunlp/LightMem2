import assert from "node:assert/strict";
import test from "node:test";
import { TOKENPILOT_RECOVERY_MCP_PRODUCT } from "../src/product-registration.js";

test("recovery MCP declares its TokenPilot preset ownership", () => {
  assert.deepEqual(TOKENPILOT_RECOVERY_MCP_PRODUCT, {
    productId: "tokenpilot-memory-fault-recover",
    displayName: "TokenPilot Memory Fault Recovery MCP",
    kind: "mcp",
    preset: { presetId: "tokenpilot", presetVersion: "1" },
  });
});
