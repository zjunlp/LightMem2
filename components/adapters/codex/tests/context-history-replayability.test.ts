import assert from "node:assert/strict";
import test from "node:test";

import {
  codexReplayabilityForItem,
  isCodexDeferredItem,
  isCodexObservationOnlyItem,
  type CodexReplayabilityMode,
  type CodexReplayabilityReason,
  type JsonObject,
} from "../src/context-history/index.js";

function assertReplayability(
  item: JsonObject,
  mode: CodexReplayabilityMode,
  reason: CodexReplayabilityReason,
): void {
  assert.deepEqual(codexReplayabilityForItem(item), { mode, reason });
}

test("CDH-05 Replayability classifies messages and tool call pairs as replayable by default", () => {
  assertReplayability({ role: "user", content: "user input" }, "replayable", "default_replayable");
  assertReplayability({ role: "developer", content: "stable instruction" }, "replayable", "default_replayable");
  assertReplayability({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "assistant output" }],
  }, "replayable", "default_replayable");
  assertReplayability({
    type: "function_call",
    call_id: "call-1",
    name: "run_tests",
    arguments: "{}",
  }, "replayable", "tool_closure_required");
  assertReplayability({
    type: "function_call_output",
    call_id: "call-1",
    output: "{\"ok\":true}",
  }, "replayable", "tool_closure_required");
  assertReplayability({
    type: "custom_tool_call",
    call_id: "custom-1",
    name: "edit",
    input: "payload",
  }, "replayable", "tool_closure_required");
  assertReplayability({
    type: "custom_tool_call_output",
    call_id: "custom-1",
    output: "{\"edited\":true}",
  }, "replayable", "tool_closure_required");
});

test("CDH-05 Replayability defers tool items without a usable call id", () => {
  for (const item of [
    { type: "function_call", name: "run_tests", arguments: "{}" },
    { type: "function_call_output", call_id: "", output: "done" },
    { type: "custom_tool_call", call_id: "   ", name: "edit", input: "payload" },
    { type: "custom_tool_call_output", output: "done" },
  ]) {
    assertReplayability(item, "deferred", "tool_call_id_missing");
  }
});

test("CDH-05 Replayability keeps exact encrypted reasoning payloads replayable", () => {
  const reasoning = {
    id: "rs-1",
    type: "reasoning",
    encrypted_content: "opaque-provider-payload",
  };

  assertReplayability(reasoning, "replayable", "exact_payload_required");
  assert.equal(isCodexObservationOnlyItem(reasoning), false);
});

test("CDH-05 Replayability keeps exact encrypted compaction payloads replayable", () => {
  const compaction = {
    id: "cmp-1",
    type: "compaction",
    encrypted_content: "opaque-compaction-payload",
    internal_chat_message_metadata_passthrough: { source: "codex" },
  };

  assertReplayability(compaction, "replayable", "exact_payload_required");
  assert.equal(isCodexObservationOnlyItem(compaction), false);
});

test("CDH-05 Replayability defers reasoning without its exact encrypted payload", () => {
  const reasoning = {
    id: "rs-summary-only",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "partial" }],
  };

  assertReplayability(reasoning, "deferred", "exact_payload_missing");
  assert.equal(isCodexDeferredItem(reasoning), true);
});

test("CDH-05 Replayability defers compaction without its exact encrypted payload", () => {
  const compaction = {
    id: "cmp-missing-payload",
    type: "compaction",
  };

  assertReplayability(compaction, "deferred", "exact_payload_missing");
  assert.equal(isCodexDeferredItem(compaction), true);
});

test("CDH-05 Replayability recognizes the full Responses client-tool closure family", () => {
  for (const type of [
    "computer_call",
    "computer_call_output",
    "local_shell_call",
    "local_shell_call_output",
    "shell_call",
    "shell_call_output",
    "apply_patch_call",
    "apply_patch_call_output",
  ]) {
    assertReplayability({ type, call_id: `call-${type}` }, "replayable", "tool_closure_required");
  }
});

test("CDH-05 Replayability requires exact program replay state", () => {
  assertReplayability({
    type: "program",
    call_id: "call-program",
    code: "text('done')",
    fingerprint: "opaque-program-state",
  }, "replayable", "program_payload_required");
  assertReplayability({
    type: "program_output",
    call_id: "call-program",
    result: "done",
    status: "completed",
  }, "replayable", "program_payload_required");
  assertReplayability({
    type: "program",
    call_id: "call-program",
    code: "text('done')",
  }, "deferred", "program_payload_missing");
  assertReplayability({
    type: "program_output",
    call_id: "call-program",
  }, "deferred", "program_payload_missing");
});

test("CDH-05 Replayability recognizes provider-produced Responses replay items", () => {
  for (const type of [
    "web_search_call",
    "file_search_call",
    "code_interpreter_call",
    "image_generation_call",
    "mcp_call",
    "mcp_list_tools",
    "mcp_approval_request",
    "mcp_approval_response",
    "tool_search_call",
    "tool_search_output",
    "additional_tools",
  ]) {
    assertReplayability({ type }, "replayable", "provider_output_replay");
  }
});

test("CDH-05 Replayability requires client tool-search call/output ids but accepts hosted items", () => {
  assertReplayability({
    type: "tool_search_call",
    execution: "client",
    call_id: "search-1",
  }, "replayable", "tool_closure_required");
  assertReplayability({
    type: "tool_search_output",
    execution: "client",
    call_id: "search-1",
    tools: [],
  }, "replayable", "tool_closure_required");
  assertReplayability({
    type: "tool_search_call",
    execution: "client",
  }, "deferred", "tool_call_id_missing");
  assertReplayability({
    type: "tool_search_call",
    execution: "server",
    call_id: null,
  }, "replayable", "provider_output_replay");
});

test("CDH-05 Replayability separates exact encrypted payloads from malformed payloads", () => {
  for (const type of ["reasoning", "compaction"] as const) {
    assertReplayability(
      { type, encrypted_content: `exact-${type}` },
      "replayable",
      "exact_payload_required",
    );
    for (const encrypted_content of ["", "   ", 42, { opaque: true }]) {
      assertReplayability(
        { type, encrypted_content },
        "deferred",
        "exact_payload_missing",
      );
    }
  }
});

test("CDH-05 Replayability defers unknown provider item types", () => {
  const item = { type: "future_provider_item", payload: "opaque" };

  assertReplayability(item, "deferred", "unsupported_item_type");
  assert.equal(isCodexDeferredItem(item), true);
});

test("CDH-05 Replayability replays Responses output items but keeps runtime events observation-only", () => {
  const webSearch = { type: "web_search_call", query: "provider-owned output" };
  assertReplayability(webSearch, "replayable", "provider_output_replay");
  assert.equal(isCodexObservationOnlyItem(webSearch), false);
  const event = { type: "event_msg", message: "runtime event" };
  assertReplayability(event, "observation_only", "provider_observation");
  assert.equal(isCodexObservationOnlyItem(event), true);
  const turnContext = { type: "turn_context", content: "current turn metadata" };
  assertReplayability(turnContext, "observation_only", "turn_context_instruction");
  assert.equal(isCodexObservationOnlyItem(turnContext), true);
});
