import test from "node:test";
import assert from "node:assert/strict";

import { RuntimeModuleRegistry } from "../src/module-registry.js";
import { runHistoryModules, runRequestModules } from "../src/module-orchestrator.js";

test("request modules preserve declared order and record disabled modules", async () => {
  const order: string[] = [];
  const records = await runRequestModules({
    context: { reductionEnabled: false },
    modules: [
      {
        id: "stabilizer",
        enabled: () => true,
        run: () => order.push("stabilizer"),
      },
      {
        id: "eviction",
        enabled: () => true,
        run: () => order.push("eviction"),
      },
      {
        id: "reduction",
        enabled: (context) => context.reductionEnabled,
        run: () => order.push("reduction"),
      },
    ],
  });

  assert.deepEqual(order, ["stabilizer", "eviction"]);
  assert.deepEqual(records.map(({ id, status }) => ({ id, status })), [
    { id: "stabilizer", status: "executed" },
    { id: "eviction", status: "executed" },
    { id: "reduction", status: "skipped" },
  ]);
});

test("history modules isolate opted-in failures", async () => {
  const order: string[] = [];
  const records = await runHistoryModules({
    context: {},
    modules: [
      {
        id: "sync",
        enabled: () => true,
        run: () => order.push("sync"),
      },
      {
        id: "eviction",
        enabled: () => true,
        failureMode: "isolate",
        run: () => {
          order.push("eviction");
          throw new Error("eviction failed");
        },
      },
      {
        id: "persist",
        enabled: () => true,
        run: () => order.push("persist"),
      },
    ],
  });

  assert.deepEqual(order, ["sync", "eviction", "persist"]);
  assert.equal(records[1].status, "failed");
  assert.equal(records[1].error, "eviction failed");
});

test("module execution fails fast by default", async () => {
  await assert.rejects(
    runRequestModules({
      context: {},
      modules: [
        {
          id: "stabilizer",
          enabled: () => true,
          run: () => {
            throw new Error("prefix failed");
          },
        },
      ],
    }),
    /prefix failed/,
  );
});

test("module registry reuses one instance for the same stable id and version", () => {
  const registry = new RuntimeModuleRegistry();
  const first = { name: "eviction-first" };
  const second = { name: "eviction-second" };

  assert.equal(registry.register({ id: "eviction", version: "1", instance: first }), first);
  assert.equal(registry.register({ id: "eviction", version: "1", instance: second }), first);
  assert.equal(registry.list().length, 1);
});

test("module registry rejects incompatible versions for the same stable id", () => {
  const registry = new RuntimeModuleRegistry();
  registry.register({ id: "eviction", version: "1", instance: {} });

  assert.throws(
    () => registry.register({ id: "eviction", version: "2", instance: {} }),
    /module_registry_version_conflict:eviction:1:2/,
  );
});
