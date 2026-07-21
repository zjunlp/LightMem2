import test from "node:test";
import assert from "node:assert/strict";

import { runHistoryModules, runRequestModules } from "./module-orchestrator.js";

test("request orchestrator preserves declared module order and skips disabled modules", async () => {
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

test("history orchestrator isolates opted-in module failures", async () => {
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

test("orchestrator fails fast by default", async () => {
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
