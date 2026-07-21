import assert from "node:assert/strict";
import test from "node:test";
import { runProceduralMemoryBatch } from "../src/index.js";
import type {
  ProceduralMemoryBackend,
  ProceduralMemoryQueueEntry,
  ProceduralSkill,
  SkillDistiller,
} from "../src/index.js";

const entry: ProceduralMemoryQueueEntry = {
  queueId: "queue-1",
  sessionId: "session-1",
  taskId: "task-1",
  archivePath: "/tmp/archive.json",
  archiveSourceLabel: "test",
  objective: "Test worker transitions",
  completionEvidence: [],
  unresolvedQuestions: [],
  turnAbsIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  status: "inflight",
  attemptCount: 1,
};

const skill: ProceduralSkill = {
  skillId: "skill-1",
  sourceTaskId: "task-1",
  sessionId: "session-1",
  title: "Worker transitions",
  objective: entry.objective,
  guidance: "Complete successful batches and fail unsuccessful batches.",
  whenToUse: [],
  steps: [],
  facts: [],
  pitfalls: [],
  constraints: [],
  evidence: [],
  embeddingText: "worker transitions",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function createBackend(entries: ProceduralMemoryQueueEntry[]) {
  const completed: Array<{ entries: ProceduralMemoryQueueEntry[]; skills: ProceduralSkill[] }> = [];
  const failed: Array<{ entries: ProceduralMemoryQueueEntry[]; reason: string }> = [];
  const backend: ProceduralMemoryBackend = {
    async enqueue() {
      return 0;
    },
    async drainBatch() {
      return entries;
    },
    async completeBatch(batchEntries, produced) {
      completed.push({ entries: batchEntries, skills: produced });
    },
    async failBatch(batchEntries, reason) {
      failed.push({ entries: batchEntries, reason });
    },
    async retrieve() {
      return [];
    },
  };
  return { backend, completed, failed };
}

test("worker completes a successfully distilled batch", async () => {
  const fixture = createBackend([entry]);
  const distiller: SkillDistiller = {
    async distill() {
      return [skill];
    },
  };

  const result = await runProceduralMemoryBatch({
    backend: fixture.backend,
    batchSize: 2,
    distiller,
  });

  assert.deepEqual(result, { drained: 1, produced: 1, failed: 0 });
  assert.deepEqual(fixture.completed, [{ entries: [entry], skills: [skill] }]);
  assert.deepEqual(fixture.failed, []);
});

test("worker marks the entire batch failed when distillation throws", async () => {
  const fixture = createBackend([entry]);
  const distiller: SkillDistiller = {
    async distill() {
      throw new Error("provider failed");
    },
  };

  const result = await runProceduralMemoryBatch({
    backend: fixture.backend,
    batchSize: 1,
    distiller,
  });

  assert.deepEqual(result, { drained: 1, produced: 0, failed: 1 });
  assert.deepEqual(fixture.completed, []);
  assert.deepEqual(fixture.failed, [{ entries: [entry], reason: "provider failed" }]);
});

test("worker skips the distiller when the queue is empty", async () => {
  const fixture = createBackend([]);
  let called = false;
  const distiller: SkillDistiller = {
    async distill() {
      called = true;
      return [];
    },
  };

  const result = await runProceduralMemoryBatch({
    backend: fixture.backend,
    batchSize: 0,
    distiller,
  });

  assert.deepEqual(result, { drained: 0, produced: 0, failed: 0 });
  assert.equal(called, false);
});
