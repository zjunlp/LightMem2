import test from "node:test";
import assert from "node:assert/strict";

import { runHistoryEvictionIfEnabled } from "./history-eviction-runner.js";

const state = {
  version: 1 as const,
  sessionId: "session-1",
  messages: [
    { role: "user", content: "A".repeat(100) },
    { role: "assistant", content: "B".repeat(100) },
  ],
  seenMessageIds: ["m1", "m2"],
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const helpers = {
  contentToText: (value: unknown) => String(value ?? ""),
};

const estimateMessagesChars = (messages: any[], contentToText: (value: unknown) => string) =>
  messages.reduce((sum, message) => sum + contentToText(message.content).length, 0);

test("history eviction runner is side-effect free when disabled", async () => {
  let rewriteCalls = 0;
  const result = await runHistoryEvictionIfEnabled({
    cfg: {
      moduleEnablement: { stabilizer: false, reduction: false, eviction: false },
      modules: { eviction: false },
      eviction: { enabled: true },
    },
    sessionId: state.sessionId,
    state,
    helpers,
    logger: {},
    rewriteCanonicalState: async () => {
      rewriteCalls += 1;
      throw new Error("disabled eviction must not rewrite canonical state");
    },
    estimateMessagesChars,
  });

  assert.equal(rewriteCalls, 0);
  assert.equal(result.state, state);
  assert.deepEqual(result, {
    state,
    enabled: false,
    changed: false,
    appliedTaskIds: [],
    savedChars: 0,
    diagnostics: {
      beforeMessageCount: 2,
      afterMessageCount: 2,
      beforeChars: 200,
      afterChars: 200,
      skippedReason: "module_disabled",
    },
  });
});

test("history eviction runner reports applied task ids and savings", async () => {
  const result = await runHistoryEvictionIfEnabled({
    cfg: {
      stateDir: "/tmp/state",
      moduleEnablement: { stabilizer: false, reduction: false, eviction: true },
      modules: { eviction: true },
      eviction: {
        enabled: true,
        policy: "model_scored",
        minBlockChars: 256,
        replacementMode: "pointer_stub",
      },
    },
    sessionId: state.sessionId,
    state,
    helpers,
    logger: {},
    rewriteCanonicalState: async (args) => {
      assert.equal(args.evictionEnabled, true);
      return {
        state: {
          ...state,
          messages: [{ role: "assistant", content: "pointer" }],
        },
        changed: true,
        appliedEvictionTaskIds: ["task-1"],
      };
    },
    estimateMessagesChars,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.appliedTaskIds, ["task-1"]);
  assert.equal(result.savedChars, 193);
  assert.deepEqual(result.diagnostics, {
    beforeMessageCount: 2,
    afterMessageCount: 1,
    beforeChars: 200,
    afterChars: 7,
  });
});
