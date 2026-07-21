import assert from "node:assert/strict";
import test from "node:test";
import { summarizeOpenClawCacheAudit, type OpenClawCacheAuditRecord } from "./cache-audit.js";

function makeRecord(overrides: Partial<OpenClawCacheAuditRecord>): OpenClawCacheAuditRecord {
  return {
    at: "2026-07-05T00:00:00.000Z",
    sessionId: "session-a",
    model: "gpt-5.4",
    stream: false,
    stablePrefixFingerprint: "fp-1",
    stablePrefix: {
      schemaVersion: 1,
      stableCore: [{ key: "instructions", role: "developer", source: "instructions", text: "developer: stable" }],
      semiStableContext: [],
    },
    entropyFindings: [],
    driftReasons: [],
    originalRequestPromptCacheKey: "host-pk-1",
    requestPromptCacheKey: "pk-1",
    responsePromptCacheKey: "pk-1",
    cachedInputTokens: 0,
    usage: { input_tokens: 100, output_tokens: 10 },
    status: 200,
    ...overrides,
  };
}

test("summarizeOpenClawCacheAudit keeps warm hits stable even when response prompt_cache_key is rewritten", () => {
  const records: OpenClawCacheAuditRecord[] = [
    makeRecord({
      at: "2026-07-05T00:00:03.000Z",
      sessionId: "session-b",
      stablePrefixFingerprint: "fp-2",
      requestPromptCacheKey: "pk-2",
      responsePromptCacheKey: "pk-3",
      cachedInputTokens: 0,
      entropyFindings: [{ kind: "uuid", segmentKey: "instructions", layer: "stable_core", detail: "uuid-like" }],
    }),
    makeRecord({
      sessionId: "session-c",
      cachedInputTokens: 42,
      entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "abs-path" }],
      driftReasons: [{ key: "stableCore[0]", kind: "segment_text_changed", detail: "changed" }],
      responsePromptCacheKey: "pk-3",
    }),
    makeRecord({
      at: "2026-07-05T00:00:01.000Z",
      sessionId: "session-a",
      stablePrefixFingerprint: "fp-1",
      requestPromptCacheKey: "pk-1",
      responsePromptCacheKey: "pk-1",
      cachedInputTokens: 0,
      entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "abs-path" }],
      driftReasons: [{ key: "semiStableContext[0]", kind: "segment_added", detail: "changed" }],
    }),
    makeRecord({
      at: "2026-07-05T00:03:00.000Z",
      sessionId: "session-d",
      stablePrefixFingerprint: "fp-3",
      requestPromptCacheKey: null,
      responsePromptCacheKey: null,
      cachedInputTokens: 0,
      entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "abs-path" }],
      driftReasons: [{ key: "volatileTail[0]", kind: "segment_text_changed", detail: "changed" }],
    }),
  ];

  const summary = summarizeOpenClawCacheAudit(records);
  assert.equal(summary.totalRecords, 4);
  assert.equal(summary.warmCandidates, 1);
  assert.equal(summary.warmHits, 1);
  assert.equal(summary.warmMisses, 0);
  assert.equal(summary.hitRatePercent, 100);
  assert.equal(summary.latestSessionId, "session-b");
  assert.equal(summary.latestFingerprint, "fp-2");
  assert.equal(summary.responsePromptCacheKeyRewriteCount, 2);
  assert.equal(summary.promptCacheKeyMismatchCount, 2);
  assert.deepEqual(summary.topEntropyKinds[0], { key: "abs_path", count: 3 });
  assert.deepEqual(summary.topEntropyKinds[1], { key: "uuid", count: 1 });
  assert.deepEqual(summary.topDriftKeys[0], { key: "semiStableContext[0]", count: 1 });
});
