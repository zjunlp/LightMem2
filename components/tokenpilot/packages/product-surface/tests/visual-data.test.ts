import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendReductionVisualSnapshot,
  readVisualSessionData,
} from "../src/visual/session-visual-data.js";

test("readVisualSessionData returns reduction snapshot route and ux aggregate", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokenpilot-product-surface-visual-"));
  try {
    const stateDir = root;
    const sessionId = "session-1";

    await appendReductionVisualSnapshot(stateDir, {
      kind: "reduction",
      at: "2026-07-02T12:00:00.000Z",
      sessionId,
      requestId: "req-1",
      model: "gpt-5.4",
      upstreamModel: "gpt-5.4",
      segmentId: "seg-1",
      itemIndex: 0,
      field: "output",
      toolName: "read",
      dataPath: "/repo/README.md",
      savedChars: 320,
      route: "readme_doc",
      routeReason: "readme_path_hint",
      passSavedChars: {
        tool_payload_trim: 300,
        read_state_compaction: 20,
      },
      beforeText: "before",
      afterText: "after",
      report: [],
    });

    const aggregatePath = join(stateDir, "tokenpilot", "ux-effects", "sessions", `${sessionId}.json`);
    await mkdir(join(stateDir, "tokenpilot", "ux-effects", "sessions"), { recursive: true });
    await writeFile(
      join(stateDir, "tokenpilot", "ux-effects", "history.jsonl"),
      `${JSON.stringify({
        sessionId,
        details: {
          routeSavedChars: { readme_doc: 320 },
          routeHitCount: { readme_doc: 1 },
          passSavedChars: { tool_payload_trim: 300, read_state_compaction: 20 },
        },
      })}\n`,
    );
    await writeFile(aggregatePath, JSON.stringify({
      sessionId,
      turns: 3,
      charOptimizedTurns: 2,
      charSavedCount: 640,
      avgSavedCharsPerOptimizedTurn: 320,
      passSavedChars: { tool_payload_trim: 500 },
      routeSavedChars: { readme_doc: 640 },
      routeHitCount: { readme_doc: 2 },
    }, null, 2));

    const data = await readVisualSessionData(stateDir, sessionId);
    assert.equal(data.reduction.length, 1);
    assert.equal(data.reduction[0]?.route, "readme_doc");
    assert.equal(data.reduction[0]?.routeReason, "readme_path_hint");
    assert.equal(data.reduction[0]?.passSavedChars?.tool_payload_trim, 300);
    assert.equal(data.uxAggregate?.charSavedCount, 640);
    assert.equal(data.uxAggregate?.routeSavedChars?.readme_doc, 640);
    assert.equal(data.recentReduction?.totalSavedChars, 320);
    assert.equal(data.recentReduction?.dominantRoute?.key, "readme_doc");
    assert.equal(data.recentReduction?.dominantPass?.key, "tool_payload_trim");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
