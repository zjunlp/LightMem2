import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendModuleObservation,
  listSessionModuleObservationSummaries,
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
      skippedReason: "none",
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
    assert.deepEqual(summary?.modules.eviction.executionsByPhase, {
      request: 1,
      response: 0,
      history: 1,
    });
    assert.equal(summary?.modules.eviction.changes, 1);
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

test("accounting observations add savings without creating executions or skips", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-observability-accounting-"));
  const sessionId = "session-accounting";
  try {
    await appendModuleObservation(stateDir, {
      at: "2026-07-20T00:00:00.000Z",
      sessionId,
      phase: "request",
      moduleId: "reduction",
      enabled: true,
      executed: true,
      changed: true,
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
      phase: "response",
      moduleId: "reduction",
      enabled: true,
      executed: false,
      changed: false,
      savedChars: 400,
      savedTokens: 100,
      api: { inputTokens: 0, outputTokens: 0 },
    });

    const summary = await readSessionModuleObservationSummary(stateDir, sessionId);
    assert.equal(summary?.modules.reduction.executions, 1);
    assert.equal(summary?.modules.reduction.changes, 1);
    assert.equal(summary?.modules.reduction.skips, 1);
    assert.equal(summary?.modules.reduction.savedChars, 400);
    assert.equal(summary?.modules.reduction.savedTokens, 100);
    assert.equal(summary?.modules.reduction.enabled, false);
    assert.equal(summary?.modules.reduction.latestSkippedReason, "module_disabled");
    assert.equal(summary?.modules.reduction.latestAt, "2026-07-20T00:00:01.000Z");
    assert.equal(summary?.latestAt, "2026-07-20T00:00:02.000Z");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("session summary listing falls back to legacy observation files", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-observability-legacy-"));
  const sessionId = "legacy/session";
  const collidingSessionId = "legacy_session";
  try {
    const legacyDir = join(stateDir, "tokenpilot", "module-observability");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "legacy_session.jsonl"),
      [sessionId, collidingSessionId].map((legacySessionId, index) => JSON.stringify({
        at: `2026-07-20T00:00:0${index}.000Z`,
        sessionId: legacySessionId,
        phase: "request",
        moduleId: "eviction",
        enabled: true,
        executed: true,
        changed: false,
        savedChars: 0,
        savedTokens: 0,
        api: { inputTokens: 10 + index, outputTokens: 2 },
      })).join("\n") + "\n",
      "utf8",
    );

    const summaries = await listSessionModuleObservationSummaries(stateDir);
    assert.equal(summaries.length, 2);
    assert.deepEqual(
      summaries.map((summary) => summary.sessionId).sort(),
      [sessionId, collidingSessionId].sort(),
    );
    assert.equal(summaries.every((summary) => summary.mode === "partial"), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("appending to a legacy summary does not claim a complete phase breakdown", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-observability-legacy-summary-"));
  const sessionId = "legacy-summary";
  try {
    const summaryDir = join(stateDir, "tokenpilot", "module-observability", "sessions");
    await mkdir(summaryDir, { recursive: true });
    const emptyLegacyModule = {
      observed: false,
      enabled: false,
      executions: 0,
      changes: 0,
      skips: 0,
      savedChars: 0,
      savedTokens: 0,
      apiInputTokens: 0,
      apiOutputTokens: 0,
      latestAt: "",
    };
    await writeFile(join(summaryDir, `${sessionId}.json`), JSON.stringify({
      sessionId,
      mode: "eviction-only",
      latestAt: "2026-07-20T00:00:00.000Z",
      modules: {
        stabilizer: { ...emptyLegacyModule, observed: true },
        reduction: { ...emptyLegacyModule, observed: true },
        eviction: {
          ...emptyLegacyModule,
          observed: true,
          enabled: true,
          executions: 4,
          changes: 1,
          latestAt: "2026-07-20T00:00:00.000Z",
        },
      },
    }), "utf8");

    await appendModuleObservation(stateDir, {
      at: "2026-07-20T00:00:01.000Z",
      sessionId,
      phase: "history",
      moduleId: "eviction",
      enabled: true,
      executed: true,
      changed: true,
      savedChars: 400,
      savedTokens: 100,
      api: { inputTokens: 0, outputTokens: 0 },
    });

    const summary = await readSessionModuleObservationSummary(stateDir, sessionId);
    assert.equal(summary?.modules.eviction.executions, 5);
    assert.equal(summary?.modules.eviction.executionsByPhase?.history, 1);
    assert.equal(summary?.modules.eviction.phaseBreakdownComplete, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent module observations preserve every aggregate update", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-observability-concurrent-"));
  const sessionId = "session-concurrent";
  try {
    await Promise.all(Array.from({ length: 20 }, (_value, index) => appendModuleObservation(stateDir, {
      at: `2026-07-20T00:00:${String(index).padStart(2, "0")}.000Z`,
      sessionId,
      phase: "request",
      moduleId: "reduction",
      enabled: true,
      executed: true,
      changed: index % 2 === 0,
      savedChars: 4,
      savedTokens: 1,
      api: { inputTokens: 2, outputTokens: 1 },
    })));

    const summary = await readSessionModuleObservationSummary(stateDir, sessionId);
    assert.equal(summary?.mode, "partial");
    assert.equal(summary?.modules.reduction.executions, 20);
    assert.equal(summary?.modules.reduction.changes, 10);
    assert.equal(summary?.modules.reduction.savedTokens, 20);
    assert.equal(summary?.modules.reduction.apiInputTokens, 40);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("encoded observation paths keep similar session ids isolated", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-observability-session-id-"));
  try {
    await Promise.all(["session/a", "session_a"].map((sessionId, index) => appendModuleObservation(stateDir, {
      at: `2026-07-20T00:00:0${index}.000Z`,
      sessionId,
      phase: "request",
      moduleId: "reduction",
      enabled: true,
      executed: true,
      changed: true,
      savedChars: 40 + index,
      savedTokens: 10 + index,
      api: { inputTokens: 0, outputTokens: 0 },
    })));

    const first = await readSessionModuleObservationSummary(stateDir, "session/a");
    const second = await readSessionModuleObservationSummary(stateDir, "session_a");
    assert.equal(first?.sessionId, "session/a");
    assert.equal(first?.modules.reduction.savedTokens, 10);
    assert.equal(second?.sessionId, "session_a");
    assert.equal(second?.modules.reduction.savedTokens, 11);
    const summaryFiles = await readdir(join(stateDir, "tokenpilot", "module-observability", "sessions"));
    assert.equal(summaryFiles.length, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
