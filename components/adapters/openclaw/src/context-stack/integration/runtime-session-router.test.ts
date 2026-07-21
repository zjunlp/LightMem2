import test from "node:test";
import assert from "node:assert/strict";

import { createRuntimeSessionRouter } from "./runtime-session-router.js";

function createRouter() {
  return createRuntimeSessionRouter({
    cfg: {},
    deps: {
      normalizeTurnBindingMessage(value: string) {
        return value.trim().toLowerCase();
      },
      findLastUserItem(input: any) {
        if (!Array.isArray(input)) return null;
        for (let i = input.length - 1; i >= 0; i -= 1) {
          const item = input[i];
          if (item?.role === "user") return { userIndex: i, userItem: item };
        }
        return null;
      },
      extractItemText(item: any) {
        return String(item?.content ?? "").trim();
      },
      extractSessionKey(event: any) {
        return String(event?.sessionKey ?? "").trim();
      },
      extractOpenClawSessionId(event: any) {
        return String(event?.sessionId ?? "").trim();
      },
      extractWorkspaceDirFromMessages() {
        return undefined;
      },
      contentToText(value: unknown) {
        return String(value ?? "");
      },
      rememberWorkspaceHint() {
        // no-op for test
      },
    },
  });
}

test("runtime session router does not reuse latest upstream session for a fresh unbound payload", () => {
  const router = createRouter();

  router.bindSessionStart({
    sessionKey: "existing-session-key",
    sessionId: "upstream-existing-session",
  });
  router.rememberUserMessageBinding(
    { sessionKey: "existing-session-key" },
    "existing bound message",
    "upstream-existing-session",
  );

  const resolved = router.resolveSessionIdForPayload({
    input: [
      {
        role: "user",
        content: "brand new conversation opening turn",
      },
    ],
  });

  assert.equal(
    resolved,
    undefined,
    "fresh first-turn payload should stay unbound instead of inheriting the latest upstream session",
  );
});

test("runtime session router resolves bound upstream session for matched user payload", () => {
  const router = createRouter();

  router.bindSessionStart({
    sessionKey: "existing-session-key",
    sessionId: "upstream-existing-session",
  });
  router.rememberUserMessageBinding(
    { sessionKey: "existing-session-key" },
    "existing bound message",
    "upstream-existing-session",
  );

  const resolved = router.resolveSessionIdForPayload({
    input: [
      {
        role: "user",
        content: "existing bound message",
      },
    ],
  });

  assert.equal(resolved, "upstream-existing-session");
});
