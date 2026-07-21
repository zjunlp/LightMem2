import test from "node:test";
import assert from "node:assert/strict";

import { runLifecyclePlanningIfEnabled } from "./lifecycle-planning-runner.js";

test("lifecycle planning runner uses normalized eviction switches instead of legacy policy switch", async () => {
  let calls = 0;
  const disabled = await runLifecyclePlanningIfEnabled({
    cfg: {
      moduleEnablement: { stabilizer: false, reduction: false, eviction: false },
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

test("lifecycle planning runner returns policy metadata after execution", async () => {
  const result = await runLifecyclePlanningIfEnabled({
    cfg: {
      moduleEnablement: { stabilizer: false, reduction: false, eviction: true },
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
    registryChanged: false,
    planCreated: false,
    plannedSavedChars: 0,
    plannedInstructionCount: 0,
    policyMetadata: { decisions: { eviction: { enabled: true } } },
  });
});

test("lifecycle planning runner separates registry updates from the eviction plan", async () => {
  const result = await runLifecyclePlanningIfEnabled({
    cfg: {
      moduleEnablement: { stabilizer: false, reduction: false, eviction: true },
      eviction: { enabled: true },
    },
    logger: {},
    payload: { model: "gpt-5.4-mini", input: [] },
    sessionId: "session-accounting",
    policyModule: { name: "policy" },
    extractInputText: () => "",
    applyPolicyBeforeCall: async (turnCtx) => ({
      turnCtx: {
        ...turnCtx,
        metadata: {
          policy: {
            decisions: {
              taskState: {
                applied: true,
                estimatorUsage: {
                  inputTokens: 120,
                  outputTokens: 24,
                  totalTokens: 144,
                  costUsd: 0.002,
                },
              },
              eviction: {
                instructions: [{ blockId: "block-1" }],
                estimatedSavedChars: 800,
              },
            },
          },
        },
      },
    }),
  });

  assert.equal(result.registryChanged, true);
  assert.equal(result.planCreated, true);
  assert.equal(result.plannedSavedChars, 800);
  assert.equal(result.plannedInstructionCount, 1);
  assert.deepEqual(result.estimatorUsage, {
    inputTokens: 120,
    outputTokens: 24,
    totalTokens: 144,
    costUsd: 0.002,
  });
});
