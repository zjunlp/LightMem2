import test from "node:test";
import assert from "node:assert/strict";

import type { ContextSegment, RuntimeTurnContext } from "@lightmem2/kernel";
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
  assert.equal(
    ((updated?.metadata as Record<string, unknown> | undefined)?.recovery as Record<string, unknown> | undefined)?.skipReduction,
    true,
  );
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
  assert.equal(
    ((updated?.metadata as Record<string, unknown> | undefined)?.recovery as Record<string, unknown> | undefined)?.skipReduction,
    true,
  );
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

test("runReductionBeforeCall does not retrim read-state compaction recovery stubs", async () => {
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
      buildSegment("read-1-output", "read", "/repo/a.ts", "const a = 1;\n".repeat(220), "output"),
      buildSegment("edit-1-arguments", "edit", "/repo/a.ts", "{\"replace\":\"1\",\"with\":\"2\"}", "arguments"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      latestUserQuery: "show me the latest file state",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "read_state_compaction",
                segmentIds: ["read-1-output"],
              },
              {
                strategy: "tool_payload_trim",
                segmentIds: ["read-1-output"],
                parameters: {
                  payloadKind: "stdout",
                },
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
      {
        id: "tool_payload_trim",
        phase: "before_call",
        target: "tool_payload",
        options: {
          maxChars: 220,
        },
      },
    ],
  });

  const updated = result.turnCtx.segments.find((segment) => segment.id === "read-1-output");
  assert.ok(updated);
  assert.match(updated?.text ?? "", /\[Read stale\]/);
  assert.match(updated?.text ?? "", /memory_fault_recover/);
  assert.equal(result.report.length, 2);
  assert.equal(result.report[0]?.id, "read_state_compaction");
  assert.equal(result.report[0]?.changed, true);
  assert.equal(result.report[1]?.id, "tool_payload_trim");
  assert.equal(result.report[1]?.changed, false);
  assert.equal(result.report[1]?.skippedReason, "recovery_exempt");
});

test("runReductionBeforeCall preserves recovery reads while still trimming neighboring segments", async () => {
  const recovered = [
    "[Memory Fault Recovery] Recovered content for: repo:README.md",
    "Recovered lines: 20-40",
    "--- Recovered Content ---",
    "# Task Plan",
    "- TODO: preserve this recovered block",
    "- Acceptance criteria: no retrim",
    "--- End Recovered Content ---",
  ].join("\n");
  const oversizedToolOutput = JSON.stringify(
    Array.from({ length: 20 }, (_value, index) => ({
      type: "result",
      id: index,
      text: `payload-${index}-${"x".repeat(80)}`,
    })),
    null,
    2,
  );

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
      {
        id: "recovery-output",
        kind: "volatile",
        priority: 1,
        text: recovered,
        metadata: {
          toolName: "read",
          path: "/repo/README.md",
          fieldName: "output",
          recovery: {
            source: "memory_fault_recover",
            skipReduction: true,
          },
          toolPayload: {
            toolName: "read",
            path: "/repo/README.md",
          },
        },
      },
      {
        id: "json-output",
        kind: "volatile",
        priority: 1,
        text: oversizedToolOutput,
        metadata: {
          toolName: "bash",
          path: "/tmp/output.json",
          fieldName: "output",
          toolPayload: {
            toolName: "bash",
            path: "/tmp/output.json",
          },
        },
      },
    ],
    metadata: {
      workspaceDir: "/tmp",
      latestUserQuery: "show me the recovered file and summarize the json output",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["recovery-output", "json-output"],
                parameters: {
                  payloadKind: "stdout",
                },
              },
            ],
          },
        },
      },
    },
  };

  const result = await runReductionBeforeCall({
    turnCtx,
    passes: resolveReductionPasses({
      maxToolChars: 160,
    }),
  });

  const recoverySegment = result.turnCtx.segments.find((segment) => segment.id === "recovery-output");
  const jsonSegment = result.turnCtx.segments.find((segment) => segment.id === "json-output");
  assert.ok(recoverySegment);
  assert.ok(jsonSegment);
  assert.equal(recoverySegment?.text, recovered);
  assert.notEqual(jsonSegment?.text, oversizedToolOutput);
  assert.match(jsonSegment?.text ?? "", /"reduced": "json_array"/);
  assert.equal(result.report[1]?.id, "tool_payload_trim");
  assert.equal(result.report[1]?.changed, true);
  assert.deepEqual(result.report[1]?.touchedSegmentIds, ["json-output"]);
});

test("runReductionBeforeCall outlines the first large code read and leaves the second read intact", async () => {
  const largeCode = `
export function loadConfig(file: string) {
  return file.trim();
}

export function saveConfig(file: string, text: string) {
  return text + file;
}
`.repeat(30);

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
      buildSegment("read-1-output", "read", "/repo/config.ts", largeCode, "output"),
      buildSegment("read-2-output", "read", "/repo/config.ts", largeCode, "output"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["read-1-output", "read-2-output"],
                parameters: { payloadKind: "stdout" },
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
        target: "context_segment",
        options: {},
      },
    ],
  });

  const first = result.turnCtx.segments.find((segment) => segment.id === "read-1-output");
  const second = result.turnCtx.segments.find((segment) => segment.id === "read-2-output");
  assert.ok(first);
  assert.ok(second);
  assert.match(first?.text ?? "", /\[code outlined lines=/);
  assert.match(first?.text ?? "", /body elided by LightMem2/);
  assert.match(second?.text ?? "", /export function loadConfig/);
  assert.doesNotMatch(second?.text ?? "", /\[code outlined lines=/);
});

test("runReductionBeforeCall carries disclosed read paths through metadata across turns", async () => {
  const largeCode = `
export function loadConfig(file: string) {
  return file.trim();
}

export function saveConfig(file: string, text: string) {
  return text + file;
}
`.repeat(30);

  const firstTurn: RuntimeTurnContext = {
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
      buildSegment("read-1-output", "read", "/repo/config.ts", largeCode, "output"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["read-1-output"],
                parameters: { payloadKind: "stdout" },
              },
            ],
          },
        },
      },
    },
  };

  const firstResult = await runReductionBeforeCall({
    turnCtx: firstTurn,
    passes: [
      {
        id: "tool_payload_trim",
        phase: "before_call",
        target: "context_segment",
        options: {},
      },
    ],
  });

  const disclosedReadPaths = firstResult.turnCtx.metadata?.disclosedReadPaths;
  assert.ok(Array.isArray(disclosedReadPaths));
  assert.ok(disclosedReadPaths?.includes("/repo/config.ts".toLowerCase()));

  const secondTurn: RuntimeTurnContext = {
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
      buildSegment("read-2-output", "read", "/repo/config.ts", largeCode, "output"),
    ],
    metadata: {
      workspaceDir: "/tmp",
      disclosedReadPaths,
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["read-2-output"],
                parameters: { payloadKind: "stdout" },
              },
            ],
          },
        },
      },
    },
  };

  const secondResult = await runReductionBeforeCall({
    turnCtx: secondTurn,
    passes: [
      {
        id: "tool_payload_trim",
        phase: "before_call",
        target: "context_segment",
        options: {},
      },
    ],
  });

  const second = secondResult.turnCtx.segments.find((segment) => segment.id === "read-2-output");
  assert.ok(second);
  assert.match(second?.text ?? "", /export function loadConfig/);
  assert.doesNotMatch(second?.text ?? "", /\[code outlined lines=/);
});
