import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendCodexRecentTurnBinding, upsertCodexSessionSnapshot } from "../src/session-state.js";
import { renderCodexSessionReport } from "../src/session-report.js";

test("codex session report renders topology and recent reduction metrics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-codex-report-"));
  try {
    await upsertCodexSessionSnapshot(dir, "sess-1", {
      latestResponseId: "resp-2",
      previousResponseId: "resp-1",
      latestModel: "gpt-test",
      workspaceHint: "/tmp/work",
    });
    await appendCodexRecentTurnBinding(dir, {
      sessionId: "sess-1",
      responseId: "resp-2",
      previousResponseId: "resp-1",
      model: "gpt-test",
      requestChars: 12,
      responseChars: 34,
      assistantChars: 20,
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
          requestSavedCount: 800,
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
        charSavedCount: 800,
        avgSavedCharsPerOptimizedTurn: 800,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(dir, "ux-effects", "history.jsonl"),
      `${JSON.stringify({
        sessionId: "sess-1",
        details: {
          routeSavedChars: {
            code_like: 500,
            readme_doc: 300,
          },
          routeHitCount: {
            code_like: 2,
            readme_doc: 1,
          },
          passSavedChars: {
            tool_payload_trim: 700,
            read_state_compaction: 100,
          },
          recoveryObservedSegments: 2,
          recoverySkippedSegments: 2,
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
          model: "gpt-test",
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
          model: "gpt-test",
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

    const report = await renderCodexSessionReport(dir, "sess-1");

    assert.match(report, /^Session: sess-1/m);
    assert.match(report, /^Response chain: resp-2/m);
    assert.match(report, /TokenPilot Codex report:/);
    assert.match(report, /saved chars: 800/i);
    assert.match(report, /latest request savings: 800 chars/i);
    assert.match(report, /recent total savings: 800 chars/i);
    assert.match(report, /recent dominant route: code_like=500 chars \(62\.5%, 2 hits\)/i);
    assert.match(report, /recent most-trimmed route: code_like=2 hits/i);
    assert.match(report, /recent dominant pass: tool_payload_trim=700 chars/i);
    assert.match(report, /recent top routes: code_like=500 chars\/2 hits, readme_doc=300 chars\/1 hits/i);
    assert.match(report, /recent top passes: tool_payload_trim=700 chars, read_state_compaction=100 chars/i);
    assert.match(report, /recent recovery segments: observed=2, exempted=2/i);
    assert.match(report, /response cache key rewrites: 1/i);
    assert.match(report, /cache entropy hotspots: abs_path=1/i);
    assert.doesNotMatch(report, /uuid=1/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
