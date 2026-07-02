import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readRecentReductionMetrics } from "../src/metrics.js";
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
        },
      }),
      JSON.stringify({
        sessionId: "sess-1",
        details: {
          routeSavedChars: { code_like: 200, task_doc: 150 },
          routeHitCount: { code_like: 1, task_doc: 1 },
          passSavedChars: { tool_payload_trim: 250, read_state_compaction: 100 },
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("formatSessionReport includes recent route and pass metrics when provided", () => {
  const text = formatSessionReport({
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
    },
  });

  assert.match(text, /recent sampled turns: 3/);
  assert.match(text, /recent top routes: code_like=900 chars\/4 hits, task_doc=300 chars\/1 hits/);
  assert.match(text, /recent top passes: tool_payload_trim=1,000 chars, read_state_compaction=200 chars/);
});
