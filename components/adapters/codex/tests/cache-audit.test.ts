import assert from "node:assert/strict";
import test from "node:test";
import { summarizeCodexCacheAudit, type CodexCacheAuditRecord } from "../src/cache-audit.js";

function record(overrides: Partial<CodexCacheAuditRecord>): CodexCacheAuditRecord {
  return {
    at: "2026-07-05T00:00:00.000Z",
    sessionId: "sess-1",
    model: "gpt-5.4",
    stream: true,
    stablePrefixFingerprint: "fp-1",
    stablePrefix: {
      schemaVersion: 1,
      stableCore: [{ key: "instructions", source: "instructions", text: "stable" }],
      semiStableContext: [{ key: "model", source: "model", text: "gpt-5.4" }],
    },
    entropyFindings: [],
    driftReasons: [],
    originalRequestPromptCacheKey: "host-req-1",
    requestPromptCacheKey: "req-1",
    responsePromptCacheKey: "req-1",
    cachedInputTokens: 0,
    usage: { input_tokens: 100 },
    status: 200,
    ...overrides,
  };
}

test("summarizeCodexCacheAudit keeps warm hits stable even when response prompt_cache_key is rewritten", () => {
  const summary = summarizeCodexCacheAudit([
    record({
      at: "2026-07-05T00:00:03.000Z",
      sessionId: "sess-2",
      stablePrefixFingerprint: "fp-2",
      cachedInputTokens: 0,
      entropyFindings: [{ kind: "uuid", segmentKey: "instructions", layer: "stable_core", detail: "uuid" }],
    }),
    record({
      cachedInputTokens: 42,
      entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
      driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
      responsePromptCacheKey: "resp-2",
    }),
    record({
      at: "2026-07-05T00:00:01.000Z",
      cachedInputTokens: 0,
      entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
    }),
  ]);

  assert.equal(summary.totalRecords, 3);
  assert.equal(summary.warmCandidates, 1);
  assert.equal(summary.warmHits, 1);
  assert.equal(summary.warmMisses, 0);
  assert.equal(summary.hitRatePercent, 100);
  assert.equal(summary.responsePromptCacheKeyRewriteCount, 1);
  assert.equal(summary.promptCacheKeyMismatchCount, 1);
  assert.deepEqual(summary.topEntropyKinds[0], { key: "abs_path", count: 2 });
  assert.deepEqual(summary.topDriftKeys[0], { key: "instructions", count: 1 });
});

test("summarizeCodexCacheAudit treats matching prompt_cache_key and fingerprint across sessions as warm candidates", () => {
  const summary = summarizeCodexCacheAudit([
    record({
      at: "2026-07-05T00:00:02.000Z",
      sessionId: "sess-new",
      requestPromptCacheKey: "pk-shared",
      stablePrefixFingerprint: "fp-shared",
      cachedInputTokens: 64,
    }),
    record({
      at: "2026-07-05T00:00:01.000Z",
      sessionId: "sess-old",
      requestPromptCacheKey: "pk-shared",
      stablePrefixFingerprint: "fp-shared",
      cachedInputTokens: 0,
    }),
  ]);

  assert.equal(summary.warmCandidates, 1);
  assert.equal(summary.warmHits, 1);
  assert.equal(summary.warmMisses, 0);
  assert.equal(summary.hitRatePercent, 100);
});

test("summarizeCodexCacheAudit falls back to session plus fingerprint when prompt_cache_key is missing", () => {
  const summary = summarizeCodexCacheAudit([
    record({
      at: "2026-07-05T00:00:02.000Z",
      requestPromptCacheKey: null,
      responsePromptCacheKey: null,
      stablePrefixFingerprint: "fp-fallback",
      cachedInputTokens: 0,
    }),
    record({
      at: "2026-07-05T00:00:01.000Z",
      requestPromptCacheKey: null,
      responsePromptCacheKey: null,
      stablePrefixFingerprint: "fp-fallback",
      cachedInputTokens: 0,
    }),
  ]);

  assert.equal(summary.warmCandidates, 1);
  assert.equal(summary.warmHits, 0);
  assert.equal(summary.warmMisses, 1);
  assert.equal(summary.hitRatePercent, 0);
});

test("summarizeCodexCacheAudit does not create warm candidates when fingerprint changes", () => {
  const summary = summarizeCodexCacheAudit([
    record({
      at: "2026-07-05T00:00:02.000Z",
      requestPromptCacheKey: "pk-same",
      stablePrefixFingerprint: "fp-b",
      cachedInputTokens: 64,
    }),
    record({
      at: "2026-07-05T00:00:01.000Z",
      requestPromptCacheKey: "pk-same",
      stablePrefixFingerprint: "fp-a",
      cachedInputTokens: 0,
    }),
  ]);

  assert.equal(summary.warmCandidates, 0);
  assert.equal(summary.warmHits, 0);
  assert.equal(summary.warmMisses, 0);
});
