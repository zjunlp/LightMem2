import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCodexRebaseCapability,
  appendCodexRebaseCooldown,
  appendPendingCodexRebaseEpoch,
  CODEX_REBASE_API_VERSION,
  CODEX_REBASE_ITEM_SCHEMA_VERSION,
  CODEX_REBASE_WIRE_MODE,
  commitCodexRebaseEpoch,
  codexRebaseEndpointIdentity,
  codexRebaseEpochJournalPath,
} from "../src/context-rewrite/index.js";
import { appendCodexRecentTurnBinding, upsertCodexSessionSnapshot } from "../src/session-state.js";
import { renderCodexSessionReport } from "../src/session-report.js";

test("CDR-07 Codex session report renders rebase state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-report-"));
  try {
    await upsertCodexSessionSnapshot(dir, "sess-rebase-report", {
      latestResponseId: "resp-new",
      previousResponseId: "resp-old",
      latestModel: "gpt-test",
    });
    await appendCodexRecentTurnBinding(dir, {
      sessionId: "sess-rebase-report",
      responseId: "resp-new",
      previousResponseId: "resp-old",
      model: "gpt-test",
      requestChars: 20,
      responseChars: 30,
      assistantChars: 10,
      stream: false,
      updatedAt: "2026-07-28T10:00:00.000Z",
    });
    await appendPendingCodexRebaseEpoch({
      stateDir: dir,
      sessionId: "sess-rebase-report",
      planId: "plan-report",
      epochId: "epoch-report",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
      createdAt: "2026-07-28T10:00:00.000Z",
    });
    await commitCodexRebaseEpoch({
      stateDir: dir,
      sessionId: "sess-rebase-report",
      epochId: "epoch-report",
      newResponseId: "resp-new",
      newRevision: "rev-new",
      updatedAt: "2026-07-28T10:00:01.000Z",
    });
    await appendCodexRebaseCooldown({
      stateDir: dir,
      sessionId: "sess-rebase-report",
      planId: "plan-report",
      reason: "rebase_upstream_rejected",
      cooldownMs: 300_000,
      startedAt: "2999-01-01T00:00:00.000Z",
    });
    await appendCodexRebaseCapability({
      stateDir: dir,
      provider: "OpenAI",
      model: "gpt-test",
      wireMode: CODEX_REBASE_WIRE_MODE,
      apiVersion: CODEX_REBASE_API_VERSION,
      endpointId: codexRebaseEndpointIdentity("https://api.openai.example/v1"),
      itemType: "web_search_call",
      itemSchemaVersion: CODEX_REBASE_ITEM_SCHEMA_VERSION,
      status: "verified_unsupported",
      evidence: "mock_fixture",
      reason: "schema_error",
      observedAt: "2026-07-28T10:00:02.000Z",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });

    const report = await renderCodexSessionReport(dir, "sess-rebase-report");

    assert.match(report, /rebase epochs: committed=1, rolled_back=0, failed=0, pending=0/i);
    assert.match(report, /latest rebase epoch: committed epoch-report old=resp-old new=resp-new/i);
    assert.match(report, /rebase cooldowns: active=1\/1 latest=rebase_upstream_rejected/i);
    assert.match(report, /web_search_call@responses-item\/v2 verified_unsupported evidence=mock\/fixture/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CDR-07 Codex session report renders rebase accounting and break-even", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-report-accounting-"));
  try {
    await upsertCodexSessionSnapshot(dir, "sess-rebase-accounting", {
      latestResponseId: "resp-new",
      previousResponseId: "resp-old",
      latestModel: "gpt-test",
    });
    await appendPendingCodexRebaseEpoch({
      stateDir: dir,
      sessionId: "sess-rebase-accounting",
      planId: "plan-accounting",
      epochId: "epoch-accounting",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
      createdAt: "2026-07-28T10:00:00.000Z",
      accounting: {
        plannedSavedChars: 120,
        plannedSavedTokens: 30,
        actuallyRemovedChars: 80,
        actuallyRemovedTokens: 20,
        rebaseReplayCostChars: 200,
        rebaseReplayCostTokens: 50,
        subsequentSavedCharsPerTurn: 80,
        subsequentSavedTokensPerTurn: 20,
        estimatorCostChars: 8,
        estimatorCostTokens: 2,
        fallbackExtraRequestCount: 0,
        cacheColdMissCount: 1,
        breakEvenTurn: 3,
      },
    });
    await commitCodexRebaseEpoch({
      stateDir: dir,
      sessionId: "sess-rebase-accounting",
      epochId: "epoch-accounting",
      newResponseId: "resp-new",
      newRevision: "rev-new",
      updatedAt: "2026-07-28T10:00:01.000Z",
    });

    const report = await renderCodexSessionReport(dir, "sess-rebase-accounting");

    assert.match(report, /rebase accounting: planned_saved=120 chars \(~30 tokens\)/i);
    assert.match(report, /removed=80 chars \(~20 tokens\)/i);
    assert.match(report, /replay_cost=200 chars \(~50 tokens\)/i);
    assert.match(report, /subsequent_saved=80 chars\/turn \(~20 tokens\/turn\)/i);
    assert.match(report, /estimator_cost=8 chars \(~2 tokens\)/i);
    assert.match(report, /fallback_extra_requests=0 cache_cold_misses=1 break_even_turn=3/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CDR-07 Codex session report surfaces rebase journal read errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-report-error-"));
  try {
    await upsertCodexSessionSnapshot(dir, "sess-rebase-report-error", {
      latestResponseId: "resp-error",
      latestModel: "gpt-test",
    });
    await mkdir(codexRebaseEpochJournalPath(dir, "sess-rebase-report-error"), { recursive: true });

    const report = await renderCodexSessionReport(dir, "sess-rebase-report-error");

    assert.match(report, /rebase journal read errors: epoch=/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
