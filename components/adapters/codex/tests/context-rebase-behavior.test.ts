import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCodexContextRewrite,
  buildCodexRebaseRequest,
  executeCodexRebaseWithFallback,
  withCodexRebaseReplayAccountingInput,
  type CodexEffectiveHistory,
  type JsonObject,
} from "../src/context-rewrite/index.js";

const EVICTED_SENTINEL = "EVICT_ME_cdr02_behavior";
const RETAINED_SENTINEL = "KEEP_ME_cdr02_behavior";
const CURRENT_SENTINEL = "CURRENT_INPUT_cdr02_behavior";

type ResponsesPayload = JsonObject & {
  model?: string;
  stream?: boolean;
  previous_response_id?: string;
  prompt_cache_key?: string;
  instructions?: string;
  tools?: unknown[];
  input?: unknown[];
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function textFromResponsesInput(input: unknown): string {
  if (!Array.isArray(input)) return "";
  const parts: string[] = [];
  for (const item of input) {
    const entry = asObject(item);
    if (typeof entry.content === "string") parts.push(entry.content);
    if (typeof entry.output === "string") parts.push(entry.output);
    if (typeof entry.arguments === "string") parts.push(entry.arguments);
    if (Array.isArray(entry.content)) {
      for (const block of entry.content) {
        if (!block || typeof block !== "object") continue;
        if (typeof block.text === "string") parts.push(block.text);
        if (typeof block.content === "string") parts.push(block.content);
      }
    }
  }
  return parts.join("\n");
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function estimatedTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function baseResponsesPayload(): ResponsesPayload {
  return {
    model: "gpt-5.4-mini",
    stream: true,
    previous_response_id: "resp-old-chain",
    prompt_cache_key: "pk-stable-codex-session",
    instructions: "Follow the repo instructions.",
    tools: [
      {
        type: "function",
        function: {
          name: "run_tests",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ],
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: `${CURRENT_SENTINEL}: continue the migration` }],
      },
    ],
  };
}

function effectiveHistoryFixture(): CodexEffectiveHistory {
  return {
    revision: "history-rev-1",
    replayableItems: [
      {
        stableItemId: "developer-1",
        nativeId: "msg-dev-1",
        item: { role: "developer", content: "Shared stable instructions" },
      },
      {
        stableItemId: "evicted-user-1",
        nativeId: "msg-user-evict",
        item: { role: "user", content: `obsolete details ${EVICTED_SENTINEL}` },
      },
      {
        stableItemId: "retained-user-1",
        nativeId: "msg-user-keep",
        item: { role: "user", content: `important details ${RETAINED_SENTINEL}` },
      },
      {
        stableItemId: "call-1",
        nativeId: "fc-1",
        item: { type: "function_call", call_id: "call-1", name: "run_tests", arguments: "{\"command\":\"npm test\"}" },
      },
      {
        stableItemId: "result-1",
        nativeId: "fco-1",
        item: { type: "function_call_output", call_id: "call-1", output: "{\"ok\":true}" },
      },
    ],
    observationOnlyItems: [
      {
        stableItemId: "web-search-1",
        nativeId: "ws-1",
        item: { type: "web_search_call", query: "not replayable by default" },
      },
    ],
    deferredItems: [],
    unresolvedCallIds: [],
    source: "proxy_journal",
    incomplete: false,
  };
}

test("CDR-02 builds a rebase request that removes previous_response_id and evicted history", async () => {
  const originalPayload = baseResponsesPayload();

  const result = buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-evict-obsolete-details",
    baseRevision: "history-rev-1",
    originalPayload,
    effectiveHistory: effectiveHistoryFixture(),
    currentInput: originalPayload.input,
    mutationPlan: {
      operations: [{ type: "evict", stableItemId: "evicted-user-1" }],
    },
  });

  const payload = result.payload as ResponsesPayload;
  assert.equal("previous_response_id" in payload, false);
  assert.equal(payload.model, originalPayload.model);
  assert.equal(payload.stream, originalPayload.stream);
  assert.equal(payload.instructions, originalPayload.instructions);
  assert.deepEqual(payload.tools, originalPayload.tools);
  assert.equal(payload.prompt_cache_key, originalPayload.prompt_cache_key);

  const forwardedText = textFromResponsesInput(payload.input);
  assert.equal(forwardedText.includes(EVICTED_SENTINEL), false);
  assert.equal(forwardedText.includes(RETAINED_SENTINEL), true);
  assert.equal(occurrences(forwardedText, CURRENT_SENTINEL), 1);
  const inputItems = Array.isArray(payload.input) ? payload.input : [];
  assert.equal(
    inputItems.some((item) => asObject(item).type === "web_search_call"),
    false,
  );
});

test("CDR-01 rejects stale revisions before constructing a rebase request", () => {
  const originalPayload = baseResponsesPayload();
  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-stale",
    baseRevision: "history-rev-stale",
    originalPayload,
    effectiveHistory: effectiveHistoryFixture(),
    currentInput: originalPayload.input,
    mutationPlan: { operations: [] },
  }), /revision_mismatch/);
});

test("CDR-02 builds rebase accounting for replay cost and break-even", () => {
  const originalPayload = baseResponsesPayload();
  const history = effectiveHistoryFixture();
  const result = buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-accounting",
    baseRevision: history.revision,
    originalPayload,
    effectiveHistory: history,
    currentInput: originalPayload.input,
    mutationPlan: {
      operations: [{ type: "evict", stableItemId: "evicted-user-1" }],
    },
  });
  const evictedItem = history.replayableItems.find((entry) => entry.stableItemId === "evicted-user-1");
  assert.ok(evictedItem);
  const evictedChars = jsonChars(evictedItem.item);
  const rebaseReplayChars = jsonChars(result.payload.input);

  assert.equal(result.accounting.plannedSavedChars, evictedChars);
  assert.equal(result.accounting.plannedSavedTokens, estimatedTokens(evictedChars));
  assert.equal(result.accounting.actuallyRemovedChars, evictedChars);
  assert.equal(result.accounting.actuallyRemovedTokens, estimatedTokens(evictedChars));
  assert.equal(result.accounting.rebaseReplayCostChars, rebaseReplayChars);
  assert.equal(result.accounting.rebaseReplayCostTokens, estimatedTokens(rebaseReplayChars));
  assert.equal(result.accounting.subsequentSavedCharsPerTurn, evictedChars);
  assert.equal(result.accounting.subsequentSavedTokensPerTurn, estimatedTokens(evictedChars));
  assert.equal(result.accounting.estimatorCostChars, 0);
  assert.equal(result.accounting.estimatorCostTokens, 0);
  assert.equal(result.accounting.fallbackExtraRequestCount, 0);
  assert.equal(result.accounting.cacheColdMissCount, 1);
  assert.equal(result.accounting.breakEvenTurn, Math.ceil(rebaseReplayChars / evictedChars));
});

test("CDR-02 refreshes replay accounting after downstream input changes", () => {
  const originalPayload = baseResponsesPayload();
  const history = effectiveHistoryFixture();
  const result = buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-accounting-refresh",
    baseRevision: history.revision,
    originalPayload,
    effectiveHistory: history,
    currentInput: originalPayload.input,
    mutationPlan: {
      operations: [{ type: "evict", stableItemId: "evicted-user-1" }],
    },
  });
  const reducedInput = [{ role: "user", content: "reduced current input" }];
  const refreshed = withCodexRebaseReplayAccountingInput(result.accounting, reducedInput);

  assert.equal(refreshed.rebaseReplayCostChars, jsonChars(reducedInput));
  assert.equal(refreshed.rebaseReplayCostTokens, estimatedTokens(jsonChars(reducedInput)));
  assert.equal(
    refreshed.breakEvenTurn,
    Math.ceil(jsonChars(reducedInput) / result.accounting.subsequentSavedCharsPerTurn),
  );
  assert.equal(refreshed.plannedSavedChars, result.accounting.plannedSavedChars);
  assert.equal(refreshed.actuallyRemovedChars, result.accounting.actuallyRemovedChars);
});

test("CDR-01 rejects effective history containing deferred provider items", () => {
  const originalPayload = baseResponsesPayload();
  const effectiveHistory = effectiveHistoryFixture();
  effectiveHistory.deferredItems.push({
    stableItemId: "deferred-1",
    nativeId: "future-1",
    item: { type: "future_provider_item", payload: "opaque" },
  });
  effectiveHistory.incomplete = true;

  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-deferred",
    baseRevision: effectiveHistory.revision,
    originalPayload,
    effectiveHistory,
    currentInput: originalPayload.input,
    mutationPlan: { operations: [] },
  }), /effective_history_incomplete/);
});

test("CDR-01 rejects mutations that break function call closure", () => {
  const originalPayload = baseResponsesPayload();
  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-orphan-output",
    baseRevision: "history-rev-1",
    originalPayload,
    effectiveHistory: effectiveHistoryFixture(),
    currentInput: originalPayload.input,
    mutationPlan: { operations: [{ type: "evict", stableItemId: "call-1" }] },
  }), /tool_closure_incomplete:call-1/);
});

test("CDR-01 allows a function call and its output to be evicted together", () => {
  const originalPayload = baseResponsesPayload();
  const result = buildCodexRebaseRequest({
    sessionId: "codex-session-1",
    planId: "plan-closed-tool-eviction",
    baseRevision: "history-rev-1",
    originalPayload,
    effectiveHistory: effectiveHistoryFixture(),
    currentInput: originalPayload.input,
    mutationPlan: {
      operations: [
        { type: "evict", stableItemId: "call-1" },
        { type: "evict", stableItemId: "result-1" },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(result.payload.input), /call-1/);
});

test("CDR-01 rejects malformed, duplicate, and protocol-mismatched tool closure", () => {
  const originalPayload = baseResponsesPayload();
  const assertUnsafeCurrentInput = (currentInput: JsonObject[], reason: RegExp) => {
    assert.throws(() => buildCodexRebaseRequest({
      sessionId: "codex-session-1",
      planId: "plan-malformed-tool-closure",
      baseRevision: "history-rev-1",
      originalPayload: { ...originalPayload, input: currentInput },
      effectiveHistory: { ...effectiveHistoryFixture(), replayableItems: [] },
      currentInput,
      mutationPlan: { operations: [] },
    }), reason);
  };

  assertUnsafeCurrentInput([
    { type: "function_call", name: "run", arguments: "{}" },
  ], /tool_call_id_missing:function_call/);
  assertUnsafeCurrentInput([
    { type: "function_call", call_id: "duplicate", name: "run", arguments: "{}" },
    { type: "function_call", call_id: "duplicate", name: "run_again", arguments: "{}" },
    { type: "function_call_output", call_id: "duplicate", output: "done" },
  ], /tool_call_duplicate:duplicate/);
  assertUnsafeCurrentInput([
    { type: "function_call", call_id: "mismatch", name: "run", arguments: "{}" },
    { type: "custom_tool_call_output", call_id: "mismatch", output: "done" },
  ], /tool_closure_type_mismatch:mismatch/);
  assertUnsafeCurrentInput([
    { type: "function_call_output", call_id: "reversed", output: "done" },
    { type: "function_call", call_id: "reversed", name: "run", arguments: "{}" },
  ], /tool_output_before_call:reversed/);
});

test("CDR-01 replays PTC program state and caller links exactly", () => {
  const caller = { type: "program", caller_id: "call-program-1" };
  const effectiveHistory: CodexEffectiveHistory = {
    revision: "history-ptc-1",
    replayableItems: [
      {
        stableItemId: "program-1",
        nativeId: "prog-1",
        item: {
          id: "prog-server-1",
          type: "program",
          call_id: "call-program-1",
          code: "const value = await tools.lookup({}); text(value);",
          fingerprint: "opaque-program-fingerprint",
        },
      },
      {
        stableItemId: "program-call-1",
        nativeId: "fc-program-1",
        item: {
          id: "fc-server-1",
          type: "function_call",
          call_id: "call-nested-1",
          name: "lookup",
          arguments: "{}",
          caller,
        },
      },
      {
        stableItemId: "program-call-output-1",
        nativeId: "fco-program-1",
        item: {
          type: "function_call_output",
          call_id: "call-nested-1",
          output: "value",
          caller,
        },
      },
      {
        stableItemId: "program-output-1",
        nativeId: "prog-out-1",
        item: {
          id: "prog-out-server-1",
          type: "program_output",
          call_id: "call-program-1",
          result: "value",
          status: "completed",
        },
      },
    ],
    observationOnlyItems: [],
    deferredItems: [],
    unresolvedCallIds: [],
    source: "proxy_journal",
    incomplete: false,
  };
  const originalPayload = { ...baseResponsesPayload(), input: [{ role: "user", content: "continue" }] };
  const result = buildCodexRebaseRequest({
    sessionId: "codex-session-ptc",
    planId: "plan-ptc",
    baseRevision: effectiveHistory.revision,
    originalPayload,
    effectiveHistory,
    currentInput: originalPayload.input,
    mutationPlan: { operations: [] },
  });
  const input = result.payload.input as JsonObject[];
  const program = input.find((item) => item.type === "program");
  const call = input.find((item) => item.type === "function_call");
  const output = input.find((item) => item.type === "function_call_output");
  const programOutput = input.find((item) => item.type === "program_output");
  assert.equal(program?.id, undefined);
  assert.equal(program?.fingerprint, "opaque-program-fingerprint");
  assert.deepEqual(call?.caller, caller);
  assert.deepEqual(output?.caller, caller);
  assert.equal(programOutput?.id, undefined);
  assert.equal(programOutput?.status, "completed");
});

test("CDR-01 rejects broken PTC program dependencies and changed caller payloads", () => {
  const program = {
    stableItemId: "program-1",
    nativeId: "prog-1",
    item: {
      type: "program",
      call_id: "call-program-1",
      code: "const value = await tools.lookup({}); text(value);",
      fingerprint: "opaque-program-fingerprint",
    },
  };
  const call = {
    stableItemId: "program-call-1",
    nativeId: "fc-program-1",
    callId: "call-nested-1",
    item: {
      type: "function_call",
      call_id: "call-nested-1",
      name: "lookup",
      arguments: "{}",
      caller: { type: "program", caller_id: "call-program-1" },
    },
  };
  const effectiveHistory: CodexEffectiveHistory = {
    revision: "history-ptc-broken",
    replayableItems: [program, call],
    observationOnlyItems: [],
    deferredItems: [],
    unresolvedCallIds: ["call-nested-1"],
    source: "proxy_journal",
    incomplete: false,
  };
  const mismatchedOutput = [{
    type: "function_call_output",
    call_id: "call-nested-1",
    output: "value",
    caller: { type: "program", caller_id: "different-program" },
  }];
  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-ptc",
    planId: "plan-ptc-caller-mismatch",
    baseRevision: effectiveHistory.revision,
    originalPayload: { ...baseResponsesPayload(), input: mismatchedOutput },
    effectiveHistory,
    currentInput: mismatchedOutput,
    mutationPlan: { operations: [] },
  }), /program_caller_mismatch:call-nested-1/);

  const exactOutput = [{
    type: "function_call_output",
    call_id: "call-nested-1",
    output: "value",
    caller: { type: "program", caller_id: "call-program-1" },
  }];
  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-ptc",
    planId: "plan-ptc-evict-program",
    baseRevision: effectiveHistory.revision,
    originalPayload: { ...baseResponsesPayload(), input: exactOutput },
    effectiveHistory,
    currentInput: exactOutput,
    mutationPlan: { operations: [{ type: "evict", stableItemId: "program-1" }] },
  }), /program_caller_missing:call-program-1/);

  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-ptc",
    planId: "plan-ptc-orphan-output",
    baseRevision: "history-empty",
    originalPayload: baseResponsesPayload(),
    effectiveHistory: {
      revision: "history-empty",
      replayableItems: [],
      observationOnlyItems: [],
      deferredItems: [],
      unresolvedCallIds: [],
      source: "proxy_journal",
      incomplete: false,
    },
    currentInput: [{
      type: "program_output",
      call_id: "call-orphan-program",
      result: "done",
      status: "completed",
    }],
    mutationPlan: { operations: [] },
  }), /program_output_orphan:call-orphan-program/);
});

test("CDR-01 preserves client tool-search closure and replay status", () => {
  const toolSearchInput = [
    {
      id: "tool-search-server-call",
      type: "tool_search_call",
      call_id: "tool-search-1",
      execution: "client",
      status: "completed",
      query: "weather tool",
    },
    {
      id: "tool-search-server-output",
      type: "tool_search_output",
      call_id: "tool-search-1",
      execution: "client",
      status: "completed",
      tools: [{ type: "function", name: "weather" }],
    },
  ];
  const effectiveHistory: CodexEffectiveHistory = {
    revision: "history-tool-search",
    replayableItems: toolSearchInput.map((item, index) => ({
      stableItemId: `tool-search-${index}`,
      nativeId: `tool-search-native-${index}`,
      callId: "tool-search-1",
      item,
    })),
    observationOnlyItems: [],
    deferredItems: [],
    unresolvedCallIds: [],
    source: "proxy_journal",
    incomplete: false,
  };
  const result = buildCodexRebaseRequest({
    sessionId: "codex-session-tool-search",
    planId: "plan-tool-search",
    baseRevision: effectiveHistory.revision,
    originalPayload: { ...baseResponsesPayload(), input: [{ role: "user", content: "continue" }] },
    effectiveHistory,
    currentInput: [{ role: "user", content: "continue" }],
    mutationPlan: { operations: [] },
  });
  const input = result.payload.input as JsonObject[];
  assert.equal(input[0]?.id, undefined);
  assert.equal(input[0]?.status, "completed");
  assert.equal(input[1]?.id, undefined);
  assert.equal(input[1]?.status, "completed");

  const incompleteHistory = {
    ...effectiveHistory,
    replayableItems: [effectiveHistory.replayableItems[0]!],
  };
  assert.throws(() => buildCodexRebaseRequest({
    sessionId: "codex-session-tool-search",
    planId: "plan-tool-search-incomplete",
    baseRevision: incompleteHistory.revision,
    originalPayload: { ...baseResponsesPayload(), input: [{ role: "user", content: "continue" }] },
    effectiveHistory: incompleteHistory,
    currentInput: [{ role: "user", content: "continue" }],
    mutationPlan: { operations: [] },
  }), /tool_closure_incomplete:tool-search-1/);
});

test("CDR-04 retries the original request once when rebase replay is rejected upstream", async () => {
  const originalPayload = baseResponsesPayload();
  const rebasedPayload: ResponsesPayload = {
    ...originalPayload,
    input: [{ role: "user", content: `rebased ${RETAINED_SENTINEL} ${CURRENT_SENTINEL}` }],
  };
  delete rebasedPayload.previous_response_id;
  const sentPayloads: JsonObject[] = [];

  const result = await executeCodexRebaseWithFallback({
    sessionId: "codex-session-1",
    planId: "plan-evict-obsolete-details",
    epochId: "epoch-1",
    originalPayload,
    rebasedPayload,
    async sendUpstream(payload: JsonObject) {
      sentPayloads.push(payload);
      if (sentPayloads.length === 1) {
        return {
          status: 400,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ error: { message: "unsupported replay item", code: "invalid_request_error" } }),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ id: "resp-original-fallback", output: [] }),
      };
    },
  });

  assert.equal(sentPayloads.length, 2);
  assert.equal("previous_response_id" in (sentPayloads[0] ?? {}), false);
  assert.equal(sentPayloads[1]?.previous_response_id, "resp-old-chain");
  assert.equal(result.response.status, 200);
  assert.match(result.response.text, /resp-original-fallback/);
  assert.equal(result.outcome, "bypassed");
  assert.equal(result.cooldown?.planId, "plan-evict-obsolete-details");
});

test("CDR-03 does not commit a 2xx rebase response without a response id", async () => {
  const originalPayload = baseResponsesPayload();
  const sentPayloads: JsonObject[] = [];
  const result = await executeCodexRebaseWithFallback({
    sessionId: "codex-session-1",
    planId: "plan-missing-response-id",
    epochId: "epoch-1",
    originalPayload,
    rebasedPayload: { ...originalPayload, previous_response_id: undefined },
    async sendUpstream(payload) {
      sentPayloads.push(payload);
      if (sentPayloads.length === 1) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({ output: [] }),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ id: "resp-original-fallback", output: [] }),
      };
    },
  });

  assert.equal(sentPayloads.length, 2);
  assert.equal(result.outcome, "bypassed");
  assert.equal(result.newResponseId, undefined);
  assert.equal(result.cooldown?.reason, "rebase_response_id_missing");
});

test("CDR-03 does not commit non-terminal non-stream responses", async () => {
  for (const status of ["queued", "in_progress", "cancelled"]) {
    const sentPayloads: JsonObject[] = [];
    const result = await executeCodexRebaseWithFallback({
      sessionId: "codex-session-1",
      planId: `plan-${status}`,
      epochId: `epoch-${status}`,
      originalPayload: baseResponsesPayload(),
      rebasedPayload: { input: [] },
      async sendUpstream(payload) {
        sentPayloads.push(payload);
        return sentPayloads.length === 1
          ? {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify({ id: `resp-${status}`, status }),
          }
          : {
            status: 200,
            headers: { "content-type": "application/json" },
            text: JSON.stringify({ id: "resp-original-fallback", status: "completed" }),
          };
      },
    });

    assert.equal(sentPayloads.length, 2);
    assert.equal(result.outcome, "bypassed");
    assert.equal(result.newResponseId, undefined);
    assert.equal(result.cooldown?.reason, `rebase_response_${status}`);
  }
});

test("CDR-03 commits a streaming rebase only after observing its response id", async () => {
  const result = await executeCodexRebaseWithFallback({
    sessionId: "codex-session-1",
    planId: "plan-streaming-response",
    epochId: "epoch-1",
    originalPayload: baseResponsesPayload(),
    rebasedPayload: { input: [] },
    async sendUpstream() {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        text: [
          "event: response.created",
          "data: {\"response\":{\"id\":\"resp-rebased-stream\"}}",
          "",
          "event: response.completed",
          "data: {\"response\":{\"id\":\"resp-rebased-stream\"}}",
          "",
          "data: [DONE]",
          "",
        ].join("\n"),
      };
    },
  });

  assert.equal(result.outcome, "committed");
  assert.equal(result.newResponseId, "resp-rebased-stream");
});

test("CDR-03 does not commit a failed streaming rebase after response.created", async () => {
  const sentPayloads: JsonObject[] = [];
  const result = await executeCodexRebaseWithFallback({
    sessionId: "codex-session-1",
    planId: "plan-failed-streaming-response",
    epochId: "epoch-1",
    originalPayload: baseResponsesPayload(),
    rebasedPayload: { input: [] },
    async sendUpstream(payload) {
      sentPayloads.push(payload);
      if (sentPayloads.length === 1) {
        return {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          text: [
            "event: response.created",
            "data: {\"response\":{\"id\":\"resp-failed-stream\"}}",
            "",
            "event: response.failed",
            "data: {\"response\":{\"id\":\"resp-failed-stream\"}}",
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ id: "resp-original-fallback", output: [] }),
      };
    },
  });

  assert.equal(sentPayloads.length, 2);
  assert.equal(result.outcome, "bypassed");
  assert.equal(result.newResponseId, undefined);
  assert.equal(result.rebaseResponse?.status, 200);
  assert.match(result.response.text, /resp-original-fallback/);
});

test("CDR-04 falls back to the original request after a transport error", async () => {
  let calls = 0;
  const result = await executeCodexRebaseWithFallback({
    sessionId: "codex-session-1",
    planId: "plan-transport-error",
    epochId: "epoch-1",
    originalPayload: baseResponsesPayload(),
    rebasedPayload: { input: [] },
    async sendUpstream() {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({ id: "resp-original-fallback", output: [] }),
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.outcome, "bypassed");
  assert.equal(result.rebaseResponse, undefined);
  assert.equal(result.cooldown?.reason, "rebase_upstream_error");
});

test("CDR-07 leaves the Codex payload equivalent when context rewrite is disabled", async () => {
  const originalPayload = baseResponsesPayload();
  const before = JSON.parse(JSON.stringify(originalPayload));

  const result = await applyCodexContextRewrite({
    config: {
      enabled: false,
      mode: "response_chain_rebase",
      failureMode: "bypass",
      retryOriginalRequest: true,
      cooldownMs: 300_000,
    },
    sessionId: "codex-session-1",
    payload: originalPayload,
    effectiveHistory: effectiveHistoryFixture(),
    mutationPlan: {
      operations: [{ type: "evict", stableItemId: "evicted-user-1" }],
    },
  });

  assert.deepEqual(result.payload, before);
  assert.equal(result.outcome, "disabled");
  assert.equal(result.rebaseAttempted, false);
});
