import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "./config-normalize.js";

test("normalizeConfig derives one effective module enablement snapshot", () => {
  const cfg = normalizeConfig({
    modules: {
      stabilizer: false,
      reduction: true,
      eviction: true,
    },
    eviction: {
      enabled: true,
    },
  });

  assert.deepEqual(cfg.moduleEnablement, {
    stabilizer: false,
    reduction: true,
    eviction: true,
  });
});

test("normalizeConfig requires both legacy eviction switches for compatibility", () => {
  const cases = [
    { modules: { eviction: false }, eviction: { enabled: false }, expected: false },
    { modules: { eviction: false }, eviction: { enabled: true }, expected: false },
    { modules: { eviction: true }, eviction: { enabled: false }, expected: false },
    { modules: { eviction: true }, eviction: { enabled: true }, expected: true },
  ];

  for (const item of cases) {
    const cfg = normalizeConfig({ modules: item.modules, eviction: item.eviction });
    assert.equal(cfg.moduleEnablement.eviction, item.expected);
  }
});

test("normalizeConfig preserves the TokenPilot default module contract", () => {
  const cfg = normalizeConfig({ stateDir: "/tmp/tokenpilot-config-contract" });

  assert.deepEqual(cfg.moduleEnablement, {
    stabilizer: true,
    reduction: true,
    eviction: false,
  });
  assert.deepEqual(cfg.modules, {
    stabilizer: true,
    policy: true,
    reduction: true,
    eviction: false,
  });
  assert.deepEqual(cfg.eviction, {
    enabled: false,
    policy: "noop",
    maxCandidateBlocks: 128,
    minBlockChars: 256,
    replacementMode: "pointer_stub",
  });
  assert.equal(cfg.taskStateEstimator.batchTurns, 5);
  assert.equal(cfg.taskStateEstimator.evictionLookaheadTurns, 3);
  assert.equal(cfg.reduction.engine, "layered");
  assert.equal(cfg.reduction.triggerMinChars, 2200);
  assert.equal(cfg.reduction.maxToolChars, 1200);
  assert.equal(cfg.stateDir, "/tmp/tokenpilot-config-contract");
  assert.equal(
    cfg.debugTapPath,
    "/tmp/tokenpilot-config-contract/tokenpilot/provider-traffic.jsonl",
  );
});
