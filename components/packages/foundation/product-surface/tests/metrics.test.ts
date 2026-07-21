import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readRecentReductionMetrics, summarizeRecentReductionMetrics } from "../src/metrics.js";
import { formatSessionReport } from "../src/presentation.js";

test("readRecentReductionMetrics aggregates recent route and pass metrics from history", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-metrics-"));
  try {
    const stateDir = root;
    const historyDir = join(stateDir, "ux-effects");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "history.jsonl"), [
      JSON.stringify({
        sessionId: "sess-1",
        details: {
          routeSavedChars: { code_like: 300, readme_doc: 100 },
          routeHitCount: { code_like: 2, readme_doc: 1 },
          passSavedChars: { tool_payload_trim: 350 },
          recoveryObservedSegments: 1,
          recoverySkippedSegments: 1,
          skippedReason: "below_trigger_min_chars",
        },
      }),
      JSON.stringify({
        sessionId: "sess-1",
        details: {
          routeSavedChars: { code_like: 200, task_doc: 150 },
          routeHitCount: { code_like: 1, task_doc: 1 },
          passSavedChars: { tool_payload_trim: 250, read_state_compaction: 100 },
          recoveryObservedSegments: 2,
          recoverySkippedSegments: 2,
          skippedReasons: ["pipeline_no_effect"],
        },
      }),
      JSON.stringify({
        sessionId: "sess-2",
        details: {
          routeSavedChars: { log_output: 999 },
          routeHitCount: { log_output: 1 },
          passSavedChars: { tool_payload_trim: 999 },
        },
      }),
    ].join("\n"));

    const metrics = await readRecentReductionMetrics(stateDir, "sess-1");
    assert.ok(metrics);
    assert.equal(metrics?.sampledTurns, 2);
    assert.equal(metrics?.routeSavedChars.code_like, 500);
    assert.equal(metrics?.routeHitCount.code_like, 3);
    assert.equal(metrics?.passSavedChars.tool_payload_trim, 600);
    assert.equal(metrics?.passSavedChars.read_state_compaction, 100);
    assert.equal(metrics?.recoveryObservedSegments, 3);
    assert.equal(metrics?.recoverySkippedSegments, 3);
    assert.equal(metrics?.skippedReasons.below_trigger_min_chars, 1);
    assert.equal(metrics?.skippedReasons.pipeline_no_effect, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readRecentReductionMetrics falls back to namespaced history paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-metrics-namespaced-"));
  try {
    const historyDir = join(root, "tokenpilot", "ux-effects");
    await mkdir(historyDir, { recursive: true });
    await writeFile(join(historyDir, "history.jsonl"), [
      JSON.stringify({
        sessionId: "sess-ns",
        details: {
          routeSavedChars: { search_results: 220 },
          routeHitCount: { search_results: 2 },
          passSavedChars: { tool_payload_trim: 220 },
          recoveryObservedSegments: 1,
          recoverySkippedSegments: 1,
        },
      }),
    ].join("\n"));

    const metrics = await readRecentReductionMetrics(root, "sess-ns");
    assert.ok(metrics);
    assert.equal(metrics?.routeSavedChars.search_results, 220);
    assert.equal(metrics?.recoveryObservedSegments, 1);
    assert.equal(metrics?.recoverySkippedSegments, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizeRecentReductionMetrics derives dominant route and pass breakdown", () => {
  const summary = summarizeRecentReductionMetrics({
    sampledTurns: 3,
    routeSavedChars: {
      code_like: 900,
      task_doc: 300,
    },
    routeHitCount: {
      code_like: 4,
      task_doc: 1,
    },
    passSavedChars: {
      tool_payload_trim: 1000,
      read_state_compaction: 200,
    },
    recoveryObservedSegments: 3,
    recoverySkippedSegments: 3,
    skippedReasons: {
      below_trigger_min_chars: 2,
      pipeline_no_effect: 1,
    },
  });

  assert.equal(summary.totalSavedChars, 1200);
  assert.equal(summary.dominantRoute?.key, "code_like");
  assert.equal(summary.dominantRoute?.value, 900);
  assert.equal(summary.dominantRoute?.hits, 4);
  assert.equal(summary.dominantRoute?.sharePercent, 75);
  assert.equal(summary.mostTrimmedRoute?.key, "code_like");
  assert.equal(summary.mostTrimmedRoute?.value, 4);
  assert.equal(summary.dominantPass?.key, "tool_payload_trim");
  assert.equal(summary.topSkippedReasons[0]?.key, "below_trigger_min_chars");
});

test("formatSessionReport includes recent route and pass metrics when provided", () => {
  const text = formatSessionReport({
    title: "TokenPilot Codex report:",
    sessionId: "sess-1",
    aggregate: {
      turns: 6,
      latestCountMode: "chars",
      tokenOptimizedTurns: 0,
      tokenSavedCount: 0,
      avgSavedTokensPerOptimizedTurn: 0,
      charOptimizedTurns: 3,
      charSavedCount: 1500,
      avgSavedCharsPerOptimizedTurn: 500,
    },
    latest: {
      countMode: "chars",
      details: {
        requestSavedCount: 400,
      },
    },
    detailsEnabled: true,
    recentMetrics: {
      sampledTurns: 3,
      routeSavedChars: {
        code_like: 900,
        task_doc: 300,
      },
      routeHitCount: {
        code_like: 4,
        task_doc: 1,
      },
      passSavedChars: {
        tool_payload_trim: 1000,
        read_state_compaction: 200,
      },
      recoveryObservedSegments: 3,
      recoverySkippedSegments: 3,
      skippedReasons: {
        below_trigger_min_chars: 2,
        pipeline_no_effect: 1,
      },
    },
    overview: [
      { label: "Session", value: "sess-1" },
      { label: "Model", value: "gpt-5.4" },
    ],
  });

  assert.match(text, /^Session: sess-1/m);
  assert.match(text, /^Model: gpt-5\.4/m);
  assert.match(text, /TokenPilot Codex report:/);
  assert.match(text, /recent sampled turns: 3/);
  assert.match(text, /recent total savings: 1,200 chars/);
  assert.match(text, /recent dominant route: code_like=900 chars \(75%, 4 hits\)/);
  assert.match(text, /recent most-trimmed route: code_like=4 hits/);
  assert.match(text, /recent dominant pass: tool_payload_trim=1,000 chars/);
  assert.match(text, /recent top routes: code_like=900 chars\/4 hits, task_doc=300 chars\/1 hits/);
  assert.match(text, /recent top passes: tool_payload_trim=1,000 chars, read_state_compaction=200 chars/);
  assert.match(text, /recent recovery segments: observed=3, exempted=3/);
  assert.match(text, /recent skipped reasons: below_trigger_min_chars=2, pipeline_no_effect=1/);
});
