import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { distillQueueEntriesWithLlm } from "../src/index.js";
import type { ProceduralMemoryQueueEntry } from "../src/index.js";

async function readRequestBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function responseText(): string {
  return JSON.stringify({
    skills: [
      {
        sourceTaskId: "task-1",
        objective: "Distill a completed task",
        workflow: ["Read the archived trajectory", "Retain reusable evidence"],
        facts: ["The task completed successfully"],
        tool_patterns: ["Read archives before distillation"],
        pitfalls: ["Do not invent missing evidence"],
      },
    ],
  });
}

async function withProviderServer(
  handler: Parameters<typeof createServer>[0],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function withQueueEntry(run: (entry: ProceduralMemoryQueueEntry) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "tokenpilot-distill-"));
  const archivePath = join(stateDir, "archive.json");
  await writeFile(archivePath, JSON.stringify({ messages: ["completed trajectory"] }), "utf8");
  const entry: ProceduralMemoryQueueEntry = {
    queueId: "queue-1",
    sessionId: "session-1",
    taskId: "task-1",
    archivePath,
    archiveSourceLabel: "test archive",
    objective: "Distill a completed task",
    completionEvidence: ["Task completed"],
    unresolvedQuestions: [],
    turnAbsIds: ["turn-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "inflight",
    attemptCount: 1,
  };
  try {
    await run(entry);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("LLM distiller uses the Responses API and maps its structured result", async () => {
  await withQueueEntry(async (entry) => {
    let requestedPath = "";
    await withProviderServer(async (request, response) => {
      requestedPath = request.url ?? "";
      const body = JSON.parse(await readRequestBody(request));
      assert.equal(body.model, "test-model");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ output: [{ content: [{ text: responseText() }] }] }));
    }, async (baseUrl) => {
      const skills = await distillQueueEntriesWithLlm({
        provider: { baseUrl, apiKey: "test-key", model: "test-model" },
        entries: [entry],
      });

      assert.equal(requestedPath, "/responses");
      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.sourceTaskId, "task-1");
      assert.deepEqual(skills[0]?.facts, ["The task completed successfully"]);
      assert.deepEqual(skills[0]?.steps, ["Read the archived trajectory", "Retain reusable evidence"]);
    });
  });
});

test("LLM distiller falls back to Chat Completions for unsupported Responses conversion", async () => {
  await withQueueEntry(async (entry) => {
    const requestedPaths: string[] = [];
    await withProviderServer(async (request, response) => {
      requestedPaths.push(request.url ?? "");
      await readRequestBody(request);
      if (request.url === "/responses") {
        response.statusCode = 400;
        response.end("convert_request_failed: not implemented");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: responseText() } }] }));
    }, async (baseUrl) => {
      const skills = await distillQueueEntriesWithLlm({
        provider: { baseUrl, apiKey: "test-key", model: "test-model" },
        entries: [entry],
      });

      assert.deepEqual(requestedPaths, ["/responses", "/chat/completions"]);
      assert.equal(skills[0]?.title, "Skill for task-1");
    });
  });
});
