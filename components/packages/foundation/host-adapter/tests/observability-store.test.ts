import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEventTrace,
  readLatestUxEffect,
  readUxSessionAggregate,
  recordUxEffect,
} from "../src/index.js";

test("shared trace store appends timestamped event records", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-host-trace-store-"));
  try {
    await appendEventTrace(stateDir, {
      stage: "proxy_before_call",
      sessionId: "session-trace-a",
      model: "test-model",
    });

    const raw = await readFile(join(stateDir, "event-trace.jsonl"), "utf8");
    const [line] = raw.trim().split("\n");
    const parsed = JSON.parse(line) as {
      at?: string;
      stage?: string;
      sessionId?: string;
      model?: string;
    };

    assert.equal(parsed.stage, "proxy_before_call");
    assert.equal(parsed.sessionId, "session-trace-a");
    assert.equal(parsed.model, "test-model");
    assert.equal(typeof parsed.at, "string");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("shared ux store records latest effect and session aggregate", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-host-ux-store-"));
  try {
    await recordUxEffect(stateDir, {
      at: "2026-06-28T12:10:00.000Z",
      sessionId: "session-ux-a",
      model: "test-model",
      countMode: "chars",
      beforeCount: 1200,
      afterCount: 700,
      savedCount: 500,
      details: {
        requestSavedCount: 500,
      },
    });
    await recordUxEffect(stateDir, {
      at: "2026-06-28T12:11:00.000Z",
      sessionId: "session-ux-a",
      model: "test-model",
      countMode: "chars",
      beforeCount: 900,
      afterCount: 600,
      savedCount: 300,
    });

    const latest = await readLatestUxEffect(stateDir);
    const aggregate = await readUxSessionAggregate(stateDir, "session-ux-a");

    assert.equal(latest?.savedCount, 300);
    assert.equal(aggregate?.turns, 2);
    assert.equal(aggregate?.charSavedCount, 800);
    assert.equal(aggregate?.charOptimizedTurns, 2);
    assert.equal(aggregate?.avgSavedCharsPerOptimizedTurn, 400);
    assert.equal(aggregate?.latestAt, "2026-06-28T12:11:00.000Z");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("shared ux store keeps token and char aggregates independently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-host-ux-store-mixed-"));
  try {
    await recordUxEffect(stateDir, {
      at: "2026-06-28T12:10:00.000Z",
      sessionId: "session-ux-mixed",
      model: "test-model",
      countMode: "chars",
      beforeCount: 1000,
      afterCount: 700,
      savedCount: 300,
    });
    await recordUxEffect(stateDir, {
      at: "2026-06-28T12:11:00.000Z",
      sessionId: "session-ux-mixed",
      model: "test-model",
      countMode: "openai_tokens",
      beforeCount: 800,
      afterCount: 650,
      savedCount: 150,
    });

    const latest = await readLatestUxEffect(stateDir);
    const aggregate = await readUxSessionAggregate(stateDir, "session-ux-mixed");

    assert.equal(latest?.countMode, "openai_tokens");
    assert.equal(aggregate?.turns, 2);
    assert.equal(aggregate?.latestCountMode, "openai_tokens");
    assert.equal(aggregate?.charOptimizedTurns, 1);
    assert.equal(aggregate?.charSavedCount, 300);
    assert.equal(aggregate?.avgSavedCharsPerOptimizedTurn, 300);
    assert.equal(aggregate?.tokenOptimizedTurns, 1);
    assert.equal(aggregate?.tokenSavedCount, 150);
    assert.equal(aggregate?.avgSavedTokensPerOptimizedTurn, 150);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
