import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendModuleObservation,
  readSessionModuleObservationSummary,
} from "../src/module-observability.js";
import { readVisualSessionData, readVisualSessionList } from "../src/visual/session-visual-data.js";

test("module observations aggregate eviction savings and estimator usage", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-observability-"));
  const sessionId = "session-eviction-only";
  try {
    await appendModuleObservation(stateDir, {
      at: "2026-07-20T00:00:00.000Z",
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
    await appendModuleObservation(stateDir, {
      at: "2026-07-20T00:00:01.000Z",
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
    await appendModuleObservation(stateDir, {
      at: "2026-07-20T00:00:02.000Z",
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
    await appendModuleObservation(stateDir, {
      at: "2026-07-20T00:00:03.000Z",
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

    const summary = await readSessionModuleObservationSummary(stateDir, sessionId);
    assert.equal(summary?.mode, "eviction-only");
    assert.equal(summary?.modules.eviction.executions, 2);
    assert.equal(summary?.modules.eviction.savedTokens, 400);
    assert.equal(summary?.modules.eviction.apiInputTokens, 120);
    assert.equal(summary?.modules.eviction.apiCostUsd, 0.002);

    const sessions = await readVisualSessionList(stateDir);
    assert.deepEqual(sessions.map((session) => session.sessionId), [sessionId]);
    const data = await readVisualSessionData(stateDir, sessionId);
    assert.equal(data.moduleSummary?.mode, "eviction-only");
    assert.equal(data.stability.length, 0);
    assert.equal(data.reduction.length, 0);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
