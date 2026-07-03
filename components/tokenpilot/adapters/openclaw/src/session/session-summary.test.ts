import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildOpenClawSessionOverview,
  readOpenClawSessionSummary,
  upsertOpenClawSessionSummary,
} from "./session-summary.js";

test("openclaw session summary persists and builds overview rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tokenpilot-openclaw-session-summary-"));
  try {
    await upsertOpenClawSessionSummary(dir, "sess-1", {
      sessionKey: "agent:test",
      workspaceHint: "/tmp/work",
      latestModel: "gpt-5.4",
      turnCount: 3,
      requestChars: 800,
      responseChars: 240,
      assistantChars: 120,
      reductionSavedChars: 300,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });

    const summary = await readOpenClawSessionSummary(dir, "sess-1");
    assert.ok(summary);
    assert.equal(summary?.sessionKey, "agent:test");
    assert.equal(summary?.turnCount, 3);

    const overview = buildOpenClawSessionOverview("sess-1", summary);
    assert.deepEqual(overview, [
      { label: "Session", value: "sess-1" },
      { label: "Turns", value: 3 },
      { label: "Model", value: "gpt-5.4" },
      { label: "Workspace", value: "/tmp/work" },
      { label: "Session key", value: "agent:test" },
      { label: "Latest request chars", value: 800 },
      { label: "Latest response chars", value: 240 },
      { label: "Latest assistant chars", value: 120 },
      { label: "Latest reduction savings", value: 300 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
