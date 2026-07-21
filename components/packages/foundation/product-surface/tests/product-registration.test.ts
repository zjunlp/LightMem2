import assert from "node:assert/strict";
import test from "node:test";
import {
  ProductHostRegistry,
  defineProductHostRegistration,
} from "../src/product-registration.js";

function host(hostId: string) {
  return defineProductHostRegistration({
    hostId,
    displayName: hostId.toUpperCase(),
    preset: { presetId: "tokenpilot", presetVersion: "1" },
    async resolveStateDir() {
      return `/state/${hostId}`;
    },
    async readLatestActivity() {
      return null;
    },
  });
}

test("ProductHostRegistry resolves only registered host ids", () => {
  const registry = new ProductHostRegistry([host("codex"), host("claude-code")]);
  assert.equal(registry.parseHostId(" codex "), "codex");
  assert.equal(registry.parseHostId("openclaw"), undefined);
  assert.deepEqual(registry.list().map(({ hostId }) => hostId), ["codex", "claude-code"]);
});

test("ProductHostRegistry rejects duplicate host contributions", () => {
  assert.throws(() => new ProductHostRegistry([host("codex"), host("codex")]), /Duplicate/);
});
