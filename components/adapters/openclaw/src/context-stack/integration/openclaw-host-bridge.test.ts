import test from "node:test";
import assert from "node:assert/strict";

import { createOpenClawHostBridge } from "./openclaw-host-bridge.js";

test("openclaw host bridge exposes request/response/stream host views", () => {
  const bridge = createOpenClawHostBridge({
    extractInputText: (input: any) => Array.isArray(input) ? input.map((item) => String(item?.content ?? "")).join("\n") : "",
    extractProviderResponseText: (raw: string) => raw.includes("hello") ? "hello" : "",
    contentToText: (value: unknown) => String(value ?? ""),
  });

  const request = bridge.decodeRequest({
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [{ role: "user", content: "hi" }],
  });
  const response = bridge.decodeResponse({
    id: "resp-1",
    output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
  }, {
    model: "tokenpilot/gpt-5.4-mini",
    stream: false,
    input: [{ role: "user", content: "hi" }],
  });
  const stream = bridge.snapshotStream([
    'data: {"response":{"prompt_cache_key":"pk-stream-1"}}',
    'data: {"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":64}}}',
    "data: hello",
    "",
  ].join("\n"));

  assert.equal(request.model, "tokenpilot/gpt-5.4-mini");
  assert.equal(response.metadata?.responseId, "resp-1");
  assert.equal(stream.assistantText, "hello");
  assert.equal(stream.promptCacheKey, "pk-stream-1");
  assert.equal(stream.usage?.input_tokens, 100);
});

test("openclaw host bridge stream snapshot falls back to response.usage", () => {
  const bridge = createOpenClawHostBridge({
    extractInputText: () => "",
    extractProviderResponseText: (raw: string) => raw.includes("hello") ? "hello" : "",
    contentToText: (value: unknown) => String(value ?? ""),
  });

  const stream = bridge.snapshotStream([
    'data: {"type":"response.completed","response":{"prompt_cache_key":"pk-stream-2","usage":{"input_tokens":90,"output_tokens":8,"input_tokens_details":{"cached_tokens":64}}}}',
    "data: hello",
    "",
  ].join("\n"));

  assert.equal(stream.promptCacheKey, "pk-stream-2");
  assert.deepEqual(stream.usage, {
    input_tokens: 90,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 64 },
  });
});
