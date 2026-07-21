import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeEvictionFromTaskRegistry,
  computeClosureDeferredTaskInfo,
} from "../src/index.js";

test("registry-driven planning selects blocks owned by evictable tasks", () => {
  const decision = analyzeEvictionFromTaskRegistry(
    [
      {
        blockId: "block-1",
        blockType: "task",
        segmentIds: ["message-1"],
        turnAbsIds: ["session:t1"],
        taskIds: ["task-1"],
        charCount: 1200,
        approxTokens: 300,
        lifecycleState: "EVICTABLE",
      },
    ] as any,
    {
      evictableTaskIds: ["task-1"],
      turnToTaskIds: { "session:t1": ["task-1"] },
      blockToTaskIds: { "block-1": ["task-1"] },
    } as any,
    { enabled: true, policy: "model_scored", minBlockChars: 256 },
  );

  assert.equal(decision.instructions.length, 1);
  assert.equal(decision.instructions[0]?.blockId, "block-1");
  assert.deepEqual(decision.instructions[0]?.parameters?.taskIds, ["task-1"]);
  assert.equal(decision.estimatedSavedChars, 1200);
});

test("history apply defers tasks with incomplete tool-call closure", () => {
  const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  const messages = [
    {
      details: { contextSafe: { taskIds: ["task-1"] } },
      content: [{ type: "tool_call", id: "call-1" }],
    },
  ];

  const result = computeClosureDeferredTaskInfo(
    messages,
    new Set(["task-1"]),
    {
      asRecord,
      canonicalMessageTaskIds: (message) => {
        const details = asRecord(message.details);
        const contextSafe = asRecord(details?.contextSafe);
        return Array.isArray(contextSafe?.taskIds) ? contextSafe.taskIds as string[] : [];
      },
      isToolResultLikeMessage: () => false,
      messageToolCallId: () => undefined,
    },
  );

  assert.deepEqual([...result.deferredTaskIds], ["task-1"]);
  assert.deepEqual(result.deferredByTaskId["task-1"], [
    { callId: "call-1", reason: "missing_result" },
  ]);
});
