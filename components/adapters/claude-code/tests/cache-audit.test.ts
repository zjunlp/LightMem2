import assert from "node:assert/strict";
import test from "node:test";
import { summarizeClaudeCodeCacheAudit, type ClaudeCodeCacheAuditRecord } from "../src/cache-audit.js";

function record(overrides: Partial<ClaudeCodeCacheAuditRecord>): ClaudeCodeCacheAuditRecord {
  return {
    at: "2026-07-05T00:00:00.000Z",
    sessionId: "sess-1",
    model: "claude-sonnet-4-6",
    stream: true,
    stablePrefixFingerprint: "fp-1",
    stablePrefix: {
      schemaVersion: 1,
      stableCore: [{ key: "instructions", source: "instructions", text: "stable" }],
      semiStableContext: [{ key: "model", source: "model", text: "claude-sonnet-4-6" }],
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

test("summarizeClaudeCodeCacheAudit keeps warm hits stable even when response prompt_cache_key is rewritten", () => {
  const summary = summarizeClaudeCodeCacheAudit([
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
