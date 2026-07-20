import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleReport } from "./session-report.js";
import { upsertOpenClawSessionSummary } from "../../session/session-summary.js";
import { appendModuleObservation } from "@tokenpilot/product-surface";

test("openclaw handleReport includes recent metrics and recovery aggregates when details are enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-openclaw-report-"));
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  const namespacedDir = join(dir, "tokenpilot");
  try {
    await mkdir(join(namespacedDir, "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(namespacedDir, "ux-effects", "latest.json"),
      `${JSON.stringify({
        sessionId,
        countMode: "chars",
        details: {
          requestSavedCount: 240,
          responseSavedCount: 60,
        },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(namespacedDir, "ux-effects", "sessions", `${sessionId}.json`),
      `${JSON.stringify({
        sessionId,
        turns: 4,
        latestCountMode: "chars",
        tokenOptimizedTurns: 0,
        tokenSavedCount: 0,
        avgSavedTokensPerOptimizedTurn: 0,
        charOptimizedTurns: 2,
        charSavedCount: 900,
        avgSavedCharsPerOptimizedTurn: 450,
        recoveryObservedSegments: 3,
        recoverySkippedSegments: 3,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(namespacedDir, "ux-effects", "history.jsonl"),
      [
        JSON.stringify({
          sessionId,
          details: {
            routeSavedChars: { search_results: 300, diff_output: 120 },
            routeHitCount: { search_results: 2, diff_output: 1 },
            passSavedChars: { tool_payload_trim: 360 },
            recoveryObservedSegments: 2,
            recoverySkippedSegments: 2,
            skippedReason: "below_trigger_min_chars",
          },
        }),
        JSON.stringify({
          sessionId,
          details: {
            routeSavedChars: { task_doc: 180 },
            routeHitCount: { task_doc: 1 },
            passSavedChars: { read_state_compaction: 80 },
            recoveryObservedSegments: 1,
            recoverySkippedSegments: 1,
            skippedReasons: ["pipeline_no_effect"],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await upsertOpenClawSessionSummary(dir, sessionId, {
      sessionKey: "agent:test-session",
      workspaceHint: "/tmp/workspace",
      latestModel: "gpt-5.4",
      turnCount: 4,
      requestChars: 1200,
      responseChars: 400,
      assistantChars: 240,
      reductionSavedChars: 360,
      updatedAt: new Date().toISOString(),
    });
    await writeFile(
      join(dir, "cache-audit.jsonl"),
      [
        JSON.stringify({
          at: "2026-07-05T00:00:00.000Z",
          sessionId,
          model: "gpt-5.4",
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
          sessionId: "other-session",
          model: "gpt-5.4",
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

    const result = await handleReport(
      { sessionId },
      {
        plugins: {
          entries: {
            tokenpilot: {
              config: {
                stateDir: dir,
                ux: { details: true },
              },
            },
          },
        },
      },
    );

    assert.match(result.text, /^Session: 123e4567-e89b-12d3-a456-426614174000/m);
    assert.match(result.text, /^Turns: 4/m);
    assert.match(result.text, /^Model: gpt-5\.4/m);
    assert.match(result.text, /^Workspace: \/tmp\/workspace/m);
    assert.match(result.text, /^Session key: agent:test-session/m);
    assert.match(result.text, /^Latest request chars: 1,200|^Latest request chars: 1200/m);
    assert.match(result.text, /^Latest response chars: 400/m);
    assert.match(result.text, /^Latest assistant chars: 240/m);
    assert.match(result.text, /^Latest reduction savings: 360/m);
    assert.match(result.text, /saved chars: 900/i);
    assert.match(result.text, /latest request savings: 240 chars/i);
    assert.match(result.text, /latest response savings: 60 chars/i);
    assert.match(result.text, /recent total savings: 600 chars/i);
    assert.match(result.text, /recent dominant route: search_results=300 chars \(50%, 2 hits\)/i);
    assert.match(result.text, /recent most-trimmed route: search_results=2 hits/i);
    assert.match(result.text, /recent dominant pass: tool_payload_trim=360 chars/i);
    assert.match(result.text, /recent top routes: search_results=300 chars\/2 hits, task_doc=180 chars\/1 hits, diff_output=120 chars\/1 hits/i);
    assert.match(result.text, /recent top passes: tool_payload_trim=360 chars, read_state_compaction=80 chars/i);
    assert.match(result.text, /recent recovery segments: observed=3, exempted=3/i);
    assert.match(result.text, /recent skipped reasons:/i);
    assert.match(result.text, /below_trigger_min_chars=1/i);
    assert.match(result.text, /pipeline_no_effect=1/i);
    assert.match(result.text, /response cache key rewrites: 1/i);
    assert.match(result.text, /cache entropy hotspots: abs_path=1/i);
    assert.doesNotMatch(result.text, /uuid=1/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openclaw handleReport renders eviction-only diagnostics without reduction aggregates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-openclaw-report-eviction-only-"));
  const sessionId = "123e4567-e89b-12d3-a456-426614174001";
  try {
    await appendModuleObservation(dir, {
      sessionId,
      phase: "request",
      moduleId: "stabilizer",
      enabled: false,
      executed: false,
      changed: false,
      skippedReason: "module_disabled",
      savedChars: 0,
      savedTokens: 0,
      api: { inputTokens: 0, outputTokens: 0 },
    });
    await appendModuleObservation(dir, {
      sessionId,
      phase: "request",
      moduleId: "reduction",
      enabled: false,
      executed: false,
      changed: false,
      skippedReason: "module_disabled",
      savedChars: 0,
      savedTokens: 0,
      api: { inputTokens: 0, outputTokens: 0 },
    });
    await appendModuleObservation(dir, {
      sessionId,
      phase: "request",
      moduleId: "eviction",
      enabled: true,
      executed: true,
      changed: true,
      savedChars: 0,
      savedTokens: 0,
      api: { inputTokens: 120, outputTokens: 24, costUsd: 0.002 },
    });
    await appendModuleObservation(dir, {
      sessionId,
      phase: "history",
      moduleId: "eviction",
      enabled: true,
      executed: true,
      changed: true,
      savedChars: 1600,
      savedTokens: 400,
      api: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await handleReport(
      { sessionId },
      {
        plugins: {
          entries: {
            tokenpilot: {
              config: {
                stateDir: dir,
                ux: { details: true },
              },
            },
          },
        },
      },
    );

    assert.match(result.text, /module mode: eviction-only/);
    assert.match(result.text, /no reduction savings recorded/);
    assert.match(result.text, /eviction: enabled=true, executions=2, changes=2/);
    assert.match(result.text, /estimated saved=400 tokens\/1,600 chars/);
    assert.match(result.text, /estimator api=120 input \+ 24 output tokens, api cost=\$0\.002000/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
