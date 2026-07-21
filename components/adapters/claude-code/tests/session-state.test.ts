import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendClaudeCodeRecentTurnBinding,
  loadClaudeCodeRecentTurnBindings,
  loadClaudeCodeSessionSnapshot,
  resolveLatestClaudeCodeSessionId,
  upsertClaudeCodeSessionSnapshot,
} from "../src/session-state.js";

test("claude-code session-state persists snapshots and recent turn bindings per session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-claude-session-state-"));
  try {
    await upsertClaudeCodeSessionSnapshot(stateDir, "claude-session-a", {
      workspaceHint: "/tmp/workspace-a",
      latestModel: "claude-sonnet-4-6",
      lastHookEvent: "PostToolUse",
      lastToolName: "read",
      lastToolInputChars: 48,
      lastToolOutputChars: 720,
      requestChars: 1200,
      responseChars: 820,
      assistantChars: 310,
      reductionSavedChars: 180,
    });

    await appendClaudeCodeRecentTurnBinding(stateDir, {
      sessionId: "claude-session-a",
      responseId: "msg-2",
      previousResponseId: "msg-1",
      model: "claude-sonnet-4-6",
      requestChars: 1200,
      responseChars: 640,
      assistantChars: 240,
      reductionSavedChars: 160,
      stablePrefixApplied: true,
      reductionApplied: true,
      stream: false,
      updatedAt: "2026-06-28T10:00:00.000Z",
    });
    await appendClaudeCodeRecentTurnBinding(stateDir, {
      sessionId: "claude-session-a",
      responseId: "msg-3",
      previousResponseId: "msg-2",
      model: "claude-sonnet-4-6",
      requestChars: 1400,
      responseChars: 900,
      assistantChars: 320,
      reductionSavedChars: 220,
      stablePrefixApplied: true,
      reductionApplied: true,
      stream: true,
      updatedAt: "2026-06-28T10:01:00.000Z",
    });

    const snapshot = await loadClaudeCodeSessionSnapshot(stateDir, "claude-session-a");
    const bindings = await loadClaudeCodeRecentTurnBindings(stateDir, "claude-session-a", 8);
    const latestSessionId = await resolveLatestClaudeCodeSessionId(stateDir);

    assert.equal(snapshot?.workspaceHint, "/tmp/workspace-a");
    assert.equal(snapshot?.lastToolName, "read");
    assert.equal(snapshot?.reductionSavedChars, 180);
    assert.equal(bindings.length, 2);
    assert.equal(bindings[0]?.responseId, "msg-3");
    assert.equal(bindings[1]?.responseId, "msg-2");
    assert.equal(bindings[0]?.stream, true);
    assert.equal(latestSessionId, "claude-session-a");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
