import assert from "node:assert/strict";
import test from "node:test";

import {
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
