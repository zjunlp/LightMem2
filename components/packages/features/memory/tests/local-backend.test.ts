import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLocalProceduralMemoryBackend,
  formatProceduralMemoryInjection,
  loadQueueEntries,
  loadSkills,
  makeFallbackSkill,
} from "../src/index.js";

function queueInput(archivePath: string) {
  return {
    sessionId: "session-1",
    taskId: "task-1",
    archivePath,
    archiveSourceLabel: "test archive",
    archiveDigest: "digest-1",
    objective: "Fix the memory queue",
    completionEvidence: ["Tests pass"],
    unresolvedQuestions: [],
    turnAbsIds: ["turn-1"],
  };
}

test("local backend deduplicates queue entries and persists completed skills", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-memory-"));
  try {
    const backend = createLocalProceduralMemoryBackend(stateDir);
    const input = queueInput(join(stateDir, "archive.json"));

    assert.equal(await backend.enqueue([input, input]), 1);
    assert.equal(await backend.enqueue([input]), 0);

    const queued = await loadQueueEntries(stateDir);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.status, "queued");

    const drained = await backend.drainBatch(1);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.status, "inflight");
    assert.equal(drained[0]?.attemptCount, 1);

    const skill = makeFallbackSkill("session-1", drained[0]!, {
      title: "Memory queue repair",
      guidance: "Deduplicate entries before persisting them.",
      whenToUse: ["Repair a persistent work queue"],
      steps: ["Load current entries", "Skip existing queue IDs"],
      facts: ["Queue IDs are deterministic"],
      pitfalls: ["Do not enqueue the same archive twice"],
      constraints: ["Preserve completed entries"],
    });
    await backend.completeBatch(drained, [skill]);

    const completedQueue = await loadQueueEntries(stateDir);
    assert.equal(completedQueue[0]?.status, "distilled");
    assert.equal(completedQueue[0]?.lastError, undefined);

    const skills = await loadSkills(stateDir, "session-1");
    assert.deepEqual(skills, [skill]);

    const hits = await backend.retrieve({
      sessionId: "session-1",
      objective: "Repair a queue",
      topK: 1,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.skill.skillId, skill.skillId);
    const injection = formatProceduralMemoryInjection(hits);
    assert.match(injection, /^\[Procedural Memory\]/);
    assert.match(injection, /Skill: Memory queue repair/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("local backend records a failed batch", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-memory-"));
  try {
    const backend = createLocalProceduralMemoryBackend(stateDir);
    await backend.enqueue([queueInput(join(stateDir, "archive.json"))]);
    const drained = await backend.drainBatch(1);

    await backend.failBatch(drained, "distiller unavailable");

    const entries = await loadQueueEntries(stateDir);
    assert.equal(entries[0]?.status, "failed");
    assert.equal(entries[0]?.lastError, "distiller unavailable");
    assert.equal(entries[0]?.attemptCount, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
