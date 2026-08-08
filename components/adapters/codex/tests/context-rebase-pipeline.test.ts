import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reserveUnusedPort } from "@lightmem2/host-adapter";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import {
  buildCodexEffectiveHistory,
  codexContextHistoryJournalPath,
  loadCodexContextHistoryJournal,
  parseCodexRollout,
} from "../src/context-history/index.js";
import { createConsoleLogger } from "../src/logger.js";
import { startCodexResponsesProxy } from "../src/proxy-runtime.js";
import {
  acquireCodexRebaseSessionLock,
  appendPendingCodexRebaseEpoch,
  readCodexRebaseCapabilityJournal,
  readLatestCodexRebaseEpoch,
} from "../src/context-rewrite/index.js";
import {
  loadCodexSessionSnapshot,
  resolveCodexSessionAlias,
  resolveCodexSessionIdByResponseId,
  upsertCodexSessionSnapshot,
} from "../src/session-state.js";

type JsonObject = Record<string, unknown>;

const FETCH_FORBIDDEN_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77,
  79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123,
  135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6697, 10080,
]);

async function reserveFetchPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await reserveUnusedPort();
    if (!FETCH_FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("Unable to reserve a fetch-safe test port");
}

async function startSequencedResponsesUpstream(params?: {
  rejectChain?: boolean;
  rejectRebase?: boolean;
  responseStatus?: string;
}): Promise<{
  baseUrl: string;
  requests: JsonObject[];
  close(): Promise<void>;
}> {
  const port = await reserveFetchPort();
  const requests: JsonObject[] = [];
  const server = createHttpServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      req.on("error", reject);
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const payload = JSON.parse(body) as JsonObject;
    requests.push(payload);
    if (params?.rejectChain && "previous_response_id" in payload) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: { code: "invalid_request_error", message: "previous_response_id is not supported" },
      }));
      return;
    }
    const isRebase = !("previous_response_id" in payload) && requests.length > 1;
    if (params?.rejectRebase && isRebase) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "invalid_request_error", message: "schema rejected replay" } }));
      return;
    }
    const id = `resp-pipeline-${requests.length}`;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id,
      object: "response",
      status: params?.responseStatus,
      previous_response_id: typeof payload.previous_response_id === "string"
        ? payload.previous_response_id
        : params?.rejectChain
          ? "provider-internal-unrelated-chain"
          : undefined,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `ok ${id}` }],
        },
      ],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function streamResponseText(id: string, previousResponseId: string | undefined): string {
  return [
    "event: response.created",
    `data: ${JSON.stringify({
      type: "response.created",
      response: {
        id,
        previous_response_id: previousResponseId,
      },
    })}`,
    "",
    "event: response.output_item.done",
    `data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: `msg-${id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `ok ${id}` }],
      },
    })}`,
    "",
    "event: response.completed",
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id,
        previous_response_id: previousResponseId,
      },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

async function startSequencedStreamResponsesUpstream(params?: {
  rejectRebase?: boolean;
  incomplete?: boolean;
}): Promise<{
  baseUrl: string;
  requests: JsonObject[];
  close(): Promise<void>;
}> {
  const port = await reserveFetchPort();
  const requests: JsonObject[] = [];
  const server = createHttpServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      req.on("error", reject);
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    const payload = JSON.parse(body) as JsonObject;
    requests.push(payload);
    const isRebase = !("previous_response_id" in payload) && requests.length > 1;
    if (params?.rejectRebase && isRebase) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { code: "invalid_request_error", message: "stream replay rejected" } }));
      return;
    }
    const id = `resp-stream-pipeline-${requests.length}`;
    const previousResponseId = typeof payload.previous_response_id === "string"
      ? payload.previous_response_id
      : undefined;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.end(params?.incomplete
      ? [
        "event: response.created",
        `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id,
            previous_response_id: previousResponseId,
          },
        })}`,
        "",
        "event: response.output_text.delta",
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: 0,
          delta: `partial ${id}`,
        })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n")
      : streamResponseText(id, previousResponseId));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function inputText(payload: JsonObject | undefined): string {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  return JSON.stringify(input);
}

test("CDR-03 proxy startup recovers a pending epoch before serving its session", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pending-restart-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pending-restart";
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId,
      epochId: "epoch-before-restart",
      planId: "plan-before-restart",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    });
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      contextRewrite: { enabled: false },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "resume after restart" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const recovered = await readLatestCodexRebaseEpoch({ stateDir, sessionId });
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.failureReason, "process_restarted");
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-03 proxy restart recovery defers while another process owns the session lock", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-live-lock-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  let sessionLock: Awaited<ReturnType<typeof acquireCodexRebaseSessionLock>> = undefined;
  try {
    const sessionId = "codex-session-live-lock";
    await appendPendingCodexRebaseEpoch({
      stateDir,
      sessionId,
      epochId: "epoch-live",
      planId: "plan-live",
      oldPreviousResponseId: "resp-old",
      oldRevision: "rev-old",
    });
    sessionLock = await acquireCodexRebaseSessionLock({ stateDir, sessionId });
    assert.ok(sessionLock);
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      contextRewrite: { enabled: false },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });
    const requestBody = JSON.stringify({
      model: "gpt-5.4-mini",
      stream: false,
      metadata: { tokenpilotSessionId: sessionId },
      input: [{ role: "user", content: "resume safely" }],
    });

    const firstResponse = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    assert.equal(firstResponse.status, 200);
    await firstResponse.text();
    assert.equal((await readLatestCodexRebaseEpoch({ stateDir, sessionId }))?.status, "pending");

    await sessionLock.release();
    sessionLock = undefined;
    const secondResponse = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });
    assert.equal(secondResponse.status, 200);
    await secondResponse.text();
    const recovered = await readLatestCodexRebaseEpoch({ stateDir, sessionId });
    assert.equal(recovered?.status, "failed");
    assert.equal(recovered?.failureReason, "process_restarted");
  } finally {
    await sessionLock?.release();
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy pipeline rebases a non-stream request from effective history", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "OLD_SENTINEL_PIPELINE" }],
      }),
    });
    assert.equal(first.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const oldItem = history.replayableItems.find((entry) => JSON.stringify(entry.item).includes("OLD_SENTINEL_PIPELINE"));
    assert.ok(oldItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
    };

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-pipeline-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "CURRENT_SENTINEL_PIPELINE" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 2);
    assert.equal("previous_response_id" in (upstream.requests[1] ?? {}), false);
    assert.doesNotMatch(inputText(upstream.requests[1]), /OLD_SENTINEL_PIPELINE/);
    assert.match(inputText(upstream.requests[1]), /CURRENT_SENTINEL_PIPELINE/);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy automatically replaces an unsupported response chain with stateless replay", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-provider-chain-fallback-"));
  const upstream = await startSequencedResponsesUpstream({ rejectChain: true });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-provider-chain-fallback";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "provider-fixture",
      upstream: {
        name: "provider-fixture",
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      contextRewrite: {
        enabled: false,
        providerCompatibilityProbe: "real_provider",
      },
    } as any);
    runtime = await startCodexResponsesProxy({ config, logger: createConsoleLogger(false) });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-fixture",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "CHAIN_ROOT_SENTINEL" }],
      }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-fixture",
        stream: false,
        previous_response_id: "resp-pipeline-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "CHAIN_CURRENT_SENTINEL" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 3);
    assert.equal(upstream.requests[1]?.previous_response_id, "resp-pipeline-1");
    assert.equal("previous_response_id" in (upstream.requests[2] ?? {}), false);
    assert.match(inputText(upstream.requests[2]), /CHAIN_ROOT_SENTINEL/);
    assert.match(inputText(upstream.requests[2]), /CHAIN_CURRENT_SENTINEL/);
    assert.deepEqual(
      await loadCodexSessionSnapshot(stateDir, sessionId).then((snapshot) => ({
        latestResponseId: snapshot?.latestResponseId,
        previousResponseId: snapshot?.previousResponseId,
      })),
      { latestResponseId: "resp-pipeline-3", previousResponseId: "resp-pipeline-1" },
    );

    const journal = await readCodexRebaseCapabilityJournal(stateDir);
    assert.equal(
      journal.capabilities.find((entry) => entry.itemType === "previous_response_id")?.status,
      "verified_unsupported",
    );
    assert.equal(
      journal.capabilities.find((entry) => entry.itemType === "message")?.status,
      "verified_supported",
    );

    const third = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-fixture",
        stream: false,
        previous_response_id: "resp-pipeline-3",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "CHAIN_THIRD_SENTINEL" }],
      }),
    });
    assert.equal(third.status, 200);
    assert.equal(upstream.requests.length, 4);
    assert.equal("previous_response_id" in (upstream.requests[3] ?? {}), false);
    assert.match(inputText(upstream.requests[3]), /CHAIN_THIRD_SENTINEL/);
    assert.deepEqual(
      await loadCodexSessionSnapshot(stateDir, sessionId).then((snapshot) => ({
        latestResponseId: snapshot?.latestResponseId,
        previousResponseId: snapshot?.previousResponseId,
      })),
      { latestResponseId: "resp-pipeline-4", previousResponseId: "resp-pipeline-3" },
    );
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy bootstraps a rebase from the hook-persisted Codex rollout", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rollout-bootstrap-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const codexSessionId = "019f-rollout-bootstrap-session";
    const rolloutPath = join(stateDir, "rollout.jsonl");
    const rolloutRecords = [
      {
        timestamp: "2026-08-02T00:00:00.000Z",
        type: "session_meta",
        payload: { id: codexSessionId, cwd: "/workspace/example", model_provider: "tokenpilot" },
      },
      {
        timestamp: "2026-08-02T00:00:01.000Z",
        type: "compacted",
        payload: {
          replacement_history: [
            {
              id: "msg-rollout-old",
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "OLD_ROLLOUT_SENTINEL" }],
            },
            {
              id: "cmp-rollout-1",
              type: "compaction",
              encrypted_content: "opaque-compaction-payload",
              internal_chat_message_metadata_passthrough: { source: "codex" },
            },
            {
              id: "msg-rollout-keep",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "KEEP_ROLLOUT_SENTINEL" }],
            },
          ],
        },
      },
    ];
    await writeFile(
      rolloutPath,
      `${rolloutRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    await upsertCodexSessionSnapshot(stateDir, codexSessionId, {
      codexSessionId,
      transcriptPath: rolloutPath,
      latestModel: "gpt-5.4-mini",
      latestUpstreamProvider: "OpenAI",
    }, { markLatest: false });

    const parsedRollout = await parseCodexRollout(rolloutPath);
    assert.ok(parsedRollout);
    assert.equal(parsedRollout.history.incomplete, false);
    const oldItem = parsedRollout.history.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes("OLD_ROLLOUT_SENTINEL"),
    );
    assert.ok(oldItem);

    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: { stabilizer: false, reduction: false },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        mutationPlan: {
          operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
        },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-before-proxy-journal",
        prompt_cache_key: codexSessionId,
        input: [{ role: "user", content: "CURRENT_ROLLOUT_SENTINEL" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    assert.equal(upstream.requests.length, 1);
    const rebasedPayload = upstream.requests[0];
    assert.equal("previous_response_id" in (rebasedPayload ?? {}), false);
    assert.doesNotMatch(inputText(rebasedPayload), /OLD_ROLLOUT_SENTINEL/);
    assert.match(inputText(rebasedPayload), /KEEP_ROLLOUT_SENTINEL/);
    assert.match(inputText(rebasedPayload), /CURRENT_ROLLOUT_SENTINEL/);
    assert.match(inputText(rebasedPayload), /\"type\":\"compaction\"/);

    const synthesizedSessionId = await resolveCodexSessionAlias(stateDir, codexSessionId);
    assert.ok(synthesizedSessionId);
    assert.equal(
      (await loadCodexSessionSnapshot(stateDir, synthesizedSessionId))?.transcriptPath,
      rolloutPath,
    );
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDH-02 proxy journal respects failed non-stream response bodies", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-body-failed-"));
  const upstream = await startSequencedResponsesUpstream({ responseStatus: "failed" });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-body-failed";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: false,
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "BODY_FAILED_SENTINEL" }],
      }),
    });
    assert.equal(response.status, 200);

    const journal = await loadCodexContextHistoryJournal(stateDir, sessionId);
    assert.equal(journal.filter((entry) => entry.kind === "request").at(-1)?.status, "failed");
    assert.equal(journal.find((entry) => entry.kind === "response")?.status, "failed");
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDH-01 proxy bypasses context-history journaling when the journal cannot be read", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-journal-bypass-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-journal-bypass";
    await mkdir(codexContextHistoryJournalPath(stateDir, sessionId), { recursive: true });
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "JOURNAL_FAILURE_BYPASS_SENTINEL" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 1);
    assert.match(JSON.stringify(upstream.requests[0]), /JOURNAL_FAILURE_BYPASS_SENTINEL/);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-01 proxy pipeline defers stale mutation plans", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-stale-plan-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-stale-plan";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "OLD_SENTINEL_STALE_PLAN" }],
      }),
    });
    assert.equal(first.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const oldItem = history.replayableItems.find((entry) => JSON.stringify(entry.item).includes("OLD_SENTINEL_STALE_PLAN"));
    assert.ok(oldItem);
    (config as any).contextRewrite.mutationPlan = {
      baseRevision: "rev-stale",
      operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
    };

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-pipeline-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "CURRENT_SENTINEL_STALE_PLAN" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1]?.previous_response_id, "resp-pipeline-1");
    assert.match(inputText(upstream.requests[1]), /CURRENT_SENTINEL_STALE_PLAN/);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy pipeline falls back and cools down rejected rebases", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-fallback-"));
  const upstream = await startSequencedResponsesUpstream({ rejectRebase: true });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-fallback";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "OLD_SENTINEL_PIPELINE_FALLBACK" }],
      }),
    });
    assert.equal(first.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const oldItem = history.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes("OLD_SENTINEL_PIPELINE_FALLBACK"),
    );
    assert.ok(oldItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
    };

    const turn = {
      model: "gpt-5.4-mini",
      stream: false,
      previous_response_id: "resp-pipeline-1",
      metadata: { tokenpilotSessionId: sessionId },
      input: [{ role: "user", content: "CURRENT_SENTINEL_PIPELINE_FALLBACK" }],
    };
    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 3);
    assert.equal("previous_response_id" in (upstream.requests[1] ?? {}), false);
    assert.equal(upstream.requests[2]?.previous_response_id, "resp-pipeline-1");

    const third = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    assert.equal(third.status, 200);
    assert.equal(upstream.requests.length, 4);
    assert.equal(upstream.requests[3]?.previous_response_id, "resp-pipeline-1");

    const fourth = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...turn,
        input: [{ role: "user", content: "DIFFERENT_CURRENT_SENTINEL_PIPELINE_FALLBACK" }],
      }),
    });
    assert.equal(fourth.status, 200);
    assert.equal(upstream.requests.length, 5);
    assert.equal(upstream.requests[4]?.previous_response_id, "resp-pipeline-1");
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-04 fallback keeps non-rebase before-call reductions", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-fallback-reduction-"));
  const upstream = await startSequencedResponsesUpstream({ rejectRebase: true });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-fallback-reduction";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: true,
      },
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 400,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
        passOptions: {
          execOutputTruncation: {
            toolThresholds: {
              bash: 400,
            },
          },
        },
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "OLD_SENTINEL_FALLBACK_REDUCTION" }],
      }),
    });
    assert.equal(first.status, 200);

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const oldItem = history.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes("OLD_SENTINEL_FALLBACK_REDUCTION"),
    );
    assert.ok(oldItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
    };

    const longOutput = `RAW_FALLBACK_REDUCTION\n${"line\n".repeat(600)}`;
    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-pipeline-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [
          { role: "user", content: "CURRENT_SENTINEL_FALLBACK_REDUCTION" },
          { type: "function_call", call_id: "call-fallback-reduction", name: "bash", arguments: "{}" },
          { type: "function_call_output", call_id: "call-fallback-reduction", output: longOutput },
        ],
      }),
    });

    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 3);
    assert.equal("previous_response_id" in (upstream.requests[1] ?? {}), false);
    assert.equal(upstream.requests[2]?.previous_response_id, "resp-pipeline-1");
    const fallbackOutput = ((upstream.requests[2]?.input as JsonObject[] | undefined) ?? [])
      .find((item) => item.type === "function_call_output")?.output;
    assert.equal(typeof fallbackOutput, "string");
    assert.ok(String(fallbackOutput).length < longOutput.length);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy pipeline falls back and cools down rejected stream rebases", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-stream-fallback-"));
  const upstream = await startSequencedStreamResponsesUpstream({ rejectRebase: true });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-stream-fallback";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: true,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "OLD_SENTINEL_PIPELINE_STREAM_FALLBACK" }],
      }),
    });
    assert.equal(first.status, 200);
    await first.text();

    const history = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const oldItem = history.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes("OLD_SENTINEL_PIPELINE_STREAM_FALLBACK"),
    );
    assert.ok(oldItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
    };

    const turn = {
      model: "gpt-5.4-mini",
      stream: true,
      previous_response_id: "resp-stream-pipeline-1",
      metadata: { tokenpilotSessionId: sessionId },
      input: [{ role: "user", content: "CURRENT_SENTINEL_PIPELINE_STREAM_FALLBACK" }],
    };
    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    const secondText = await second.text();
    assert.equal(second.status, 200);
    assert.match(secondText, /resp-stream-pipeline-3/);
    assert.equal(upstream.requests.length, 3);
    assert.equal("previous_response_id" in (upstream.requests[1] ?? {}), false);
    assert.equal(upstream.requests[2]?.previous_response_id, "resp-stream-pipeline-1");

    const third = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turn),
    });
    assert.equal(third.status, 200);
    await third.text();
    assert.equal(upstream.requests.length, 4);
    assert.equal(upstream.requests[3]?.previous_response_id, "resp-stream-pipeline-1");
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDH-02 proxy journal and trace keep interrupted 2xx streams incomplete", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-stream-incomplete-"));
  const upstream = await startSequencedStreamResponsesUpstream({ incomplete: true });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-stream-incomplete";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: false,
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: true,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "INTERRUPTED_STREAM_TRACE" }],
      }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const journal = await loadCodexContextHistoryJournal(stateDir, sessionId);
    const requestEntries = journal.filter((entry) => entry.kind === "request");
    assert.equal(requestEntries.at(-1)?.status, "incomplete");
    assert.equal(journal.find((entry) => entry.kind === "response")?.status, "incomplete");

    const traceRows = (await readFile(join(stateDir, "event-trace.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as JsonObject);
    const afterCall = traceRows.findLast((entry) => entry.stage === "proxy_after_call");
    assert.equal(afterCall?.completed, false);
    assert.equal(afterCall?.streamStatus, "incomplete");
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy pipeline journals current input before reduction", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-order-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-order";
    const longOutput = `RAW_ORDER_SENTINEL\n${"line\n".repeat(600)}`;
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: true,
      },
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 400,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
        passOptions: {
          execOutputTruncation: {
            toolThresholds: {
              bash: 400,
            },
          },
        },
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [
          { role: "developer", content: "root prompt" },
          { role: "user", content: "check status" },
          { role: "tool", type: "function_call_output", name: "bash", output: longOutput },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 1);
    const forwardedTool = (upstream.requests[0]?.input as JsonObject[] | undefined)?.find(
      (item) => item.type === "function_call_output",
    );
    assert.ok(forwardedTool);
    assert.ok(String(forwardedTool.output ?? "").length < longOutput.length);

    const journal = await loadCodexContextHistoryJournal(stateDir, sessionId);
    const request = journal.find((entry) => entry.kind === "request");
    assert.equal(request?.kind, "request");
    const journalTool = request.inputItems.find((item) => item.type === "function_call_output");
    assert.equal(journalTool?.output, longOutput);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 committed rebase history starts from the new response chain root", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-root-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-root";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "ROOT_OLD_SENTINEL" }],
      }),
    });
    assert.equal(first.status, 200);

    const beforeRebase = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const oldItem = beforeRebase.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes("ROOT_OLD_SENTINEL"),
    );
    assert.ok(oldItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: oldItem.stableItemId }],
    };

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: "resp-pipeline-1",
        metadata: { tokenpilotSessionId: sessionId },
        input: [{ role: "user", content: "ROOT_CURRENT_SENTINEL" }],
      }),
    });
    assert.equal(second.status, 200);
    assert.equal(upstream.requests.length, 2);
    assert.equal("previous_response_id" in (upstream.requests[1] ?? {}), false);
    assert.doesNotMatch(inputText(upstream.requests[1]), /ROOT_OLD_SENTINEL/);

    const afterRebase = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: "resp-pipeline-2",
    });
    assert.equal(afterRebase.incomplete, false);
    assert.doesNotMatch(JSON.stringify(afterRebase.replayableItems), /ROOT_OLD_SENTINEL/);
    assert.match(JSON.stringify(afterRebase.replayableItems), /ROOT_CURRENT_SENTINEL/);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 mock smoke keeps five turns on the new response chain", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-smoke-"));
  const upstream = await startSequencedResponsesUpstream();
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-smoke";
    const evict = "EVICT_ME_mock_smoke";
    const keep = "KEEP_ME_mock_smoke";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [
          { role: "user", content: evict },
          { role: "user", content: keep },
        ],
      }),
    });
    assert.equal(first.status, 200);
    let previousResponseId = String((await first.json() as JsonObject).id);

    const beforeRebase = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const evictedItem = beforeRebase.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes(evict),
    );
    assert.ok(evictedItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: evictedItem.stableItemId }],
    };

    for (let turn = 2; turn <= 6; turn += 1) {
      const response = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          stream: false,
          previous_response_id: previousResponseId,
          input: [{ role: "user", content: `TURN_${turn}_mock_smoke` }],
        }),
      });
      assert.equal(response.status, 200);
      const responseBody = await response.json() as JsonObject;
      previousResponseId = String(responseBody.id);
      (config as any).contextRewrite.mutationPlan = { operations: [] };
    }

    assert.equal(await resolveCodexSessionIdByResponseId(stateDir, previousResponseId), sessionId);
    assert.equal(upstream.requests.length, 6);
    const rebasedPayload = upstream.requests[1];
    assert.equal("previous_response_id" in (rebasedPayload ?? {}), false);
    assert.doesNotMatch(inputText(rebasedPayload), new RegExp(evict));
    assert.match(inputText(rebasedPayload), new RegExp(keep));
    for (const payload of upstream.requests.slice(1)) {
      assert.doesNotMatch(inputText(payload), new RegExp(evict));
    }
    for (let index = 2; index < upstream.requests.length; index += 1) {
      assert.equal(upstream.requests[index]?.previous_response_id, `resp-pipeline-${index}`);
    }

    const finalHistory = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: previousResponseId,
    });
    assert.equal(finalHistory.incomplete, false);
    assert.doesNotMatch(JSON.stringify(finalHistory.replayableItems), new RegExp(evict));
    assert.match(JSON.stringify(finalHistory.replayableItems), new RegExp(keep));
    assert.match(JSON.stringify(finalHistory.replayableItems), /TURN_6_mock_smoke/);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("CDR-06 proxy restart keeps the committed rebase response chain", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-rebase-pipeline-restart-"));
  const upstream = await startSequencedResponsesUpstream({ rejectChain: true });
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;
  try {
    const sessionId = "codex-session-pipeline-restart";
    const evict = "EVICT_ME_restart_smoke";
    const keep = "KEEP_ME_restart_smoke";
    const config = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const first = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        metadata: { tokenpilotSessionId: sessionId },
        input: [
          { role: "user", content: evict },
          { role: "user", content: keep },
        ],
      }),
    });
    assert.equal(first.status, 200);
    let previousResponseId = String((await first.json() as JsonObject).id);

    const beforeRebase = await buildCodexEffectiveHistory({ stateDir, sessionId });
    const evictedItem = beforeRebase.replayableItems.find(
      (entry) => JSON.stringify(entry.item).includes(evict),
    );
    assert.ok(evictedItem);
    (config as any).contextRewrite.mutationPlan = {
      operations: [{ type: "evict", stableItemId: evictedItem.stableItemId }],
    };

    const second = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: previousResponseId,
        input: [{ role: "user", content: "TURN_2_restart_smoke" }],
      }),
    });
    assert.equal(second.status, 200);
    previousResponseId = String((await second.json() as JsonObject).id);

    assert.equal(upstream.requests.length, 2);
    assert.equal("previous_response_id" in (upstream.requests[1] ?? {}), false);
    assert.doesNotMatch(inputText(upstream.requests[1]), new RegExp(evict));
    assert.match(inputText(upstream.requests[1]), new RegExp(keep));
    (config as any).contextRewrite.mutationPlan = { operations: [] };

    const beforeRestartContinuation = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: previousResponseId,
        input: [{ role: "user", content: "TURN_3_PRE_RESTART" }],
      }),
    });
    assert.equal(beforeRestartContinuation.status, 200);
    previousResponseId = String((await beforeRestartContinuation.json() as JsonObject).id);
    assert.equal(upstream.requests.length, 4);
    assert.equal(upstream.requests[2]?.previous_response_id, "resp-pipeline-2");
    assert.equal("previous_response_id" in (upstream.requests[3] ?? {}), false);

    await runtime.close();
    runtime = undefined;

    const restartedConfig = normalizeTokenPilotCodexConfig({
      stateDir,
      proxyPort: await reserveFetchPort(),
      upstreamProvider: "OpenAI",
      upstream: {
        baseUrl: upstream.baseUrl,
        wireApi: "responses",
        requiresOpenAIAuth: false,
      },
      modules: {
        stabilizer: false,
        reduction: false,
      },
      contextRewrite: {
        enabled: true,
        providerCompatibilityProbe: "mock_fixture",
        mode: "response_chain_rebase",
        failureMode: "bypass",
        retryOriginalRequest: true,
        cooldownMs: 300_000,
        mutationPlan: { operations: [] },
      },
    } as any);
    runtime = await startCodexResponsesProxy({
      config: restartedConfig,
      logger: createConsoleLogger(false),
      allowMockFixtureEvidence: true,
    });

    const third = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        previous_response_id: previousResponseId,
        input: [{ role: "user", content: "TURN_4_restart_smoke" }],
      }),
    });
    assert.equal(third.status, 200);
    const finalResponseId = String((await third.json() as JsonObject).id);

    assert.equal(upstream.requests.length, 5);
    assert.equal("previous_response_id" in (upstream.requests[4] ?? {}), false);
    assert.equal(await resolveCodexSessionIdByResponseId(stateDir, finalResponseId), sessionId);
    const finalHistory = await buildCodexEffectiveHistory({
      stateDir,
      sessionId,
      headResponseId: finalResponseId,
    });
    assert.equal(finalHistory.incomplete, false);
    assert.doesNotMatch(JSON.stringify(finalHistory.replayableItems), new RegExp(evict));
    assert.match(JSON.stringify(finalHistory.replayableItems), new RegExp(keep));
    assert.match(JSON.stringify(finalHistory.replayableItems), /TURN_3_PRE_RESTART/);
    assert.match(JSON.stringify(finalHistory.replayableItems), /TURN_4_restart_smoke/);
  } finally {
    await runtime?.close();
    await upstream.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
