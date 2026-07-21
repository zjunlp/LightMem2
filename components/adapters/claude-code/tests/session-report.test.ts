import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendClaudeCodeRecentTurnBinding, upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";
import { renderClaudeCodeSessionReport } from "../src/session-report.js";

test("claude-code session report renders topology and recent reduction metrics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-claude-code-report-"));
  try {
    await upsertClaudeCodeSessionSnapshot(dir, "sess-1", {
      latestResponseId: "msg-2",
      previousResponseId: "msg-1",
      latestModel: "claude-test",
      workspaceHint: "/tmp/work",
      lastToolName: "Read",
      requestChars: 480,
      responseChars: 220,
      assistantChars: 120,
      reductionSavedChars: 500,
    });
    await appendClaudeCodeRecentTurnBinding(dir, {
      sessionId: "sess-1",
      responseId: "msg-2",
      previousResponseId: "msg-1",
      model: "claude-test",
      requestChars: 480,
      responseChars: 220,
      assistantChars: 120,
      reductionSavedChars: 500,
      stream: false,
      updatedAt: new Date().toISOString(),
    });
    await mkdir(join(dir, "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(dir, "ux-effects", "latest.json"),
      `${JSON.stringify({
        sessionId: "sess-1",
        countMode: "chars",
        details: {
          requestSavedCount: 500,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "ux-effects", "sessions", "sess-1.json"),
      `${JSON.stringify({
        sessionId: "sess-1",
        turns: 1,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 1,
        charSavedCount: 500,
        avgSavedCharsPerOptimizedTurn: 500,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "ux-effects", "history.jsonl"),
      `${JSON.stringify({
        sessionId: "sess-1",
        details: {
          routeSavedChars: {
            log_output: 320,
            task_doc: 180,
          },
          routeHitCount: {
            log_output: 2,
            task_doc: 1,
          },
          passSavedChars: {
            tool_payload_trim: 400,
            exec_output_truncation: 100,
          },
          recoveryObservedSegments: 1,
          recoverySkippedSegments: 1,
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-05T00:00:00.000Z",
          sessionId: "sess-1",
          model: "claude-test",
          stream: false,
          stablePrefixFingerprint: "fp-a",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "abs_path", segmentKey: "instructions", layer: "stable_core", detail: "path" }],
          driftReasons: [{ kind: "segment_text_changed", key: "instructions", detail: "changed" }],
          originalRequestPromptCacheKey: "host-pk-a",
          requestPromptCacheKey: "pk-a",
          responsePromptCacheKey: "pk-b",
          cachedInputTokens: 64,
          usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 64 } },
          status: 200,
        }),
        JSON.stringify({
          at: "2026-07-05T00:01:00.000Z",
          sessionId: "sess-other",
          model: "claude-test",
          stream: false,
          stablePrefixFingerprint: "fp-other",
          stablePrefix: { schemaVersion: 1, stableCore: [], semiStableContext: [] },
          entropyFindings: [{ kind: "uuid", segmentKey: "instructions", layer: "stable_core", detail: "uuid" }],
          driftReasons: [{ kind: "segment_text_changed", key: "tools", detail: "changed" }],
          originalRequestPromptCacheKey: "host-pk-other",
          requestPromptCacheKey: "pk-other",
          responsePromptCacheKey: "pk-other-2",
          cachedInputTokens: 0,
          usage: { input_tokens: 120 },
          status: 200,
        }),
      ].join("\n"),
      "utf8",
    );

    const report = await renderClaudeCodeSessionReport(dir, "sess-1");

    assert.match(report, /^Session: sess-1/m);
    assert.match(report, /^Response chain: msg-2/m);
    assert.match(report, /TokenPilot Claude Code report:/);
    assert.match(report, /saved chars: 500/i);
    assert.match(report, /latest request savings: 500 chars/i);
    assert.match(report, /recent total savings: 500 chars/i);
    assert.match(report, /recent dominant route: log_output=320 chars \(64%, 2 hits\)/i);
    assert.match(report, /recent most-trimmed route: log_output=2 hits/i);
    assert.match(report, /recent dominant pass: tool_payload_trim=400 chars/i);
    assert.match(report, /recent top routes: log_output=320 chars\/2 hits, task_doc=180 chars\/1 hits/i);
    assert.match(report, /recent top passes: tool_payload_trim=400 chars, exec_output_truncation=100 chars/i);
    assert.match(report, /recent recovery segments: observed=1, exempted=1/i);
    assert.match(report, /response cache key rewrites: 1/i);
    assert.match(report, /cache entropy hotspots: abs_path=1/i);
    assert.doesNotMatch(report, /uuid=1/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
