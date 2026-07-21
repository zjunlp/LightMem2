import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MODULE_COMBINATIONS,
  buildModuleCombinationConfig,
  createModuleEffectRecorder,
  diffStateDirectories,
  diffPayload,
  snapshotStateDirectory,
} from "./module-combination-test-support.js";

test("module combinations cover the complete three-feature matrix", () => {
  assert.equal(MODULE_COMBINATIONS.length, 8);
  assert.equal(
    new Set(MODULE_COMBINATIONS.map(({ enablement }) => JSON.stringify(enablement))).size,
    8,
  );

  const evictionOnly = MODULE_COMBINATIONS.find(({ id }) => id === "eviction-only");
  assert.deepEqual(
    buildModuleCombinationConfig(evictionOnly!.enablement),
    {
      modules: {
        stabilizer: false,
        policy: true,
        reduction: false,
        eviction: true,
      },
      eviction: {
        enabled: true,
      },
    },
  );
});

test("payload diff records nested request field changes", () => {
  const changes = diffPayload(
    {
      input: [{ role: "user", content: "before" }],
      prompt_cache_key: "inbound-key",
      tools: [{ name: "z_tool" }],
    },
    {
      input: [{ role: "user", content: "after" }, { role: "developer", content: "dynamic" }],
      tools: [{ name: "a_tool" }],
    },
  );

  assert.deepEqual(changes, [
    {
      path: "input[0].content",
      kind: "changed",
      before: "before",
      after: "after",
    },
    {
      path: "input[1]",
      kind: "added",
      after: { role: "developer", content: "dynamic" },
    },
    {
      path: "prompt_cache_key",
      kind: "removed",
      before: "inbound-key",
    },
    {
      path: "tools[0].name",
      kind: "changed",
      before: "z_tool",
      after: "a_tool",
    },
  ]);
});

test("state directory snapshots identify created, modified, and deleted files", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-module-effects-"));
  try {
    await mkdir(join(stateDir, "visual"), { recursive: true });
    await writeFile(join(stateDir, "trace.jsonl"), "{\"stage\":\"before\"}\n", "utf8");
    await writeFile(join(stateDir, "visual", "stability.jsonl"), "stable-before\n", "utf8");
    const before = await snapshotStateDirectory(stateDir);

    await writeFile(join(stateDir, "trace.jsonl"), "{\"stage\":\"after\"}\n", "utf8");
    await rm(join(stateDir, "visual", "stability.jsonl"));
    await writeFile(join(stateDir, "visual", "eviction.jsonl"), "evicted\n", "utf8");
    const after = await snapshotStateDirectory(stateDir);

    const changes = diffStateDirectories(before, after);
    assert.deepEqual(
      changes.map(({ path, kind }) => ({ path, kind })),
      [
        { path: "trace.jsonl", kind: "modified" },
        { path: "visual/eviction.jsonl", kind: "created" },
        { path: "visual/stability.jsonl", kind: "deleted" },
      ],
    );
    assert.equal(changes[0].before?.text, "{\"stage\":\"before\"}\n");
    assert.equal(changes[0].after?.text, "{\"stage\":\"after\"}\n");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("module effect recorder keeps side effects and accounting isolated", () => {
  const recorder = createModuleEffectRecorder();

  recorder.recordStateWrite("eviction", "task-registry.json", { version: 2 });
  recorder.recordTrace("eviction", "estimator", { attempted: true });
  recorder.recordEvent("eviction", "eviction-applied", { taskIds: ["task-1"] });
  recorder.recordVisualSnapshot("eviction", "history-diff", { removed: 3 });
  recorder.recordAccounting("eviction", { savedTokens: 1200, costTokens: 80, costUsd: 0.01 });
  recorder.recordAccounting("eviction", { savedTokens: 300, costTokens: 20, costUsd: 0.002 });

  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.stabilizer, {
    stateWrites: [],
    traces: [],
    events: [],
    visualSnapshots: [],
    accounting: { savedTokens: 0, costTokens: 0, costUsd: 0 },
  });
  assert.deepEqual(snapshot.reduction, snapshot.stabilizer);
  assert.deepEqual(snapshot.eviction, {
    stateWrites: [{ path: "task-registry.json", value: { version: 2 } }],
    traces: [{ name: "estimator", payload: { attempted: true } }],
    events: [{ name: "eviction-applied", payload: { taskIds: ["task-1"] } }],
    visualSnapshots: [{ name: "history-diff", payload: { removed: 3 } }],
    accounting: { savedTokens: 1500, costTokens: 100, costUsd: 0.012 },
  });
});
