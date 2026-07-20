import assert from "node:assert/strict";
import test from "node:test";

import { createApiTaskStateEstimator } from "../src/task-state-estimator.js";

const estimatorInput: any = {
  registry: {
    version: 1,
    tasks: {},
    activeTaskIds: [],
    completedTaskIds: [],
    evictableTaskIds: [],
    taskToBlockIds: {},
    blockToTaskIds: {},
    turnToTaskIds: {},
  },
  delta: {
    inputMode: "sliding_window",
    coveredTurnAbsIds: [],
    messages: [],
    toolCalls: [],
    toolResults: [],
    filesRead: [],
    filesWritten: [],
  },
};

test("task-state estimator preserves Responses API usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        output_text: JSON.stringify({ baseVersion: 1, taskUpdates: [] }),
        usage: {
          input_tokens: 120,
          output_tokens: 24,
          total_tokens: 144,
          cost_usd: 0.002,
        },
      };
    },
  } as Response);
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate(estimatorInput);
    assert.deepEqual(output.usage, {
      inputTokens: 120,
      outputTokens: 24,
      totalTokens: 144,
      costUsd: 0.002,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("task-state estimator preserves Chat Completions usage after Responses fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 404,
        async text() {
          return "not found";
        },
      } as Response;
    }
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify({ baseVersion: 1, taskUpdates: [] }) } }],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 20,
            total_tokens: 100,
          },
        };
      },
    } as Response;
  };
  try {
    const estimator = createApiTaskStateEstimator({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-model",
    });
    const output = await estimator.estimate(estimatorInput);
    assert.equal(calls, 2);
    assert.deepEqual(output.usage, {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
