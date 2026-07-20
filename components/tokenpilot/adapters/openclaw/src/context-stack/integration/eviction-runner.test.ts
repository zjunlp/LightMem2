import test from "node:test";
import assert from "node:assert/strict";

import { runEvictionIfEnabled } from "./eviction-runner.js";

test("eviction runner uses normalized eviction switches instead of legacy policy switch", async () => {
  let calls = 0;
  const disabled = await runEvictionIfEnabled({
    cfg: {
      modules: { policy: true, eviction: false },
      eviction: { enabled: true },
    },
    logger: {},
    payload: { model: "gpt-5.4-mini", input: [] },
    sessionId: "session-disabled",
    policyModule: { name: "policy" },
    extractInputText: () => "",
    applyPolicyBeforeCall: async (turnCtx) => {
      calls += 1;
      return { turnCtx };
    },
  });

  assert.deepEqual(disabled, {
    enabled: false,
    executed: false,
    skippedReason: "module_disabled",
  });
  assert.equal(calls, 0);
});

test("eviction runner returns policy metadata after execution", async () => {
  const result = await runEvictionIfEnabled({
    cfg: {
      modules: { policy: false, eviction: true },
      eviction: { enabled: true },
    },
    logger: {},
    payload: {
      model: "gpt-5.4-mini",
      input: [{ role: "user", content: "continue" }],
    },
    sessionId: "session-enabled",
    policyModule: { name: "policy" },
    extractInputText: () => "continue",
    applyPolicyBeforeCall: async (turnCtx) => ({
      turnCtx: {
        ...turnCtx,
        metadata: {
          ...turnCtx.metadata,
          policy: { decisions: { eviction: { enabled: true } } },
        },
      },
    }),
  });

  assert.deepEqual(result, {
    enabled: true,
    executed: true,
    policyMetadata: { decisions: { eviction: { enabled: true } } },
  });
});
