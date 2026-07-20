import test from "node:test";
import assert from "node:assert/strict";

import type { RuntimeTurnContext } from "@tokenpilot/kernel";
import { toolPayloadTrimPass } from "../src/passes/pass-tool-payload-trim.js";

function buildTurnContext(text: string, metadata?: Record<string, unknown>): RuntimeTurnContext {
  return {
    sessionId: "recovery-session",
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
        id: "tool-1-output",
        kind: "volatile",
        priority: 1,
        text,
        metadata: {
          toolName: "read",
          path: "/repo/file.ts",
          fieldName: "output",
          toolPayload: {
            toolName: "read",
            path: "/repo/file.ts",
          },
          ...metadata,
        },
      },
    ],
    metadata: {
      workspaceDir: "/tmp",
      latestUserQuery: "show me the recovered file",
      policy: {
        decisions: {
          reduction: {
            instructions: [
              {
                strategy: "tool_payload_trim",
                segmentIds: ["tool-1-output"],
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
}

test("toolPayloadTrimPass does not retrim memory fault recovery text", async () => {
  const recovered = [
    "[Memory Fault Recovery] Recovered content for: repo:file.ts",
    "Original tool: read",
    "--- Recovered Content ---",
    ...Array.from({ length: 260 }, (_, i) => `line ${i}: const value = ${i};`),
    "--- End Recovered Content ---",
  ].join("\n");

  const result = await toolPayloadTrimPass.beforeCall?.({
    turnCtx: buildTurnContext(recovered),
    spec: {
      id: "tool_payload_trim",
      phase: "before_call",
      target: "tool_payload",
      options: {
        maxChars: 300,
      },
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, false);
  assert.equal(result?.skippedReason, "recovery_exempt");
});

test("toolPayloadTrimPass respects recovery skip marker for line-range excerpts", async () => {
  const recoveredExcerpt = [
    "Recovered excerpt for repo:file.ts lines 20-60",
    "20: export function example() {",
    ...Array.from({ length: 120 }, (_, i) => `${i + 21}:   const value${i} = ${i};`),
    "61: }",
  ].join("\n");

  const result = await toolPayloadTrimPass.beforeCall?.({
    turnCtx: buildTurnContext(recoveredExcerpt, {
      recovery: {
        source: "memory_fault_recover",
        skipReduction: true,
      },
    }),
    spec: {
      id: "tool_payload_trim",
      phase: "before_call",
      target: "tool_payload",
      options: {
        maxChars: 300,
      },
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, false);
  assert.equal(result?.skippedReason, "recovery_exempt");
});

test("toolPayloadTrimPass keeps markdown-shaped recovery output exempt from retrim", async () => {
  const recovered = [
    "[Memory Fault Recovery] Recovered content for: repo:README.md",
    "Recovered lines: 20-40",
    "--- Recovered Content ---",
    "# Task Plan",
    "- TODO: keep this focused window intact",
    "- Acceptance criteria: do not retrim recovery output",
    "--- End Recovered Content ---",
  ].join("\n");

  const result = await toolPayloadTrimPass.beforeCall?.({
    turnCtx: buildTurnContext(recovered, {
      path: "/repo/README.md",
      recovery: {
        source: "memory_fault_recover",
        skipReduction: true,
      },
    }),
    spec: {
      id: "tool_payload_trim",
      phase: "before_call",
      target: "tool_payload",
      options: {
        maxChars: 120,
      },
    },
  });

  assert.ok(result);
  assert.equal(result?.changed, false);
  assert.equal(result?.skippedReason, "recovery_exempt");
});
