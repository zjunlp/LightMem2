import test from "node:test";
import assert from "node:assert/strict";
import {
  assertReductionMarkerText,
  assertStablePrefixRewrite,
} from "@tokenpilot/host-adapter";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require("./index.js");
const hooks = plugin.__testHooks as {
  rewritePayloadForStablePrefix: (
    payload: any,
    model: string,
    options?: {
      dynamicContextTarget?: "developer" | "user";
      developerTextForKeyOverride?: string;
    },
  ) => {
    promptCacheKey: string;
    userContentRewrites: number;
    senderMetadataBlocksBefore: number;
    senderMetadataBlocksAfter: number;
    developerTextForKey: string;
  };
  insertDeveloperDynamicContextBlock: (
    input: any,
    dynamicContextText: string,
    afterIndex?: number,
  ) => {
    input: any;
    changed: boolean;
  };
  applyProxyReductionToInput: (
    payload: any,
    options?: Record<string, unknown>,
  ) => Promise<{
    changedItems: number;
    changedBlocks: number;
    savedChars: number;
    diagnostics?: {
      skippedReason?: string;
    };
  }> | {
    changedItems: number;
    changedBlocks: number;
    savedChars: number;
    diagnostics?: {
      skippedReason?: string;
    };
  };
  stripInternalPayloadMarkers: (payload: any) => void;
  normalizeConfig: (raw: unknown) => any;
  responsesPayloadToChatCompletions: (payload: any) => any;
  chatCompletionsToResponsesText: (raw: string) => string;
  convertChatCompletionsSseToResponsesSse: (rawSse: string) => string;
  prepareProxyRequest: (args: {
    cfg: any;
    logger?: any;
    helpers?: any;
    payload: any;
    upstream?: any;
    resolveSessionIdForPayload?: ((payload: any) => string | undefined) | undefined;
    policyModule?: any;
    reductionPassOptions?: any;
    dynamicContextTarget?: "user" | "developer";
  }) => Promise<{
    payload: any;
    requestEnvelope: any;
    reductionApplied: {
      diagnostics?: {
        instructionCount?: number;
        skippedReason?: string;
      };
    };
    developerCanonicalText?: string;
    developerForwardedText?: string;
  }>;
  recordStreamingUxEffect: (params: {
    cfg: any;
    helpers: any;
    logger: any;
    model: string;
    upstreamModel: string;
    resolvedSessionId: string;
    originalInputText: string;
    afterReductionInputText: string;
    beforeReductionCanonicalInput: string;
    afterReductionCanonicalInput: string;
    streamChunks: Buffer[];
    reductionApplied?: { savedChars?: number } | null;
  }) => Promise<void>;
  applyLayeredReductionAfterCall: (
    requestPayload: any,
    parsedResponse: any,
    maxToolChars: number,
    triggerMinChars: number,
    sessionId: string,
    passToggles: Record<string, unknown> | undefined,
    passOptions: Record<string, Record<string, unknown>> | undefined,
    helpers: any,
  ) => Promise<{
    changed: boolean;
    savedChars: number;
    passCount: number;
    skippedReason?: string;
    report?: Array<any>;
  }>;
  applyLayeredReductionAfterCallToSse: (
    requestPayload: any,
    rawSse: string,
    maxToolChars: number,
    triggerMinChars: number,
    sessionId: string,
    passToggles: Record<string, unknown> | undefined,
    passOptions: Record<string, Record<string, unknown>> | undefined,
    helpers: any,
  ) => Promise<{
    text: string;
    reduction: {
      changed: boolean;
      savedChars: number;
      passCount: number;
      skippedReason?: string;
      mode?: "json" | "sse";
      patchedEvents?: number;
      report?: Array<any>;
    };
  }>;
  appendStabilityVisualSnapshot: (stateDir: string, snapshot: any) => Promise<void>;
  appendReductionVisualSnapshot: (stateDir: string, snapshot: any) => Promise<void>;
  appendEvictionVisualSnapshot: (stateDir: string, snapshot: any) => Promise<void>;
  readVisualSessionData: (stateDir: string, sessionId: string) => Promise<any>;
  readVisualSessionList: (stateDir: string) => Promise<any[]>;
};

test("applyProxyReductionToInput reduces large tool payload and preserves non-tool entries", async () => {
  const largeJson = JSON.stringify({
    rows: Array.from({ length: 800 }, (_, i) => ({ id: i, value: `payload-${i}` })),
  });
  const payload: any = {
    input: [
      { role: "tool", content: largeJson },
      { role: "user", content: "keep me unchanged" },
    ],
  };

  const out = await hooks.applyProxyReductionToInput(payload);

  assert.equal(out.changedItems, 1);
  assert.equal(out.changedBlocks, 1);
  assert.ok(out.savedChars > 0);
  assertReductionMarkerText(String(payload.input[0].content));
  assert.match(String(payload.input[0].content), /memory_fault_recover/);
  assert.match(String(payload.input[0].content), /"dataKey":/);
  assert.equal(payload.input[1].content, "keep me unchanged");
});

test("applyProxyReductionToInput reduces responses-style function call fields", async () => {
  const largeOutput = JSON.stringify({
    rows: Array.from({ length: 1200 }, (_, i) => ({ id: i, value: `tool-output-${i}` })),
  });
  const largeArguments = JSON.stringify({
    query: "x".repeat(3200),
  });
  const payload: any = {
    input: [
      { type: "function_call", name: "search", arguments: largeArguments },
      { type: "function_call_output", call_id: "call_123", output: largeOutput },
    ],
  };

  const out = await hooks.applyProxyReductionToInput(payload);

  assert.equal(out.changedItems, 1);
  assert.equal(out.changedBlocks, 1);
  assert.ok(out.savedChars > 0);
  assert.equal(payload.input[0].arguments, largeArguments);
  assertReductionMarkerText(String(payload.input[1].output));
});

test("stripInternalPayloadMarkers removes internal flags before forwarding upstream", () => {
  const payload: any = {
    __tokenpilot_reduction_applied: true,
    input: [
      { role: "user", __tokenpilot_replay_raw: true, content: "hello" },
      { role: "assistant", content: "world" },
    ],
  };

  hooks.stripInternalPayloadMarkers(payload);

  assert.equal("__tokenpilot_reduction_applied" in payload, false);
  assert.equal("__tokenpilot_replay_raw" in payload.input[0], false);
  assert.equal(payload.input[0].content, "hello");
  assert.equal(payload.input[1].content, "world");
});

test("rewritePayloadForStablePrefix preserves content shape and injects dynamic context to first user", () => {
  const payload: any = {
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: "Runtime: agent=bench-tokenpilot-gpt-5-4-mini-0213-j0013 | host=mistral\nYour working directory is: /tmp/pinchbench/0213/agent_workspace_j0013",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Please continue." }],
      },
    ],
  };

  const out = hooks.rewritePayloadForStablePrefix(payload, "tokenpilot/gpt-5.4-mini", {
    dynamicContextTarget: "user",
  });

  assert.equal(Array.isArray(payload.input[0].content), true);
  assertStablePrefixRewrite({
    sanitizedPromptText: String(payload.input[0].content[0].text),
    dynamicContextText: String(payload.input[1].content[0].text),
    workdir: "/tmp/pinchbench/0213/agent_workspace_j0013",
    agentId: "bench-tokenpilot-gpt-5-4-mini-0213-j0013",
  });
  assert.match(String(payload.input[1].content[0].text), /Please continue\./);
  assert.match(out.promptCacheKey, /^runtime-pfx-/);
});

test("rewritePayloadForStablePrefix derives different cache keys for different stable prefixes", () => {
  const payloadA: any = {
    instructions: "Global instructions A",
    input: [
      {
        role: "developer",
        content: "Developer prompt A\nYour working directory is: /tmp/demo",
      },
      {
        role: "user",
        content: "Please continue.",
      },
    ],
  };
  const payloadB: any = {
    instructions: "Global instructions B",
    input: [
      {
        role: "developer",
        content: "Developer prompt B\nYour working directory is: /tmp/demo",
      },
      {
        role: "user",
        content: "Please continue.",
      },
    ],
  };

  const outA = hooks.rewritePayloadForStablePrefix(payloadA, "tokenpilot/gpt-5.4-mini", {
    dynamicContextTarget: "developer",
  });
  const outB = hooks.rewritePayloadForStablePrefix(payloadB, "tokenpilot/gpt-5.4-mini", {
    dynamicContextTarget: "developer",
  });

  assert.notEqual(outA.promptCacheKey, outB.promptCacheKey);
});

test("rewritePayloadForStablePrefix overrides inbound prompt_cache_key and converges legacy keys for the same stable prefix", () => {
  const makePayload = (promptCacheKey: string) => ({
    prompt_cache_key: promptCacheKey,
    instructions: "Global instructions A",
    input: [
      {
        role: "developer",
        content: "Developer prompt A\nYour working directory is: /tmp/demo",
      },
      {
        role: "user",
        content: "Please continue.",
      },
    ],
  });

  const payloadA = makePayload("legacy-key-a");
  const payloadB = makePayload("legacy-key-b");

  const outA = hooks.rewritePayloadForStablePrefix(payloadA, "tokenpilot/gpt-5.4-mini", {
    dynamicContextTarget: "developer",
  });
  const outB = hooks.rewritePayloadForStablePrefix(payloadB, "tokenpilot/gpt-5.4-mini", {
    dynamicContextTarget: "developer",
  });

  assert.match(outA.promptCacheKey, /^runtime-pfx-/);
  assert.equal(outA.promptCacheKey, payloadA.prompt_cache_key);
  assert.equal(outB.promptCacheKey, payloadB.prompt_cache_key);
  assert.equal(outA.promptCacheKey, outB.promptCacheKey);
  assert.notEqual(outA.promptCacheKey, "legacy-key-a");
  assert.notEqual(outB.promptCacheKey, "legacy-key-b");
});

test("applyProxyReductionToInput still runs with policy-only before-call modules", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: true,
      reduction: false,
    },
  });

  const { createPolicyModule } = await import("@tokenpilot/decision");

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        role: "tool",
        toolName: "read",
        path: "/workspace/spec.md",
        content: "A".repeat(600),
      },
      {
        role: "tool",
        toolName: "write",
        path: "/workspace/output.md",
        content: "Successfully wrote 120 bytes to /workspace/output.md",
      },
    ],
  };

  const out = await hooks.applyProxyReductionToInput(payload, {
    triggerMinChars: 2200,
    maxToolChars: 1200,
    passToggles: {
      readStateCompaction: false,
      toolPayloadTrim: false,
      htmlSlimming: false,
      execOutputTruncation: false,
      agentsStartupOptimization: false,
      memoryFaultRecovery: false,
    },
    beforeCallModules: {
      policy: createPolicyModule({
        localityEnabled: true,
        reductionEnabled: false,
        reductionFormatSlimmingEnabled: false,
        reductionSemanticEnabled: false,
        evictionEnabled: false,
        cacheHealthEnabled: false,
      }),
    },
    cfg,
  });

  assert.equal(out.changedItems, 0);
  assert.equal(out.changedBlocks, 0);
  assert.equal(out.savedChars, 0);
  assert.equal(String(out.diagnostics?.skippedReason), "pipeline_no_effect");
  assert.equal(
    payload.input[1].content,
    "Successfully wrote 120 bytes to /workspace/output.md",
  );
});

test("prepareProxyRequest does not compact distinct read windows of the same file", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: false,
      reduction: true,
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        type: "function_call",
        call_id: "call_read_1",
        name: "read",
        arguments: JSON.stringify({ path: "/workspace/spec.md", offset: 1, limit: 200 }),
      },
      {
        type: "function_call_output",
        call_id: "call_read_1",
        output: "A".repeat(1600),
      },
      {
        type: "function_call",
        call_id: "call_read_2",
        name: "read",
        arguments: JSON.stringify({ path: "/workspace/spec.md", offset: 201, limit: 200 }),
      },
      {
        type: "function_call_output",
        call_id: "call_read_2",
        output: "B".repeat(1600),
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    upstream: {
      provider: "test",
      api: "responses",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      model: "gpt-5.4-mini",
    },
    reductionPassOptions: {},
    dynamicContextTarget: "developer",
  });

  const outputs = prepared.payload.input
    .filter((item: any) => item.type === "function_call_output")
    .map((item: any) => String(item.output));

  assert.equal(outputs.length, 2);
  assert.equal(outputs.every((text: string) => !text.includes("[Read superseded]")), true);
});

test("prepareProxyRequest does not emit read-state instructions for distinct read windows", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: false,
      reduction: true,
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        type: "function_call",
        call_id: "call_read_1",
        name: "read",
        arguments: JSON.stringify({ path: "/workspace/spec.md", offset: 1, limit: 200 }),
      },
      {
        type: "function_call_output",
        call_id: "call_read_1",
        output: "A".repeat(1600),
      },
      {
        type: "function_call",
        call_id: "call_read_2",
        name: "read",
        arguments: JSON.stringify({ path: "/workspace/spec.md", offset: 201, limit: 200 }),
      },
      {
        type: "function_call_output",
        call_id: "call_read_2",
        output: "B".repeat(1600),
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    upstream: {
      provider: "test",
      api: "responses",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      model: "gpt-5.4-mini",
    },
    reductionPassOptions: {},
    dynamicContextTarget: "developer",
  });

  const outputs = prepared.payload.input
    .filter((item: any) => item.type === "function_call_output")
    .map((item: any) => String(item.output));

  assert.equal(outputs.length, 2);
  assert.equal(outputs.every((text: string) => !text.includes("[Read superseded]")), true);
  assert.equal(outputs.every((text: string) => !text.includes("[Read stale]")), true);
});

test("prepareProxyRequest still runs policy before-call when reduction module is disabled", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: true,
      reduction: false,
    },
  });

  let beforeBuildCalls = 0;
  const policyModule = {
    async beforeBuild(turnCtx: any) {
      beforeBuildCalls += 1;
      return turnCtx;
    },
  };

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        role: "tool",
        toolName: "read",
        path: "/workspace/spec.md",
        content: "A".repeat(600),
      },
      {
        role: "tool",
        toolName: "write",
        path: "/workspace/output.md",
        content: "Successfully wrote 120 bytes to /workspace/output.md",
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    policyModule,
    resolveSessionIdForPayload: () => "session-policy-only",
  });

  assert.equal(beforeBuildCalls, 1);
  assert.equal(String(prepared.reductionApplied.diagnostics?.skippedReason), "module_disabled");
});

test("prepareProxyRequest falls back to system root prompt for stability view", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: false,
      reduction: false,
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        role: "system",
        content: "Runtime: agent=test-agent | host=demo\nYour working directory is: /tmp/demo\n\nSystem root prompt body",
      },
      {
        role: "user",
        content: "hello",
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    resolveSessionIdForPayload: () => "session-system-root",
  });

  assert.match(String(prepared.developerCanonicalText), /<WORKDIR>/);
  assert.match(String(prepared.developerForwardedText), /System root prompt body/);
});

test("prepareProxyRequest does not roll back payload mutations made after stable rewrite", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: false,
      reduction: true,
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        role: "developer",
        content: "Runtime: agent=test-agent | host=demo\nYour working directory is: /tmp/demo",
      },
      {
        role: "user",
        content: "hello",
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    resolveSessionIdForPayload: () => "session-no-rollback",
    helpers: {
      injectMemoryFaultProtocolInstructions: () => false,
      rewritePayloadForStablePrefix: (inputPayload: any) => {
        inputPayload.prompt_cache_key = "runtime-pfx-test";
        return {
          promptCacheKey: "runtime-pfx-test",
          userContentRewrites: 0,
          senderMetadataBlocksBefore: 0,
          senderMetadataBlocksAfter: 0,
        };
      },
      applyProxyReductionToInput: async (inputPayload: any) => {
        inputPayload.input.push({
          role: "user",
          content: "reduction mutation survives",
        });
        return {
          changedItems: 1,
          changedBlocks: 1,
          savedChars: 10,
          diagnostics: {
            skippedReason: "none",
          },
        };
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as any,
  });

  assert.equal(
    payload.input[payload.input.length - 1].content,
    "reduction mutation survives",
  );
  assert.equal(prepared.payload.input[prepared.payload.input.length - 1].content, "reduction mutation survives");
  assert.equal(prepared.requestEnvelope.messages[prepared.requestEnvelope.messages.length - 1].content, "reduction mutation survives");
  assert.equal(prepared.payload.prompt_cache_key, "runtime-pfx-test");
  assert.equal(prepared.payload.prompt_cache_retention, "24h");
  assert.equal(prepared.requestEnvelope.metadata?.promptCacheKey, "runtime-pfx-test");
  assert.equal(prepared.requestEnvelope.metadata?.promptCacheRetention, "24h");
});

test("prepareProxyRequest preserves stable prefix, memory injection, and reduction mutations together", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: false,
      reduction: true,
    },
    memory: {
      enabled: true,
      topK: 2,
      injectAsSystemHint: false,
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        role: "developer",
        content: "Runtime: agent=test-agent | host=demo\nYour working directory is: /tmp/demo\n\nDeveloper prompt",
      },
      {
        role: "user",
        content: "Please continue the task.",
      },
      {
        role: "tool",
        content: "T".repeat(3000),
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    resolveSessionIdForPayload: () => "session-stable-memory-reduction",
    helpers: {
      ...hooks,
      injectMemoryFaultProtocolInstructions: () => false,
      rewritePayloadForStablePrefix: (inputPayload: any) => {
        inputPayload.prompt_cache_key = "runtime-pfx-combined";
        const developer = inputPayload.input[0];
        developer.content = String(developer.content).replace("/tmp/demo", "<WORKDIR>");
        return {
          promptCacheKey: "runtime-pfx-combined",
          userContentRewrites: 0,
          senderMetadataBlocksBefore: 0,
          senderMetadataBlocksAfter: 0,
        };
      },
      appendTaskStateTrace: async () => undefined,
      applyProxyReductionToInput: async (inputPayload: any) => {
        inputPayload.input.push({
          role: "user",
          content: "reduction mutation survives",
        });
        return {
          changedItems: 1,
          changedBlocks: 1,
          savedChars: 1234,
          diagnostics: {
            skippedReason: "none",
          },
        };
      },
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as any,
  });

  const userMessages = prepared.payload.input.filter((item: any) => item.role === "user");
  assert.match(String(prepared.payload.input[0].content), /<WORKDIR>/);
  assert.equal(prepared.payload.prompt_cache_key, "runtime-pfx-combined");
  assert.equal(prepared.requestEnvelope.metadata?.promptCacheKey, "runtime-pfx-combined");
  assert.equal(prepared.requestEnvelope.metadata?.promptCacheRetention, "24h");
  assert.equal(String(userMessages[0]?.content), "Please continue the task.");
  assert.equal(String(userMessages[userMessages.length - 1]?.content), "reduction mutation survives");
  assert.equal(
    prepared.requestEnvelope.messages[prepared.requestEnvelope.messages.length - 1]?.content,
    "reduction mutation survives",
  );
});

test("prepareProxyRequest isolates developer dynamic context into a separate developer block", async () => {
  const cfg = hooks.normalizeConfig({
    modules: {
      policy: false,
      reduction: false,
    },
  });

  const payload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    input: [
      {
        role: "developer",
        content: "Runtime: agent=test-agent | host=demo\nYour working directory is: /tmp/demo\n\nDeveloper prompt",
      },
      {
        role: "user",
        content: "Please continue the task.",
      },
    ],
  };

  const prepared = await hooks.prepareProxyRequest({
    cfg,
    payload,
    resolveSessionIdForPayload: () => "session-dev-split",
    dynamicContextTarget: "developer",
  });

  const developerItems = prepared.payload.input.filter((item: any) => item?.role === "developer");
  assert.equal(developerItems.length, 2);
  assert.match(String(developerItems[0]?.content ?? ""), /Your working directory is: \/tmp\/demo/);
  assert.match(String(developerItems[0]?.content ?? ""), /Runtime: agent=test-agent \| host=demo/);
  assert.doesNotMatch(String(developerItems[0]?.content ?? ""), /WORKDIR: \/tmp\/demo/);
  assert.match(String(developerItems[1]?.content ?? ""), /WORKDIR: \/tmp\/demo/);
  assert.match(String(developerItems[1]?.content ?? ""), /AGENT_ID: test-agent/);
});

test("applyLayeredReductionAfterCall rewrites responses JSON output text through after-call passes", async () => {
  const requestPayload: any = {
    input: [
      { role: "user", content: "Summarize the results." },
    ],
  };
  const parsedResponse: any = {
    id: "resp_after_1",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "  Result path: /very/long/workspace/path/project/src/app.ts  \n\n\nDone.  ",
          },
        ],
      },
    ],
    output_text: "  Result path: /very/long/workspace/path/project/src/app.ts  \n\n\nDone.  ",
  };

  const result = await hooks.applyLayeredReductionAfterCall(
    requestPayload,
    parsedResponse,
    1200,
    2200,
    "after-call-json-session",
    {
      formatSlimming: true,
      formatCleaning: true,
      pathTruncation: true,
      imageDownsample: false,
      lineNumberStrip: false,
      readStateCompaction: false,
      toolPayloadTrim: false,
      htmlSlimming: false,
      execOutputTruncation: false,
      agentsStartupOptimization: false,
    },
    {},
    {
      buildLayeredReductionContext: (
        payload: any,
        triggerMinChars: number,
        sessionId: string,
        passToggles: any,
        passOptions: any,
      ) => ({
        turnCtx: {
          sessionId,
          sessionMode: "single",
          provider: "test",
          model: "gpt-5.4-mini",
          prompt: "",
          budget: { maxInputTokens: 100000, reserveOutputTokens: 1000 },
          segments: [
            {
              id: "user-1",
              kind: "volatile",
              priority: 1,
              text: JSON.stringify({ payload, triggerMinChars, passToggles, passOptions }).slice(0, 200),
            },
          ],
          metadata: {
            workspaceDir: "/tmp",
            policy: {
              decisions: {
                reduction: {
                  instructions: [
                    {
                      strategy: "format_slimming",
                      segmentIds: ["response-1"],
                      parameters: {},
                    },
                    {
                      strategy: "path_truncation",
                      segmentIds: ["response-1"],
                      parameters: { maxPathLength: 40 },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
      isReductionPassEnabled: (passId: string, toggles?: Record<string, unknown>) => {
        const map: Record<string, string> = {
          format_slimming: "formatSlimming",
          format_cleaning: "formatCleaning",
          path_truncation: "pathTruncation",
          image_downsample: "imageDownsample",
          line_number_strip: "lineNumberStrip",
        };
        const key = map[passId];
        return key ? toggles?.[key] !== false : true;
      },
    },
  );

  assert.equal(result.changed, true);
  assert.ok(result.savedChars > 0);
  assert.ok(result.passCount > 0);
  assert.notEqual(parsedResponse.output_text, "  Result path: /very/long/workspace/path/project/src/app.ts  \n\n\nDone.  ");
  assert.equal(parsedResponse.output[0].content[0].text, parsedResponse.output_text);
});

test("applyLayeredReductionAfterCallToSse rewrites completed responses SSE payload", async () => {
  const requestPayload: any = {
    input: [
      { role: "user", content: "Summarize the results." },
    ],
  };
  const rawSse = [
    'data: {"type":"response.output_text.delta","delta":"Result path: /very/long/workspace/path/project/src/app.ts"}',
    "",
    'data: {"type":"response.output_text.done","text":"Result path: /very/long/workspace/path/project/src/app.ts"}',
    "",
    'data: {"type":"response.completed","response":{"id":"resp_sse_1","output":[{"type":"message","content":[{"type":"output_text","text":"Result path: /very/long/workspace/path/project/src/app.ts"}]}],"output_text":"Result path: /very/long/workspace/path/project/src/app.ts"}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const result = await hooks.applyLayeredReductionAfterCallToSse(
    requestPayload,
    rawSse,
    1200,
    2200,
    "after-call-sse-session",
    {
      formatSlimming: true,
      formatCleaning: true,
      pathTruncation: true,
      imageDownsample: false,
      lineNumberStrip: false,
      readStateCompaction: false,
      toolPayloadTrim: false,
      htmlSlimming: false,
      execOutputTruncation: false,
      agentsStartupOptimization: false,
    },
    {},
    {
      buildLayeredReductionContext: (
        payload: any,
        triggerMinChars: number,
        sessionId: string,
        passToggles: any,
        passOptions: any,
      ) => ({
        turnCtx: {
          sessionId,
          sessionMode: "single",
          provider: "test",
          model: "gpt-5.4-mini",
          prompt: "",
          budget: { maxInputTokens: 100000, reserveOutputTokens: 1000 },
          segments: [
            {
              id: "user-1",
              kind: "volatile",
              priority: 1,
              text: JSON.stringify({ payload, triggerMinChars, passToggles, passOptions }).slice(0, 200),
            },
          ],
          metadata: {
            workspaceDir: "/tmp",
            policy: {
              decisions: {
                reduction: {
                  instructions: [
                    {
                      strategy: "path_truncation",
                      segmentIds: ["response-1"],
                      parameters: { maxPathLength: 40 },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
      isReductionPassEnabled: (passId: string, toggles?: Record<string, unknown>) => {
        const map: Record<string, string> = {
          format_slimming: "formatSlimming",
          format_cleaning: "formatCleaning",
          path_truncation: "pathTruncation",
          image_downsample: "imageDownsample",
          line_number_strip: "lineNumberStrip",
        };
        const key = map[passId];
        return key ? toggles?.[key] !== false : true;
      },
    },
  );

  assert.equal(result.reduction.mode, "sse");
  assert.equal(result.reduction.changed, true);
  assert.ok((result.reduction.patchedEvents ?? 0) > 0);
  assert.ok(result.reduction.savedChars > 0);
  assert.notEqual(result.text, rawSse);
  assert.match(result.text, /response\.completed/);
});

test("recordStreamingUxEffect uses canonical request snapshots in char mode", async () => {
  const recorded: any[] = [];
  const traced: any[] = [];

  await hooks.recordStreamingUxEffect({
    cfg: { stateDir: "/tmp/tokenpilot-stream-ux-test" },
    helpers: {
      extractProviderResponseText: () => "stream-response",
      contentToText: (value: unknown) => String(value ?? ""),
      countTokensWithFallback: async (_model: string, text: string) => ({
        count: text.length,
        mode: "chars" as const,
      }),
      recordUxEffect: async (_stateDir: string, record: any) => {
        recorded.push(record);
      },
      appendTaskStateTrace: async (_stateDir: string, payload: any) => {
        traced.push(payload);
      },
    },
    logger: {
      warn: () => undefined,
    },
    model: "tokenpilot/gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    resolvedSessionId: "stream-session-1",
    originalInputText: "same",
    afterReductionInputText: "same",
    beforeReductionCanonicalInput: "01234567890123456789",
    afterReductionCanonicalInput: "0123",
    streamChunks: [Buffer.from("data: dummy\n\n")],
    reductionApplied: { savedChars: 999 },
  });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].countMode, "chars");
  assert.equal(recorded[0].savedCount, 16);
  assert.equal(recorded[0].details?.requestSavedCount, 16);
  assert.equal(recorded[0].details?.responseSavedCount, 0);
  assert.equal(recorded[0].beforeCount, recorded[0].afterCount + 16);
  assert.equal(traced.length, 1);
  assert.equal(traced[0].stage, "proxy_stream_ux_recorded");
  assert.equal(traced[0].requestSavedCount, 16);
});

test("visual session snapshots can be written and listed", async () => {
  const stateDir = `/tmp/tokenpilot-visual-${Date.now()}`;
  const sessionId = "visual-session-1";

  await hooks.appendStabilityVisualSnapshot(stateDir, {
    kind: "stability",
    at: "2026-06-11T11:59:00.000Z",
    sessionId,
    model: "tokenpilot/gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    promptCacheKeyBefore: "raw-key",
    promptCacheKeyAfter: "stable-key",
    dynamicContextTarget: "developer",
    userContentRewrites: 1,
    senderMetadataBlocksBefore: 2,
    senderMetadataBlocksAfter: 0,
    developerBefore: "raw developer prompt",
    developerCanonical: "canonical prompt",
    developerForwarded: "forwarded prompt",
    dynamicContextText: "WORKDIR: /tmp/demo",
    firstTurnCandidate: true,
  });

  await hooks.appendReductionVisualSnapshot(stateDir, {
    kind: "reduction",
    at: "2026-06-11T12:00:00.000Z",
    sessionId,
    requestId: "req-1",
    model: "tokenpilot/gpt-5.4-mini",
    upstreamModel: "gpt-5.4-mini",
    segmentId: "proxy-1-output",
    itemIndex: 1,
    field: "output",
    toolName: "read",
    dataPath: "/tmp/a.txt",
    savedChars: 1200,
    beforeText: "before reduction",
    afterText: "after reduction",
    report: [],
  });

  await hooks.appendEvictionVisualSnapshot(stateDir, {
    kind: "eviction",
    at: "2026-06-11T12:01:00.000Z",
    sessionId,
    taskId: "task-1",
    taskLabel: "Draft report",
    replacementMode: "pointer_stub",
    beforeText: "long archived text",
    afterText: "stub text",
    beforeChars: 1000,
    afterChars: 20,
    archivePath: "/tmp/archive.json",
    dataKey: "key-1",
    turnAbsIds: ["t1", "t2"],
  });

  const sessions = await hooks.readVisualSessionList(stateDir);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, sessionId);
  assert.equal(sessions[0].stabilityCount, 1);
  assert.equal(sessions[0].reductionCount, 1);
  assert.equal(sessions[0].evictionCount, 1);

  const data = await hooks.readVisualSessionData(stateDir, sessionId);
  assert.equal(data.stability.length, 1);
  assert.equal(data.reduction.length, 1);
  assert.equal(data.eviction.length, 1);
  assert.equal(data.stability[0].promptCacheKeyAfter, "stable-key");
  assert.equal(data.reduction[0].beforeText, "before reduction");
  assert.equal(data.eviction[0].taskId, "task-1");
});

test("responsesPayloadToChatCompletions preserves tools and function call history", () => {
  const payload = {
    model: "gpt-5.4-mini",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "先读一下 docs 目录" }],
      },
      {
        type: "function_call",
        call_id: "call_read_1",
        name: "read",
        arguments: "{\"path\":\"/tmp/docs/README.md\"}",
      },
      {
        type: "function_call_output",
        call_id: "call_read_1",
        output: "{\"content\":\"hello\"}",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
            required: ["path"],
          },
        },
      },
    ],
    tool_choice: "auto",
    max_output_tokens: 128,
  };

  const out = hooks.responsesPayloadToChatCompletions(payload);

  assert.equal(out.model, "gpt-5.4-mini");
  assert.equal(out.tool_choice, "auto");
  assert.equal(Array.isArray(out.tools), true);
  assert.equal(out.tools[0].function.name, "read");
  assert.equal(Array.isArray(out.messages), true);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[0].content, "先读一下 docs 目录");
  assert.equal(out.messages[1].role, "assistant");
  assert.equal(Array.isArray(out.messages[1].tool_calls), true);
  assert.equal(out.messages[1].tool_calls[0].id, "call_read_1");
  assert.equal(out.messages[1].tool_calls[0].function.name, "read");
  assert.equal(out.messages[2].role, "tool");
  assert.equal(out.messages[2].tool_call_id, "call_read_1");
  assert.equal(out.messages[2].content, "{\"content\":\"hello\"}");
});

test("chatCompletionsToResponsesText converts tool calls back into responses output", () => {
  const raw = JSON.stringify({
    id: "chatcmpl_123",
    object: "chat.completion",
    created: 1780766344,
    model: "gpt-5.4-mini",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read_2",
              type: "function",
              function: {
                name: "read",
                arguments: "{\"path\":\"/tmp/docs/README.md\"}",
              },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 12,
      total_tokens: 112,
    },
  });

  const out = JSON.parse(hooks.chatCompletionsToResponsesText(raw));

  assert.equal(out.status, "incomplete");
  assert.equal(out.model, "gpt-5.4-mini");
  assert.equal(out.output_text, "");
  assert.equal(Array.isArray(out.output), true);
  assert.equal(out.output[0].type, "function_call");
  assert.equal(out.output[0].call_id, "call_read_2");
  assert.equal(out.output[0].name, "read");
  assert.equal(out.output[0].arguments, "{\"path\":\"/tmp/docs/README.md\"}");
  assert.deepEqual(out.usage, {
    input_tokens: 100,
    output_tokens: 12,
    total_tokens: 112,
  });
});

test("convertChatCompletionsSseToResponsesSse preserves output text and usage in responses events", () => {
  const rawSse = [
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1780766344,"model":"gpt-5.4-mini","choices":[{"index":0,"delta":{"content":"Hello "}}]}',
    "",
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1780766344,"model":"gpt-5.4-mini","choices":[{"index":0,"delta":{"content":"world"}}]}',
    "",
    'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":1780766344,"model":"gpt-5.4-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":12,"total_tokens":112}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const out = hooks.convertChatCompletionsSseToResponsesSse(rawSse);

  assert.match(out, /response\.output_text\.delta/);
  assert.match(out, /response\.output_text\.done/);
  assert.match(out, /response\.completed/);
  assert.match(out, /Hello world/);
  assert.match(out, /"input_tokens":100/);
  assert.match(out, /"output_tokens":12/);
  assert.match(out, /"total_tokens":112/);
});
