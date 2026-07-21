import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { HostRequestEnvelope } from "../src/model/host-request.js";
import { prepareBeforeCall } from "../src/pipeline/before-call.js";
import { prepareBeforeCallWithReductionSummary } from "../src/pipeline/before-call-shared.js";
import { runBeforeCallReductionOrchestrator } from "../src/pipeline/reduction-orchestrator.js";
import { stripInternalPayloadFields } from "../src/pipeline/recovery.js";
import {
  applyStablePrefixToInstructions,
  applyStablePrefixToMessage,
  auditStablePrefixEntropy,
  canonicalizeTools,
  diffStablePrefixSerialized,
  extractStablePrefixContract,
  fingerprintStablePrefixEnvelope,
  normalizeStablePrefixText,
  prependTextToContent,
  rewriteTextForStablePrefix,
  serializeStablePrefixEnvelope,
  type SerializedStablePrefixContract,
} from "@tokenpilot/stabilizer";

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

test("prepareBeforeCallWithReductionSummary returns transformed envelope and captured reduction summary", async () => {
  const input = await readJsonFixture<HostRequestEnvelope>("before-call-input.json");
  const result = await prepareBeforeCallWithReductionSummary<{ savedChars: number }>({
    envelope: input,
    codec: {
      decodeRequest(rawPayload) {
        return rawPayload as HostRequestEnvelope;
      },
      encodeRequest(envelope) {
        return envelope;
      },
      decodeResponse(rawResponse) {
        return rawResponse as any;
      },
      encodeResponse(envelope) {
        return envelope;
      },
    },
    config: { mode: "normal" },
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
    async applyBeforeCallReduction({ envelope }) {
      return {
        envelope: {
          ...envelope,
          messages: envelope.messages.map((message, index) => (
            index === 0 && typeof message.content === "string"
              ? { ...message, content: `${message.content} [Reduced]` }
              : message
          )),
        },
        summary: { savedChars: 321 },
      };
    },
  });

  assert.equal(result.diagnostics.stablePrefixApplied, true);
  assert.equal(result.diagnostics.reductionApplied, true);
  assert.equal(result.reductionSummary?.savedChars, 321);
  assert.match(String(result.envelope.messages[0]?.content ?? ""), /\[Reduced\]/);
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
  let reductionCalls = 0;

  const result = await runBeforeCallReductionOrchestrator(
    {
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

  assert.equal(reductionCalls, 0);
  assert.equal(result.changedItems, 0);
  assert.equal(String(result.diagnostics?.skippedReason), "proxy_pure_forward");
});

test("runBeforeCallReductionOrchestrator executes reduction when enabled", async () => {
  let reductionCalls = 0;

  const result = await runBeforeCallReductionOrchestrator(
    {
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

test("applyStablePrefixToInstructions rewrites instructions and injects dynamic context into first user message", () => {
  const envelope: HostRequestEnvelope = {
    session: {
      host: { hostId: "test", displayName: "Test Host" },
      sessionId: "session-1",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
    messages: [
      { role: "user", content: "Fix the failing test." },
      { role: "assistant", content: "Looking now." },
    ],
    rawPayload: {},
  };

  const result = applyStablePrefixToInstructions({
    envelope,
    dynamicContextTarget: "user",
  });

  assert.notEqual(result, envelope);
  assert.match(String(result.instructions ?? ""), /Your working directory is: \/repo\/demo/);
  assert.match(String(result.instructions ?? ""), /agent=worker-123/);
  assert.match(String(result.messages[0]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(result.messages[0]?.content ?? ""), /AGENT_ID: worker-123/);
});

test("applyStablePrefixToInstructions can keep dynamic context inside instructions for developer-targeted hosts", () => {
  const envelope: HostRequestEnvelope = {
    session: {
      host: { hostId: "test", displayName: "Test Host" },
      sessionId: "session-2",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
    messages: [
      { role: "user", content: "Fix the failing test." },
    ],
    rawPayload: {},
  };

  const result = applyStablePrefixToInstructions({
    envelope,
    dynamicContextTarget: "developer",
    mergeDynamicContextIntoInstructions: true,
  });

  assert.notEqual(result, envelope);
  assert.match(String(result.instructions ?? ""), /Your working directory is: \/repo\/demo/);
  assert.match(String(result.instructions ?? ""), /WORKDIR: \/repo\/demo/);
  assert.equal(String(result.messages[0]?.content ?? ""), "Fix the failing test.");
});

test("applyStablePrefixToMessage rewrites root prompt and injects dynamic context into first user message", () => {
  const envelope: HostRequestEnvelope = {
    session: {
      host: { hostId: "test", displayName: "Test Host" },
      sessionId: "session-3",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    messages: [
      {
        role: "system",
        content: [
          "You are the coding agent.",
          "Your working directory is: /repo/demo",
          "Runtime: agent=worker-123 | mode=interactive",
        ].join("\n"),
      },
      { role: "user", content: "Fix the failing test." },
    ],
    rawPayload: {},
  };

  const result = applyStablePrefixToMessage({
    envelope,
    messageIndex: 0,
    dynamicContextTarget: "user",
  });

  assert.notEqual(result, envelope);
  assert.match(String(result.messages[0]?.content ?? ""), /Your working directory is: \/repo\/demo/);
  assert.match(String(result.messages[0]?.content ?? ""), /agent=worker-123/);
  assert.match(String(result.messages[1]?.content ?? ""), /WORKDIR: \/repo\/demo/);
  assert.match(String(result.messages[1]?.content ?? ""), /AGENT_ID: worker-123/);
});

test("extractStablePrefixContract separates stable core, semi-stable context, and volatile tail", () => {
  const envelope: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-4",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
    messages: [
      {
        role: "system",
        content: [
          "Project protocol:",
          "Your working directory is: /repo/demo",
          "Runtime: agent=worker-123 | mode=interactive",
        ].join("\n"),
      },
      { role: "user", content: "Fix the failing test in src/app.ts." },
      { role: "assistant", content: "Inspecting now." },
    ],
    tools: [
      { type: "function", function: { name: "b_tool", parameters: { z: 1, a: 2 } } },
      { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
    ],
    rawPayload: {},
  };

  const contract = extractStablePrefixContract(envelope);

  assert.equal(contract.stableCore.some((segment) => segment.key === "instructions"), true);
  assert.equal(contract.stableCore.some((segment) => segment.key === "messages.0"), true);
  assert.equal(contract.stableCore.some((segment) => segment.key === "tools"), true);
  assert.equal(contract.semiStableContext.some((segment) => segment.key === "model"), true);
  assert.equal(contract.semiStableContext.some((segment) => segment.key === "session.host"), true);
  assert.equal(contract.semiStableContext.some((segment) => segment.key === "instructions.dynamic_context"), true);
  assert.equal(contract.volatileTail.some((segment) => segment.key === "messages.1"), true);
  assert.equal(contract.volatileTail.some((segment) => segment.key === "messages.2"), true);
  assert.match(
    String(contract.stableCore.find((segment) => segment.key === "instructions")?.text ?? ""),
    /<WORKDIR>/,
  );
  assert.match(
    String(contract.semiStableContext.find((segment) => segment.key === "instructions.dynamic_context")?.text ?? ""),
    /WORKDIR: <WORKDIR>/,
  );
  assert.match(
    String(contract.semiStableContext.find((segment) => segment.key === "instructions.dynamic_context")?.text ?? ""),
    /AGENT_ID: <AGENT_ID>/,
  );
});

test("extractStablePrefixContract serializes tools deterministically for stable core", () => {
  const envelopeA: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-5",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { function: { parameters: { z: 1, a: 2 }, name: "tool_a" }, type: "function" },
    ],
    rawPayload: {},
  };
  const envelopeB: HostRequestEnvelope = {
    ...envelopeA,
    tools: [
      { type: "function", function: { name: "tool_a", parameters: { a: 2, z: 1 } } },
    ],
  };

  const toolsA = extractStablePrefixContract(envelopeA).stableCore.find((segment) => segment.key === "tools")?.text;
  const toolsB = extractStablePrefixContract(envelopeB).stableCore.find((segment) => segment.key === "tools")?.text;

  assert.equal(toolsA, toolsB);
});

test("prepareBeforeCall canonicalizes tool order before forwarding", async () => {
  const envelope: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-tools-canonical",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    tools: [
      { type: "function", function: { name: "z_tool", parameters: { z: 1, a: 2 } } },
      { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
    ],
    rawPayload: {},
  };

  const prepared = await prepareBeforeCall({ envelope, config: { mode: "normal" } });
  const tools = prepared.envelope.tools as Array<Record<string, any>>;

  assert.equal(Array.isArray(tools), true);
  assert.equal(tools[0]?.function?.name, "a_tool");
  assert.equal(tools[1]?.function?.name, "z_tool");
  assert.deepEqual(tools[0]?.function?.parameters, { a: false, b: true });
  assert.deepEqual(tools[1]?.function?.parameters, { a: 2, z: 1 });
});

test("canonicalizeTools returns stable order and nested key order", () => {
  const tools = canonicalizeTools([
    { type: "function", function: { name: "b_tool", parameters: { z: 1, a: 2 } } },
    { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
  ]) as Array<Record<string, any>>;

  assert.equal(tools[0]?.function?.name, "a_tool");
  assert.equal(tools[1]?.function?.name, "b_tool");
  assert.deepEqual(tools[0]?.function?.parameters, { a: false, b: true });
  assert.deepEqual(tools[1]?.function?.parameters, { a: 2, z: 1 });
});

test("normalizeStablePrefixText rewrites home, skill, and generic absolute paths", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = "/home/tester";
  try {
    const normalized = normalizeStablePrefixText(
      [
        "cwd=/repo/demo/src/app.ts",
        "skill=/home/tester/.codex/skills/openai-docs/SKILL.md",
        "lib=/tmp/build/node_modules/pkg/index.js",
        "other=/var/log/tokenpilot/debug.log",
      ].join("\n"),
      { workdir: "/repo/demo" },
    );

    assert.match(normalized, /cwd=<WORKDIR>\/src\/app\.ts/);
    assert.match(normalized, /skill=<CODEX_SKILLS>\/openai-docs\/SKILL\.md/);
    assert.match(normalized, /lib=<NODE_MODULES>\/pkg\/index\.js/);
    assert.match(normalized, /other=<ABS_PATH>\/tokenpilot\/debug\.log/);
    assert.doesNotMatch(normalized, /\/home\/tester/);
    assert.doesNotMatch(normalized, /\/var\/log\/tokenpilot/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("normalizeStablePrefixText rewrites runtime ids, timestamps, and long numeric identifiers", () => {
  const normalized = normalizeStablePrefixText(
    [
      "Current date: 2026-07-08",
      "Request ID: req_12345678901234567890",
      "Session ID: sess_12345678901234567890",
      "Trace: request_id=req_12345678901234567890 | session_id=sess_12345678901234567890",
      "Seen at 2026-07-05T10:11:12Z",
      "Run UUID: 123e4567-e89b-12d3-a456-426614174000",
      "Large token: 12345678901234567890",
    ].join("\n"),
  );

  assert.match(normalized, /Current date: <CURRENT_DATE>/);
  assert.match(normalized, /Request ID: <REQUEST_ID>/);
  assert.match(normalized, /Session ID: <SESSION_ID>/);
  assert.match(normalized, /request_id=<REQUEST_ID>/i);
  assert.match(normalized, /session_id=<SESSION_ID>/i);
  assert.match(normalized, /Seen at <TIMESTAMP>/);
  assert.match(normalized, /Run UUID: <UUID>/);
  assert.match(normalized, /Large token: <LONG_NUMBER>/);
  assert.doesNotMatch(normalized, /123e4567-e89b-12d3-a456-426614174000/);
  assert.doesNotMatch(normalized, /12345678901234567890/);
});

test("rewriteTextForStablePrefix stabilizes volatile metadata lines in canonical text only", () => {
  const rewrite = rewriteTextForStablePrefix(
    [
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive | request_id=req_999999999999",
      "Current date: 2026-07-08",
      "Trace ID: trace_1234567890123",
      "Seen at 2026-07-05T10:11:12Z",
    ].join("\n"),
  );

  assert.match(rewrite.forwardedText, /worker-123/);
  assert.doesNotMatch(rewrite.forwardedText, /2026-07-08/);
  assert.match(rewrite.canonicalText, /agent=<AGENT_ID>/);
  assert.doesNotMatch(rewrite.canonicalText, /request_id=/i);
  assert.doesNotMatch(rewrite.canonicalText, /Current date:/);
  assert.doesNotMatch(rewrite.canonicalText, /Trace ID:/);
  assert.doesNotMatch(rewrite.canonicalText, /Seen at/);
  assert.match(rewrite.dynamicContextText, /WORKDIR: \/repo\/demo/);
  assert.match(rewrite.dynamicContextText, /AGENT_ID: worker-123/);
  assert.match(rewrite.dynamicContextText, /request_id=req_999999999999/i);
  assert.match(rewrite.dynamicContextText, /Current date: 2026-07-08/);
  assert.match(rewrite.dynamicContextText, /Trace ID: trace_1234567890123/);
  assert.match(rewrite.dynamicContextText, /Seen at 2026-07-05T10:11:12Z/);
});

test("rewriteTextForStablePrefix moves obvious dynamic metadata lines out of forwarded stable text", () => {
  const rewrite = rewriteTextForStablePrefix(
    [
      "System bootstrap.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
      "Current date: 2026-07-08",
      "Request ID: req_12345678901234567890",
      "Seen at 2026-07-05T10:11:12Z",
      "Repository policy: keep commits small.",
    ].join("\n"),
  );

  assert.match(rewrite.forwardedText, /System bootstrap\./);
  assert.match(rewrite.forwardedText, /Repository policy: keep commits small\./);
  assert.doesNotMatch(rewrite.forwardedText, /Current date:/);
  assert.doesNotMatch(rewrite.forwardedText, /Request ID:/);
  assert.doesNotMatch(rewrite.forwardedText, /Seen at 2026-07-05T10:11:12Z/);
  assert.match(rewrite.dynamicContextText, /Current date: 2026-07-08/);
  assert.match(rewrite.dynamicContextText, /Request ID: req_12345678901234567890/);
  assert.match(rewrite.dynamicContextText, /Seen at 2026-07-05T10:11:12Z/);
});

test("rewriteTextForStablePrefix splits mixed stable and volatile runtime lines", () => {
  const rewrite = rewriteTextForStablePrefix(
    [
      "System bootstrap.",
      "Runtime: agent=worker-123 | mode=interactive | request_id=req_12345678901234567890 | trace_id=trace_12345678901234567890",
      "Your working directory is: /repo/demo",
      "Repository policy: keep commits small.",
    ].join("\n"),
  );

  assert.match(rewrite.forwardedText, /Runtime: agent=worker-123 \| mode=interactive/);
  assert.doesNotMatch(rewrite.forwardedText, /request_id=/i);
  assert.doesNotMatch(rewrite.forwardedText, /trace_id=/i);
  assert.match(rewrite.canonicalText, /Runtime: agent=<AGENT_ID> \| mode=interactive/);
  assert.doesNotMatch(rewrite.canonicalText, /request_id=/i);
  assert.doesNotMatch(rewrite.canonicalText, /trace_id=/i);
  assert.match(rewrite.dynamicContextText, /request_id=req_12345678901234567890/i);
  assert.match(rewrite.dynamicContextText, /trace_id=trace_12345678901234567890/i);
});

test("rewriteTextForStablePrefix does not strip ordinary business text that merely contains dates, ids, or large numbers", () => {
  const rewrite = rewriteTextForStablePrefix(
    [
      "Release note: version 20260708001 adds 12000000000 cached rows for benchmark parity.",
      "User-facing copy: session_id is shown literally in docs and should not be moved unless it is metadata.",
      "The deadline is 2026-07-08 for the migration guide.",
    ].join("\n"),
  );

  assert.match(rewrite.forwardedText, /version 20260708001 adds 12000000000 cached rows/i);
  assert.match(rewrite.forwardedText, /session_id is shown literally in docs/i);
  assert.match(rewrite.forwardedText, /deadline is 2026-07-08/i);
  assert.equal(rewrite.dynamicContextText, "");
  assert.match(rewrite.canonicalText, /Release note: version <LONG_NUMBER> adds <LONG_NUMBER> cached rows/i);
});

test("extractStablePrefixContract normalizes absolute paths inside tools", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = "/home/tester";
  try {
    const envelope: HostRequestEnvelope = {
      session: {
        host: { hostId: "codex", displayName: "Codex" },
        sessionId: "session-tools-paths",
        sessionMode: "single",
      },
      model: "gpt-5.4",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_skill",
            description: "Open /home/tester/.codex/skills/openai-docs/SKILL.md from /repo/demo/docs/README.md",
            parameters: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Absolute path like /var/log/tokenpilot/debug.log",
                },
              },
            },
          },
        },
      ],
      rawPayload: {},
    };

    const toolText = extractStablePrefixContract(envelope).stableCore.find((segment) => segment.key === "tools")?.text ?? "";
    assert.match(toolText, /<CODEX_SKILLS>\/openai-docs\/SKILL\.md/);
    assert.match(toolText, /<ABS_PATH>\/tokenpilot\/debug\.log/);
    assert.match(toolText, /<ABS_PATH>\/docs\/README\.md/);
    assert.doesNotMatch(toolText, /\/home\/tester/);
    assert.doesNotMatch(toolText, /\/var\/log\/tokenpilot/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("stable prefix fingerprint ignores volatile tail changes", () => {
  const base: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-6",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
    messages: [
      {
        role: "system",
        content: "Project protocol.\nYour working directory is: /repo/demo\nRuntime: agent=worker-123 | mode=interactive",
      },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ],
    rawPayload: {},
  };
  const changedTail: HostRequestEnvelope = {
    ...base,
    messages: [
      base.messages[0],
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
    ],
  };

  assert.equal(
    fingerprintStablePrefixEnvelope(base),
    fingerprintStablePrefixEnvelope(changedTail),
  );
});

test("stable prefix fingerprint ignores runtime-only workdir and agent changes", () => {
  const base: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-7",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
    messages: [
      { role: "system", content: "Project protocol." },
      { role: "user", content: "hello" },
    ],
    rawPayload: {},
  };
  const changedStable: HostRequestEnvelope = {
    ...base,
    instructions: [
      "You are the coding agent.",
      "Your working directory is: /repo/other",
      "Runtime: agent=worker-999 | mode=interactive",
    ].join("\n"),
  };

  assert.equal(
    fingerprintStablePrefixEnvelope(base),
    fingerprintStablePrefixEnvelope(changedStable),
  );
});

test("stable prefix fingerprint changes when stable non-runtime instructions change", () => {
  const base: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-7b",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    instructions: [
      "You are the coding agent.",
      "Follow repository protocol alpha.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
    messages: [
      { role: "system", content: "Project protocol." },
      { role: "user", content: "hello" },
    ],
    rawPayload: {},
  };
  const changedStable: HostRequestEnvelope = {
    ...base,
    instructions: [
      "You are the coding agent.",
      "Follow repository protocol beta.",
      "Your working directory is: /repo/demo",
      "Runtime: agent=worker-123 | mode=interactive",
    ].join("\n"),
  };

  assert.notEqual(
    fingerprintStablePrefixEnvelope(base),
    fingerprintStablePrefixEnvelope(changedStable),
  );
});

test("serializeStablePrefixEnvelope excludes volatile tail content", () => {
  const envelope: HostRequestEnvelope = {
    session: {
      host: { hostId: "codex", displayName: "Codex" },
      sessionId: "session-8",
      sessionMode: "single",
    },
    model: "gpt-5.4",
    stream: true,
    messages: [
      { role: "system", content: "Your working directory is: /repo/demo" },
      { role: "user", content: "volatile user content" },
      { role: "assistant", content: "volatile assistant content" },
    ],
    rawPayload: {},
  };

  const serialized = serializeStablePrefixEnvelope(envelope);
  const raw = JSON.stringify(serialized);

  assert.match(raw, /<WORKDIR>/);
  assert.doesNotMatch(raw, /volatile user content/);
  assert.doesNotMatch(raw, /volatile assistant content/);
});

test("auditStablePrefixEntropy finds absolute paths, timestamps, and UUIDs in stable prefix", () => {
  const findings = auditStablePrefixEntropy({
    schemaVersion: 1,
    stableCore: [
      {
        key: "instructions",
        source: "instructions",
        text: "Path: /repo/demo\nSeen at 2026-07-05T10:11:12Z\nRun UUID: 123e4567-e89b-12d3-a456-426614174000",
      },
    ],
    semiStableContext: [],
  });

  assert.equal(findings.some((item) => item.kind === "abs_path"), true);
  assert.equal(findings.some((item) => item.kind === "timestamp"), true);
  assert.equal(findings.some((item) => item.kind === "uuid"), true);
});

test("auditStablePrefixEntropy ignores placeholder-normalized paths", () => {
  const serialized: SerializedStablePrefixContract = {
    schemaVersion: 1,
    stableCore: [
      {
        key: "tools",
        source: "tools",
        text: "cwd=<WORKDIR>/src\nskill=<CODEX_SKILLS>/openai-docs/SKILL.md\nlog=<ABS_PATH>/tokenpilot/debug.log",
      },
    ],
    semiStableContext: [],
  };
  const findings = auditStablePrefixEntropy(serialized);

  assert.equal(findings.some((item) => item.kind === "abs_path"), false);
});

test("auditStablePrefixEntropy flags non-canonical tool ordering", () => {
  const serialized: SerializedStablePrefixContract = {
    schemaVersion: 1,
    stableCore: [
      {
        key: "tools",
        source: "tools",
        text: JSON.stringify([
          { type: "function", function: { name: "b_tool", parameters: { z: 1, a: 2 } } },
          { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
        ]),
      },
    ],
    semiStableContext: [],
  };

  const findings = auditStablePrefixEntropy(serialized);
  assert.equal(findings.some((item) => item.kind === "tooling_order_risk"), true);
});

test("auditStablePrefixEntropy does not flag canonical tool ordering", () => {
  const serialized: SerializedStablePrefixContract = {
    schemaVersion: 1,
    stableCore: [
      {
        key: "tools",
        source: "tools",
        text: JSON.stringify(canonicalizeTools([
          { type: "function", function: { name: "b_tool", parameters: { z: 1, a: 2 } } },
          { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
        ])),
      },
    ],
    semiStableContext: [],
  };

  const findings = auditStablePrefixEntropy(serialized);
  assert.equal(findings.some((item) => item.kind === "tooling_order_risk"), false);
});

test("diffStablePrefixSerialized explains text and segment drift", () => {
  const previous: SerializedStablePrefixContract = {
    schemaVersion: 1 as const,
    stableCore: [
      { key: "instructions", source: "instructions", text: "A" },
    ],
    semiStableContext: [
      { key: "model", source: "model", text: "gpt-5.4" },
    ],
  };
  const current: SerializedStablePrefixContract = {
    schemaVersion: 1 as const,
    stableCore: [
      { key: "instructions", source: "instructions", text: "B" },
      { key: "tools", source: "tools", text: "[]" },
    ],
    semiStableContext: [],
  };

  const reasons = diffStablePrefixSerialized(previous, current);

  assert.equal(reasons.some((item) => item.kind === "segment_text_changed" && item.key === "instructions"), true);
  assert.equal(reasons.some((item) => item.kind === "segment_added" && item.key === "tools"), true);
  assert.equal(reasons.some((item) => item.kind === "segment_removed" && item.key === "model"), true);
});
