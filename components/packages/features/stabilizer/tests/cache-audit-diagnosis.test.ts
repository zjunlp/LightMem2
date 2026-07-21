import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseCacheAudit } from "../src/cache-audit-diagnosis.js";

test("diagnoseCacheAudit returns actionable cold-miss guidance", () => {
  const diagnosis = diagnoseCacheAudit({
    stablePrefixFingerprint: "fp-1",
    requestPromptCacheKey: "pk-1",
    responsePromptCacheKey: "pk-2",
    cachedInputTokens: 0,
    baselineKind: "identity",
    entropyFindings: [
      {
        kind: "abs_path",
        segmentKey: "instructions",
        layer: "stable_core",
        detail: "absolute path detected without placeholder normalization",
      },
    ],
    driftReasons: [
      {
        kind: "segment_text_changed",
        key: "messages.0",
        detail: "stable segment text changed",
      },
    ],
  });

  assert.equal(diagnosis.matchedResult, "cold miss");
  assert.equal(diagnosis.rewriteDetected, true);
  assert.match(diagnosis.currentState, /Cold miss/);
  assert.match(diagnosis.optimizationHint, /Fingerprint drift/);
  assert.equal(diagnosis.killers.length > 0, true);
  assert.match(diagnosis.killers[0]?.title ?? "", /abs_path|segment_text_changed/);
  assert.equal(diagnosis.harnessRules.length > 0, true);
  assert.match(diagnosis.harnessRules.join("\n"), /canonicalize|dynamic context/);
});

test("diagnoseCacheAudit preserves warm-hit maintenance guidance", () => {
  const diagnosis = diagnoseCacheAudit({
    stablePrefixFingerprint: "fp-2",
    requestPromptCacheKey: "pk-1",
    responsePromptCacheKey: "pk-1",
    cachedInputTokens: 128,
    baselineKind: "identity",
    entropyFindings: [],
    driftReasons: [],
  });

  assert.equal(diagnosis.matchedResult, "warm hit");
  assert.equal(diagnosis.rewriteDetected, false);
  assert.match(diagnosis.currentState, /Warm hit already happened/);
  assert.match(diagnosis.targetState, /keep the same fingerprint/);
  assert.match(diagnosis.optimizationHint, /Warm hit/);
});

test("diagnoseCacheAudit falls back to unmatched when input is missing", () => {
  const diagnosis = diagnoseCacheAudit(null);

  assert.equal(diagnosis.matchedResult, "unmatched");
  assert.equal(diagnosis.rewriteDetected, false);
  assert.match(diagnosis.currentState, /No matched cache-audit request/);
  assert.equal(Array.isArray(diagnosis.killers), true);
  assert.equal(Array.isArray(diagnosis.harnessRules), true);
});

test("diagnoseCacheAudit classifies first unmatched baseline as cold start", () => {
  const diagnosis = diagnoseCacheAudit({
    stablePrefixFingerprint: "fp-3",
    requestPromptCacheKey: "pk-3",
    responsePromptCacheKey: "pk-3",
    cachedInputTokens: 0,
    baselineKind: "none",
    entropyFindings: [],
    driftReasons: [],
  });

  assert.equal(diagnosis.matchedResult, "cold start");
  assert.match(diagnosis.currentState, /Cold start/i);
  assert.match(diagnosis.optimizationHint, /Cold start/i);
});

test("diagnoseCacheAudit distinguishes session-local baseline from same-target miss", () => {
  const diagnosis = diagnoseCacheAudit({
    stablePrefixFingerprint: "fp-4",
    requestPromptCacheKey: "pk-4",
    responsePromptCacheKey: "pk-4",
    cachedInputTokens: 0,
    baselineKind: "session",
    entropyFindings: [],
    driftReasons: [
      {
        kind: "segment_text_changed",
        key: "instructions",
        detail: "changed",
      },
    ],
  });

  assert.equal(diagnosis.matchedResult, "cold start");
  assert.match(diagnosis.currentState, /session-local/i);
  assert.match(diagnosis.harnessRules.join("\n"), /session-local baseline/i);
});
