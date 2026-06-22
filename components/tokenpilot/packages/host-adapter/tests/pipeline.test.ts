import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { HostRequestEnvelope } from "../src/model/host-request.js";
import { prepareBeforeCall } from "../src/pipeline/before-call.js";
import { runBeforeCallReductionOrchestrator } from "../src/pipeline/reduction-orchestrator.js";
import { stripInternalPayloadFields } from "../src/pipeline/recovery.js";
import { prependTextToContent } from "../src/pipeline/message-text.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readJsonFixture<T>(name: string): Promise<T> {
  const raw = await readFile(join(__dirname, "fixtures", name), "utf8");
  return JSON.parse(raw) as T;
}

test("prepareBeforeCall preserves envelope shape while applying host-pipeline transforms", async () => {
  const input = await readJsonFixture<HostRequestEnvelope>("before-call-input.json");
  const expected = await readJsonFixture<HostRequestEnvelope>("before-call-expected.json");

  const result = await prepareBeforeCall({
    envelope: input,
    config: { mode: "normal" },
    helpers: {
      prepareStablePrefix(envelope) {
        return {
          ...envelope,
          messages: envelope.messages.map((message, index) => (
            index === 0 && typeof message.content === "string"
              ? { ...message, content: `[Stable Prefix Applied] ${message.content}` }
              : message
          )),
        };
      },
      injectRecoveryProtocol(envelope) {
        return {
          ...envelope,
          instructions: `${envelope.instructions ?? ""}\n\n[Recovery Protocol]`.trim(),
        };
      },
      applyBeforeCallReduction(envelope) {
        return {
          ...envelope,
          messages: envelope.messages.map((message, index) => (
            index === 0 && typeof message.content === "string"
              ? { ...message, content: `${message.content} [Reduced]` }
              : message
          )),
        };
      },
    },
  });

  assert.deepEqual(result.envelope, expected);
  assert.deepEqual(result.diagnostics, {
    stablePrefixApplied: true,
    recoveryInjected: true,
    reductionApplied: true,
    notes: ["mode=normal"],
  });
});

test("prepareBeforeCall default pipeline canonicalizes root prompt and injects recovery protocol", async () => {
  const input = await readJsonFixture<HostRequestEnvelope>("before-call-default-input.json");
  const expected = await readJsonFixture<HostRequestEnvelope>("before-call-default-expected.json");

  const result = await prepareBeforeCall({
    envelope: input,
    config: { mode: "normal" },
  });

  assert.deepEqual(result.envelope, expected);
  assert.deepEqual(result.diagnostics, {
    stablePrefixApplied: true,
    recoveryInjected: true,
    reductionApplied: false,
    notes: ["mode=normal"],
  });
});

test("stripInternalPayloadFields removes internal transport markers in-place", () => {
  const payload: any = {
    __tokenpilot_reduction_applied: true,
    input: [
      { role: "user", __tokenpilot_replay_raw: true, content: "hello" },
      { role: "assistant", content: "world" },
    ],
  };

  stripInternalPayloadFields(payload, {
    topLevelKeys: ["__tokenpilot_reduction_applied"],
    inputItemKeys: ["__tokenpilot_replay_raw"],
  });

  assert.equal("__tokenpilot_reduction_applied" in payload, false);
  assert.equal("__tokenpilot_replay_raw" in payload.input[0], false);
  assert.equal(payload.input[0].content, "hello");
  assert.equal(payload.input[1].content, "world");
});

test("runBeforeCallReductionOrchestrator returns skipped result in pure-forward mode", async () => {
  let policyOnlyCalls = 0;
  let reductionCalls = 0;

  const result = await runBeforeCallReductionOrchestrator(
    {
      async runPolicyWithoutReduction() {
        policyOnlyCalls += 1;
      },
      async runReduction() {
        reductionCalls += 1;
        return {
          changedItems: 99,
          changedBlocks: 99,
          savedChars: 99,
        };
      },
    },
    {
      rawPayload: { input: [{ role: "user", content: "hello" }] },
      sessionId: "session-3",
      triggerMinChars: 2200,
      maxToolChars: 1200,
      proxyPureForward: true,
      reductionEnabled: true,
    },
  );

  assert.equal(policyOnlyCalls, 1);
  assert.equal(reductionCalls, 0);
  assert.equal(result.changedItems, 0);
  assert.equal(String(result.diagnostics?.skippedReason), "proxy_pure_forward");
});

test("runBeforeCallReductionOrchestrator executes reduction when enabled", async () => {
  let policyOnlyCalls = 0;
  let reductionCalls = 0;

  const result = await runBeforeCallReductionOrchestrator(
    {
      async runPolicyWithoutReduction() {
        policyOnlyCalls += 1;
      },
      async runReduction() {
        reductionCalls += 1;
        return {
          changedItems: 2,
          changedBlocks: 3,
          savedChars: 400,
          diagnostics: {
            skippedReason: "none",
          },
        };
      },
    },
    {
      rawPayload: { input: [{ role: "tool", content: "huge" }] },
      sessionId: "session-4",
      triggerMinChars: 2200,
      maxToolChars: 1200,
      proxyPureForward: false,
      reductionEnabled: true,
    },
  );

  assert.equal(policyOnlyCalls, 0);
  assert.equal(reductionCalls, 1);
  assert.equal(result.changedItems, 2);
  assert.equal(result.changedBlocks, 3);
  assert.equal(result.savedChars, 400);
});

test("prependTextToContent inserts input_text block when content array has no writable text fields", () => {
  const content = [
    { type: "input_image", image_url: "https://example.com/demo.png" },
    { type: "input_file", file_id: "file-123" },
  ];

  const result = prependTextToContent(content, "dynamic context");

  assert.deepEqual(result, [
    { type: "input_text", text: "dynamic context" },
    { type: "input_image", image_url: "https://example.com/demo.png" },
    { type: "input_file", file_id: "file-123" },
  ]);
});
