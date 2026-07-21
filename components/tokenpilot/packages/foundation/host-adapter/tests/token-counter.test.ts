import assert from "node:assert/strict";
import test from "node:test";

import { countTextWithPreciseTokens } from "../src/index.js";

test("countTextWithPreciseTokens uses precise OpenAI token counting for supported models", () => {
  const result = countTextWithPreciseTokens("gpt-5.4-mini", "hello world");

  assert.equal(result.mode, "openai_tokens");
  assert.ok(result.count > 0);
});

test("countTextWithPreciseTokens falls back to chars for unsupported models", () => {
  const result = countTextWithPreciseTokens("claude-sonnet-4-6", "hello world");

  assert.deepEqual(result, {
    mode: "chars",
    count: "hello world".length,
  });
});
