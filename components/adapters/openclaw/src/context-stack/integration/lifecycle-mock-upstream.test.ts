import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  reserveUnusedPort,
  type ContextMutationPlan,
} from "@lightrsi/host-adapter";
import { persistSessionTaskRegistry } from "@lightrsi/history";

import {
  createOpenClawReferenceBackend,
  type OpenClawReferenceBackendRequest,
} from "../../context-rewrite/reference-backend.js";
import {
  observeLifecycleFixture,
  readLifecycleFixtures,
  type LifecycleFixture,
} from "../../context-rewrite/lifecycle-fixture-support.js";
import { __testHooks, proxyRuntimeHelpers } from "../../plugin-test-support.js";
import { startEmbeddedResponsesProxy } from "./proxy-runtime.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (!block || typeof block !== "object") return "";
    const record = block as Record<string, unknown>;
    return String(record.text ?? record.output ?? "");
  }).join("");
}

function messageTaskIds(message: Record<string, unknown>): string[] {
  const details = message.details as { contextSafe?: { taskIds?: string[] } } | undefined;
  return details?.contextSafe?.taskIds ?? [];
}

function markerFor(fixture: LifecycleFixture, stableId: string): string {
  return fixture.expected.evictItemIds.includes(stableId)
    ? `EVICT_ME_${stableId}`
    : `KEEP_ME_${stableId}`;
}

function openClawRequest(
  fixture: LifecycleFixture,
  stateDir: string,
): OpenClawReferenceBackendRequest {
  const messages = fixture.input.snapshot.items.map((item) => {
    const marker = markerFor(fixture, item.stableId);
    const details = { contextSafe: { taskIds: item.taskIds ?? [] } };
    if (item.kind === "tool_call") {
      return {
        messageId: item.stableId,
        role: "assistant",
        content: [{
          type: "toolCall",
          id: item.callId,
          name: "fixture_tool",
          arguments: { marker },
        }],
        details,
      };
    }
    if (item.kind === "tool_result") {
      return {
        messageId: item.stableId,
        role: "toolResult",
        toolCallId: item.callId,
        toolName: "fixture_tool",
        content: [{ type: "text", text: marker }],
        details,
      };
    }
    return {
      messageId: item.stableId,
      role: item.role ?? (item.kind === "assistant" ? "assistant" : "user"),
      content: marker,
      details,
    };
  });
  const sessionId = fixture.input.registry.sessionId;
  return {
    stateDir,
    sessionId,
    state: {
      version: 1,
      sessionId,
      messages,
      seenMessageIds: messages.map((message) => String(message.messageId)),
      updatedAt: "2026-08-22T00:00:00.000Z",
    },
    evictionEnabled: true,
    evictionPolicy: "model_scored",
    evictionMinBlockChars: 1,
    evictionReplacementMode: "drop",
    helpers: {
      appendTaskStateTrace: async () => undefined,
      appendEvictionVisualSnapshot: async () => undefined,
      asRecord: (value) => value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined,
      canonicalMessageTaskIds: messageTaskIds,
      contentToText,
      dedupeStrings: (values) => [...new Set(values)],
      ensureContextSafeDetails: (_details, patch) => ({ contextSafe: patch }),
      extractPathLike: () => undefined,
      extractToolMessageText: (message) => contentToText(message.content),
      isToolResultLikeMessage: (message) => ["tool", "toolresult"].includes(
        String(message.role ?? "").toLowerCase(),
      ),
      logger,
      messageToolCallId: (message) => typeof message.toolCallId === "string"
        ? message.toolCallId
        : typeof message.tool_call_id === "string"
          ? message.tool_call_id
          : undefined,
      safeId: (value) => value,
    },
  };
}

function responsesInput(messages: Array<Record<string, unknown>>): unknown[] {
  return messages.map((message) => {
    const role = String(message.role ?? "user");
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCall = content.find((block) => (
      block && typeof block === "object"
      && String((block as Record<string, unknown>).type) === "toolCall"
    )) as Record<string, unknown> | undefined;
    if (toolCall) {
      return {
        type: "function_call",
        call_id: String(toolCall.id ?? ""),
        name: String(toolCall.name ?? "fixture_tool"),
        arguments: JSON.stringify(toolCall.arguments ?? {}),
      };
    }
    if (role.toLowerCase() === "toolresult") {
      return {
        type: "function_call_output",
        call_id: String(message.toolCallId ?? ""),
        output: contentToText(message.content),
      };
    }
    return {
      role: role === "assistant" ? "assistant" : "user",
      content: contentToText(message.content),
    };
  });
}

async function startMockUpstream() {
  const port = await reserveUnusedPort();
  const captured: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `resp-gua-openclaw-${captured.length}`,
      object: "response",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      }],
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
    captured,
    close: async () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function forwardThroughRealProxy(params: {
  stateDir: string;
  sessionId: string;
  input: unknown[];
}): Promise<Record<string, unknown>> {
  const upstream = await startMockUpstream();
  const proxyPort = await reserveUnusedPort();
  const cfg = __testHooks.normalizeConfig({
    stateDir: params.stateDir,
    proxyAutostart: true,
    proxyPort,
    proxyBaseUrl: upstream.baseUrl,
    proxyApiKey: "sanitized-test-key",
    proxyMode: { pureForward: true },
    modules: {
      stabilizer: false,
      policy: false,
      reduction: false,
      eviction: false,
    },
  });
  const proxy = await startEmbeddedResponsesProxy(
    cfg,
    logger,
    () => params.sessionId,
    {
      ...proxyRuntimeHelpers,
      detectUpstreamConfig: async () => null,
    },
  );
  assert.ok(proxy, "OpenClaw proxy must start");
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        stream: false,
        input: params.input,
      }),
    });
    const responseText = await response.text();
    assert.equal(
      response.status,
      200,
      responseText,
    );
    assert.equal(upstream.captured.length, 1);
    return upstream.captured[0]!;
  } finally {
    await proxy.close();
    await upstream.close();
  }
}

async function runLifecycleScenario(failEstimator: boolean): Promise<Record<string, unknown>> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-openclaw-lifecycle-upstream-"));
  try {
    const source = readLifecycleFixtures().find(
      (fixture) => fixture.id === "completed-tool-pair-evicts-current-keeps",
    );
    assert.ok(source, "completed lifecycle fixture must exist");
    const fixture = structuredClone(source);
    if (failEstimator) fixture.input.estimator = { kind: "throw" };

    const observation = await observeLifecycleFixture(fixture);
    const request = openClawRequest(fixture, stateDir);
    await persistSessionTaskRegistry(stateDir, observation.result.registry);
    let activeRequest = request;
    if (observation.result.plan) {
      const backend = createOpenClawReferenceBackend();
      const snapshot = await backend.readSnapshot({
        sessionId: request.sessionId,
        request,
      });
      const itemById = new Map(snapshot.items.map((item) => [item.stableId, item]));
      const plan: ContextMutationPlan = {
        ...observation.result.plan,
        hostId: "openclaw",
        sessionId: request.sessionId,
        baseRevision: snapshot.revision,
        operations: observation.result.plan.operations.map((operation) => ({
          ...operation,
          targetItemFingerprints: Object.fromEntries(
            operation.targetItemIds.map((itemId) => [itemId, itemById.get(itemId)!.fingerprint]),
          ),
        })),
      };
      const applied = await backend.apply({ snapshot, plan, request });
      assert.equal(
        applied.result.applied,
        true,
        JSON.stringify(applied.result),
      );
      activeRequest = applied.request;
    } else {
      assert.equal(observation.result.status, "bypassed");
    }

    return await forwardThroughRealProxy({
      stateDir,
      sessionId: request.sessionId,
      input: responsesInput(activeRequest.state.messages),
    });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("GUA OpenClaw real mock-upstream sees EVICT_ME removed and KEEP_ME retained", async () => {
  const captured = await runLifecycleScenario(false);
  const text = JSON.stringify(captured);
  assert.doesNotMatch(text, /EVICT_ME/);
  assert.match(text, /KEEP_ME/);
});

test("GUA OpenClaw estimator failure preserves the original upstream payload", async () => {
  const captured = await runLifecycleScenario(true);
  const text = JSON.stringify(captured);
  assert.match(text, /EVICT_ME/);
  assert.match(text, /KEEP_ME/);
});
