import assert from "node:assert/strict";
import test from "node:test";

import { snapshotCodexResponsesStream } from "../src/stream-observer.js";

test("snapshotCodexResponsesStream extracts ids, usage, and assistant text from SSE payloads", () => {
  const raw = [
    "event: response.created",
    "data: {\"response\":{\"id\":\"resp-1\",\"previous_response_id\":\"resp-0\",\"prompt_cache_key\":\"pk-1\"}}",
    "",
    "event: response.output_text.delta",
    "data: {\"delta\":{\"output_text\":\"Hello \"}}",
    "",
    "event: response.output_text.delta",
    "data: {\"delta\":{\"content\":[{\"text\":\"world\"}]}}",
    "",
    "event: response.completed",
    "data: {\"usage\":{\"input_tokens\":100,\"output_tokens\":20}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const snapshot = snapshotCodexResponsesStream(raw);
  assert.equal(snapshot.responseId, "resp-1");
  assert.equal(snapshot.previousResponseId, "resp-0");
  assert.equal(snapshot.responsePromptCacheKey, "pk-1");
  assert.equal(snapshot.assistantText, "Hello world");
  assert.deepEqual(snapshot.usage, { input_tokens: 100, output_tokens: 20 });
});

test("snapshotCodexResponsesStream reads top-level prompt cache key and response usage fallback", () => {
  const raw = [
    "event: response.created",
    "data: {\"id\":\"resp-2\",\"prompt_cache_key\":\"pk-2\"}",
    "",
    "event: response.completed",
    "data: {\"response\":{\"usage\":{\"input_tokens\":90,\"output_tokens\":8,\"input_tokens_details\":{\"cached_tokens\":64}}}}",
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  const snapshot = snapshotCodexResponsesStream(raw);
  assert.equal(snapshot.responseId, "resp-2");
  assert.equal(snapshot.responsePromptCacheKey, "pk-2");
  assert.deepEqual(snapshot.usage, {
    input_tokens: 90,
    output_tokens: 8,
    input_tokens_details: {
      cached_tokens: 64,
    },
  });
});
