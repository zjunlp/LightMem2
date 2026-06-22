import test from "node:test";
import assert from "node:assert/strict";

import type { ContextSegment, RuntimeTurnContext } from "@tokenpilot/kernel";
import { classifyReadStates } from "../src/reduction/read-state-compaction.js";
import { readStateCompactionPass } from "../src/passes/pass-read-state-compaction.js";
import { resolveReductionPasses, runReductionBeforeCall } from "../src/reduction/pipeline.js";

function buildSegment(
  id: string,
  toolName: string,
  path: string,
  text: string,
  fieldName?: string,
  readWindow?: { offset?: number; limit?: number },
): ContextSegment {
  return {
    id,
    kind: "volatile",
    priority: 1,
    text,
    metadata: {
      toolName,
      path,
      ...(fieldName ? { fieldName } : {}),
      ...(readWindow ? { readWindow } : {}),
      toolPayload: {
        toolName,
        path,
        ...(readWindow ? { readWindow } : {}),
      },
    },
  };
}

test("classifyReadStates marks latest untouched read as fresh", () => {
  const states = classifyReadStates([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;", "output"),
  ]);

  assert.equal(states.get("read-1-output"), "fresh");
});

test("classifyReadStates marks earlier read as superseded when re-read later", () => {
  const states = classifyReadStates([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;", "output"),
    buildSegment("read-2-output", "read", "/repo/a.ts", "const a = 1;\nconst b = 2;", "output"),
  ]);

  assert.equal(states.get("read-1-output"), "superseded");
  assert.equal(states.get("read-2-output"), "fresh");
});

test("classifyReadStates does not mark different read windows as superseded", () => {
  const states = classifyReadStates([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;", "output", { offset: 1, limit: 200 }),
    buildSegment("read-2-output", "read", "/repo/a.ts", "const z = 26;", "output", { offset: 201, limit: 200 }),
  ]);

  assert.equal(states.get("read-1-output"), "fresh");
  assert.equal(states.get("read-2-output"), "fresh");
});

test("classifyReadStates marks read as stale when file is edited later", () => {
  const states = classifyReadStates([
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;", "output"),
    buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
  ]);

  assert.equal(states.get("read-1-output"), "stale");
});

test("classifyReadStates ignores non-output read argument segments", () => {
  const states = classifyReadStates([
    buildSegment("read-1-arguments", "read", "/repo/a.ts", "{\"path\":\"/repo/a.ts\"}", "arguments"),
    buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;", "output"),
  ]);

  assert.equal(states.has("read-1-arguments"), false);
  assert.equal(states.get("read-1-output"), "fresh");
});

test("readStateCompactionPass replaces superseded reads with state stub", async () => {
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(200), "output"),
      buildSegment("read-2-output", "read", "/repo/a.ts", "const a = 2;\n".repeat(80), "output"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "read_state_compaction",
                segmentIds: ["read-1-output"],
              },
            ],
          },
        },
      },
    },
  };

  const result = await readStateCompactionPass.beforeCall?.({
    turnCtx,
    spec: {
      id: "read_state_compaction",
      phase: "before_call",
      target: "context_segment",
      options: {},
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, true);
  assert.deepEqual(result?.touchedSegmentIds, ["read-1-output"]);
  const updated = result?.turnCtx?.segments.find((segment) => segment.id === "read-1-output");
  assert.ok(updated);
  assert.match(updated?.text ?? "", /\[Read superseded\]/);
  assert.match(updated?.text ?? "", /memory_fault_recover/);
});

test("readStateCompactionPass replaces stale reads with state stub", async () => {
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(200), "output"),
      buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "read_state_compaction",
                segmentIds: ["read-1-output"],
              },
            ],
          },
        },
      },
    },
  };

  const result = await readStateCompactionPass.beforeCall?.({
    turnCtx,
    spec: {
      id: "read_state_compaction",
      phase: "before_call",
      target: "context_segment",
      options: {},
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, true);
  assert.deepEqual(result?.touchedSegmentIds, ["read-1-output"]);
  const updated = result?.turnCtx?.segments.find((segment) => segment.id === "read-1-output");
  assert.ok(updated);
  assert.match(updated?.text ?? "", /\[Read stale\]/);
  assert.match(updated?.text ?? "", /modified later/);
});

test("readStateCompactionPass leaves fresh reads untouched", async () => {
  const original = "const a = 1;\n".repeat(20);
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", original, "output"),
    ],
  };

  const result = await readStateCompactionPass.beforeCall?.({
    turnCtx,
    spec: {
      id: "read_state_compaction",
      phase: "before_call",
      target: "context_segment",
      options: {},
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, false);
  assert.equal(result?.skippedReason, "no_policy_instructions");
});

test("readStateCompactionPass skips when policy does not nominate segments", async () => {
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(200), "output"),
      buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [],
          },
        },
      },
    },
  };

  const result = await readStateCompactionPass.beforeCall?.({
    turnCtx,
    spec: {
      id: "read_state_compaction",
      phase: "before_call",
      target: "context_segment",
      options: {},
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, false);
  assert.equal(result?.skippedReason, "no_policy_instructions");
});

test("resolveReductionPasses includes read_state_compaction before tool_payload_trim", () => {
  const passes = resolveReductionPasses();
  const compactionIndex = passes.findIndex((pass) => pass.id === "read_state_compaction");
  const trimIndex = passes.findIndex((pass) => pass.id === "tool_payload_trim");
  assert.ok(compactionIndex >= 0);
  assert.ok(trimIndex >= 0);
  assert.ok(compactionIndex < trimIndex);
});

test("runReductionBeforeCall executes read_state_compaction and rewrites stale reads", async () => {
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(200), "output"),
      buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "read_state_compaction",
                segmentIds: ["read-1-output"],
              },
            ],
          },
        },
      },
    },
  };

  const passes = resolveReductionPasses({
    passes: [
      {
        id: "read_state_compaction",
        phase: "before_call",
        target: "context_segment",
        options: {},
      },
    ],
  });

  const result = await runReductionBeforeCall({
    turnCtx,
    passes,
  });

  const updated = result.turnCtx.segments.find((segment) => segment.id === "read-1-output");
  assert.ok(updated);
  assert.match(updated?.text ?? "", /\[Read stale\]/);
  assert.equal(result.report.length, 1);
  assert.equal(result.report[0]?.id, "read_state_compaction");
  assert.equal(result.report[0]?.changed, true);
});

test("runReductionBeforeCall leaves non-nominated stale reads untouched", async () => {
  const original = "const a = 1;\n".repeat(200);
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", original, "output"),
      buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "read_state_compaction",
                segmentIds: ["some-other-segment"],
              },
            ],
          },
        },
      },
    },
  };

  const result = await runReductionBeforeCall({
    turnCtx,
    passes: [
      {
        id: "read_state_compaction",
        phase: "before_call",
        target: "context_segment",
        options: {},
      },
    ],
  });

  const updated = result.turnCtx.segments.find((segment) => segment.id === "read-1-output");
  assert.ok(updated);
  assert.equal(updated?.text, original);
  assert.equal(result.report.length, 1);
  assert.equal(result.report[0]?.id, "read_state_compaction");
  assert.equal(result.report[0]?.changed, false);
  assert.equal(result.report[0]?.skippedReason, "no_segments_replaced");
});

test("runReductionBeforeCall continues after disabled pass and still executes later passes", async () => {
  const turnCtx: RuntimeTurnContext = {
    sessionId: "test-session",
    sessionMode: "single",
    provider: "test",
    model: "test",
    prompt: "",
    budget: {
      maxInputTokens: 100000,
      reserveOutputTokens: 1000,
    },
    segments: [
      buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(200), "output"),
      buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "read_state_compaction",
                segmentIds: ["read-1-output"],
              },
            ],
          },
        },
      },
    },
  };

  const result = await runReductionBeforeCall({
    turnCtx,
    passes: [
      {
        id: "tool_payload_trim",
        phase: "before_call",
        target: "tool_payload",
        enabled: false,
      },
      {
        id: "read_state_compaction",
        phase: "before_call",
        target: "context_segment",
        options: {},
      },
    ],
  });

  const updated = result.turnCtx.segments.find((segment) => segment.id === "read-1-output");
  assert.ok(updated);
  assert.match(updated?.text ?? "", /\[Read stale\]/);
  assert.equal(result.report.length, 2);
  assert.equal(result.report[0]?.id, "tool_payload_trim");
  assert.equal(result.report[0]?.changed, false);
  assert.equal(result.report[0]?.skippedReason, "disabled");
  assert.equal(result.report[1]?.id, "read_state_compaction");
  assert.equal(result.report[1]?.changed, true);
});
