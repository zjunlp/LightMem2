import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendCodexRecentTurnBinding,
  indexCodexHostSessionAlias,
  indexCodexPromptCacheKeySession,
  loadCodexRecentTurnBindings,
  loadCodexSessionSnapshot,
  mergeCodexSessionSnapshot,
  resolveCodexSessionAlias,
  resolveCodexSessionIdByPromptCacheKey,
  resolveLatestCodexSessionId,
  upsertCodexSessionSnapshot,
} from "../src/session-state.js";

test("session-state persists snapshots and recent turn bindings per session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-session-state-"));
  try {
    await upsertCodexSessionSnapshot(stateDir, "session-a", {
      workspaceHint: "/tmp/workspace-a",
      latestModel: "gpt-5.4-mini",
      lastHookEvent: "PostToolUse",
      lastToolName: "read",
      lastToolInputChars: 32,
      lastToolOutputChars: 640,
    });

    await appendCodexRecentTurnBinding(stateDir, {
      sessionId: "session-a",
      responseId: "resp-2",
      previousResponseId: "resp-1",
      model: "gpt-5.4-mini",
      requestChars: 1200,
      responseChars: 640,
      assistantChars: 240,
      toolCallCount: 2,
      stream: false,
      updatedAt: "2026-06-26T10:00:00.000Z",
    });
    await appendCodexRecentTurnBinding(stateDir, {
      sessionId: "session-a",
      responseId: "resp-3",
      previousResponseId: "resp-2",
      model: "gpt-5.4-mini",
      requestChars: 1400,
      responseChars: 820,
      assistantChars: 310,
      toolCallCount: 1,
      stream: true,
      updatedAt: "2026-06-26T10:01:00.000Z",
    });

    const snapshot = await loadCodexSessionSnapshot(stateDir, "session-a");
    const bindings = await loadCodexRecentTurnBindings(stateDir, "session-a", 8);
    const latestSessionId = await resolveLatestCodexSessionId(stateDir);

    assert.equal(snapshot?.workspaceHint, "/tmp/workspace-a");
    assert.equal(snapshot?.lastToolName, "read");
    assert.equal(bindings.length, 2);
    assert.equal(bindings[0]?.responseId, "resp-3");
    assert.equal(bindings[1]?.responseId, "resp-2");
    assert.equal(latestSessionId, "session-a");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("session-state resolves prompt_cache_key session mappings", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-prompt-cache-session-"));
  try {
    await indexCodexPromptCacheKeySession(stateDir, "pk-session-a", "codex-synth-a");
    const resolved = await resolveCodexSessionIdByPromptCacheKey(stateDir, "pk-session-a");
    const missing = await resolveCodexSessionIdByPromptCacheKey(stateDir, "pk-session-b");

    assert.equal(resolved, "codex-synth-a");
    assert.equal(missing, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("session-state resolves host codex session aliases", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-session-alias-"));
  try {
    await indexCodexHostSessionAlias(stateDir, "019f-real-codex-session", "codex-synth-a");
    const resolved = await resolveCodexSessionAlias(stateDir, "019f-real-codex-session");
    const missing = await resolveCodexSessionAlias(stateDir, "019f-missing-session");

    assert.equal(resolved, "codex-synth-a");
    assert.equal(missing, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("session-state can merge hook snapshot metadata into the synthesized proxy session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-session-merge-"));
  try {
    await upsertCodexSessionSnapshot(stateDir, "019f-hook-session", {
      workspaceHint: "/tmp/hook-workspace",
      latestModel: "gpt-5.4-mini",
      lastHookEvent: "PostToolUse",
      lastToolName: "read",
      lastToolInputChars: 64,
      lastToolOutputChars: 512,
    }, {
      markLatest: false,
    });
    await upsertCodexSessionSnapshot(stateDir, "codex-synth-1", {
      latestResponseId: "resp-1",
      latestModel: "gpt-5.4-mini",
    });

    const merged = await mergeCodexSessionSnapshot(stateDir, "019f-hook-session", "codex-synth-1");

    assert.equal(merged?.workspaceHint, "/tmp/hook-workspace");
    assert.equal(merged?.lastHookEvent, "PostToolUse");
    assert.equal(merged?.lastToolName, "read");
    assert.equal(merged?.latestResponseId, "resp-1");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
