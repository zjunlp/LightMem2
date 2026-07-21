import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendRecentTurnBinding,
  loadRecentTurnBindings,
  loadSessionSnapshot,
  resolveLatestSessionId,
  sessionSnapshotPath,
  writeJsonFileAtomic,
  writeSessionSnapshot,
} from "../src/index.js";

test("shared session store persists snapshots and latest bindings", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-host-session-store-"));
  try {
    await writeSessionSnapshot(stateDir, "shared-session-a", {
      sessionId: "shared-session-a",
      latestModel: "test-model",
      updatedAt: "2026-06-28T12:00:00.000Z",
    });
    await appendRecentTurnBinding(stateDir, {
      sessionId: "shared-session-a",
      responseId: "resp-1",
      updatedAt: "2026-06-28T12:01:00.000Z",
    });
    await appendRecentTurnBinding(stateDir, {
      sessionId: "shared-session-a",
      responseId: "resp-2",
      updatedAt: "2026-06-28T12:02:00.000Z",
    });

    const snapshot = await loadSessionSnapshot<{ sessionId: string; latestModel: string }>(stateDir, "shared-session-a");
    const bindings = await loadRecentTurnBindings<{ sessionId: string; responseId: string }>(
      stateDir,
      "shared-session-a",
      8,
      (entry): entry is { sessionId: string; responseId: string } =>
        Boolean(
          entry
            && typeof entry === "object"
            && typeof (entry as { sessionId?: unknown }).sessionId === "string"
            && typeof (entry as { responseId?: unknown }).responseId === "string",
        ),
    );
    const latestSessionId = await resolveLatestSessionId(stateDir);

    assert.equal(snapshot?.sessionId, "shared-session-a");
    assert.equal(snapshot?.latestModel, "test-model");
    assert.equal(bindings.length, 2);
    assert.equal(bindings[0]?.responseId, "resp-2");
    assert.equal(bindings[1]?.responseId, "resp-1");
    assert.equal(latestSessionId, "shared-session-a");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("shared atomic writer overwrites files cleanly", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-host-atomic-store-"));
  try {
    const target = sessionSnapshotPath(stateDir, "shared-session-b");
    await writeJsonFileAtomic(target, { value: 1 });
    await writeJsonFileAtomic(target, { value: 2 });

    const snapshot = await loadSessionSnapshot<{ value: number }>(stateDir, "shared-session-b");
    assert.equal(snapshot?.value, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
