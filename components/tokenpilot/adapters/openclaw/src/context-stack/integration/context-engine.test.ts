import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPluginContextEngine } from "./context-engine.js";

function createDeps(transcriptEntries: any[]) {
  const traceStages: string[] = [];
  return {
    traceStages,
    deps: {
      appendTaskStateTrace: async (_stateDir: string, record: any) => {
        traceStages.push(String(record.stage ?? ""));
      },
      appendEvictionVisualSnapshot: async () => undefined,
      readTranscriptEntriesForSession: async () => transcriptEntries,
      transcriptMessageStableId: (entry: any) => String(entry.id),
      asRecord: (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined,
      canonicalMessageTaskIds: () => [],
      contentToText: (value: unknown) => String(value ?? ""),
      dedupeStrings: (values: string[]) => [...new Set(values)],
      ensureContextSafeDetails: (_details: unknown, patch: Record<string, unknown>) => patch,
      extractPathLike: () => undefined,
      extractToolMessageText: (message: Record<string, unknown>) => String(message.content ?? ""),
      isToolResultLikeMessage: () => false,
      messageToolCallId: () => undefined,
      safeId: (value: string) => value,
    },
  };
}

test("context engine skips eviction rewrite and traces when eviction is disabled", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-context-engine-disabled-"));
  try {
    const { deps, traceStages } = createDeps([
      { id: "m1", message: { role: "user", content: "hello" } },
    ]);
    const engine = createPluginContextEngine({
      stateDir,
      modules: { eviction: false },
      eviction: { enabled: true },
      memory: { enabled: false, autoDistill: false },
      taskStateEstimator: { evidenceMode: "three_state" },
    }, {}, deps);

    const assembled = await engine.assemble({ sessionId: "session-disabled", messages: [] });

    assert.deepEqual(assembled.messages, [{ role: "user", content: "hello" }]);
    assert.equal(traceStages.includes("canonical_state_rewrite"), false);
    assert.equal(traceStages.includes("history_eviction_completed"), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("context engine records enabled history eviction independently", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-context-engine-enabled-"));
  try {
    const { deps, traceStages } = createDeps([
      { id: "m1", message: { role: "user", content: "hello" } },
    ]);
    const engine = createPluginContextEngine({
      stateDir,
      modules: { eviction: true },
      eviction: {
        enabled: true,
        policy: "noop",
        minBlockChars: 256,
        replacementMode: "pointer_stub",
      },
      memory: { enabled: false, autoDistill: false },
      taskStateEstimator: { evidenceMode: "three_state" },
    }, { info: () => undefined }, deps);

    await engine.afterTurn({ sessionId: "session-enabled", messages: [] });

    assert.equal(traceStages.includes("canonical_state_rewrite"), true);
    assert.equal(traceStages.includes("history_eviction_completed"), true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
