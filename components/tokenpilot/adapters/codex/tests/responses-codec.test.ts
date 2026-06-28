import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexSessionResolver,
  createCodexResponsesPayloadCodec,
  extractResponsesInputText,
  syncPayloadFromEnvelope,
} from "../src/responses-codec.js";

test("extractResponsesInputText flattens mixed Responses input blocks", () => {
  const text = extractResponsesInputText([
    { role: "developer", content: "system prompt" },
    { role: "user", content: [{ type: "input_text", text: "hello" }, { type: "input_text", content: "world" }] },
    { type: "function_call", arguments: "{\"x\":1}" },
    { type: "function_call_output", output: "{\"ok\":true}" },
  ]);

  assert.equal(text, "system prompt\nhello\nworld\n{\"x\":1}\n{\"ok\":true}");
});

test("codec normalizes developer role on decode and restores it on encode", () => {
  const codec = createCodexResponsesPayloadCodec();
  const rawPayload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [
      { role: "developer", content: "stay stable" },
      { role: "user", content: "hello" },
    ],
    prompt_cache_key: "pk-1",
    previous_response_id: "resp-prev",
  };

  const envelope = codec.decodeRequest(rawPayload);
  assert.equal(envelope.messages[0]?.role, "system");
  assert.equal((envelope.messages[0] as any)?.metadata?.__codexOriginalRole, "developer");
  assert.equal(envelope.metadata?.promptCacheKey, "pk-1");

  const encoded = codec.encodeRequest(envelope) as any;
  assert.equal(encoded.input[0].role, "developer");
  assert.equal(encoded.input[1].role, "user");
  assert.equal(encoded.prompt_cache_key, "pk-1");
  assert.equal(encoded.previous_response_id, "resp-prev");
  assert.equal(encoded.input[0].metadata, undefined);
});

test("codec preserves responses input items that do not carry message roles", () => {
  const codec = createCodexResponsesPayloadCodec();
  const rawPayload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [
      { role: "developer", content: "stay stable" },
      { type: "function_call_output", call_id: "call-1", output: "{\"ok\":true}" },
      { type: "reasoning", summary: [] },
    ],
  };

  const envelope = codec.decodeRequest(rawPayload);
  const encoded = codec.encodeRequest(envelope) as any;

  assert.equal(encoded.input[0].role, "developer");
  assert.equal(encoded.input[1].type, "function_call_output");
  assert.equal(encoded.input[1].role, undefined);
  assert.equal(encoded.input[2].type, "reasoning");
  assert.equal(encoded.input[2].role, undefined);
});

test("codex session resolver uses mapped previous response session instead of raw previous_response_id", () => {
  const codec = createCodexResponsesPayloadCodec(
    createCodexSessionResolver({
      mappedPreviousSessionId: "session-from-index",
    }),
  );
  const envelope = codec.decodeRequest({
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    previous_response_id: "resp-prev",
    input: [{ role: "user", content: "continue" }],
  });

  assert.equal(envelope.session.sessionId, "session-from-index");
});

test("codex session resolver synthesizes a per-request session id when host session markers are absent", () => {
  const codec = createCodexResponsesPayloadCodec();
  const payloadA: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [{ role: "user", content: "turn a" }],
  };
  const payloadB: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [{ role: "user", content: "turn b" }],
  };

  const envelopeA = codec.decodeRequest(payloadA);
  const envelopeB = codec.decodeRequest(payloadB);

  assert.match(envelopeA.session.sessionId, /^codex-synth-/);
  assert.match(envelopeB.session.sessionId, /^codex-synth-/);
  assert.notEqual(envelopeA.session.sessionId, envelopeB.session.sessionId);
  assert.equal((payloadA.metadata as Record<string, unknown>)?.tokenpilotSyntheticSessionId, envelopeA.session.sessionId);
  assert.equal((payloadB.metadata as Record<string, unknown>)?.tokenpilotSyntheticSessionId, envelopeB.session.sessionId);
});

test("syncPayloadFromEnvelope updates managed fields in place while preserving unknown payload fields", () => {
  const codec = createCodexResponsesPayloadCodec();
  const rawPayload: any = {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [{ role: "developer", content: "hi" }],
    tools: [{ name: "bash" }],
    extraField: "remove-me",
  };
  const envelope = codec.decodeRequest(rawPayload);
  envelope.instructions = "new instructions";
  envelope.tools = undefined;
  envelope.metadata = {
    ...(envelope.metadata ?? {}),
    promptCacheKey: "cache-stable",
  };

  const synced = syncPayloadFromEnvelope(rawPayload, envelope, codec) as any;
  assert.equal(synced, rawPayload);
  assert.equal(rawPayload.instructions, "new instructions");
  assert.equal(rawPayload.prompt_cache_key, "cache-stable");
  assert.equal("tools" in rawPayload, false);
  assert.equal(rawPayload.extraField, "remove-me");
});
