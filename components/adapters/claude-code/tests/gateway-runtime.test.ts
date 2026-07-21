import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRecoveryProtocolText,
  assertStablePrefixRewrite,
  type HostGatewayForwarder,
} from "@lightmem2/host-adapter";
import { readVisualSessionData, readVisualSessionList } from "@lightmem2/product-surface";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

async function reserveUnusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTestJsonServer(handler: (
  req: import("node:http").IncomingMessage,
  body: string,
) => {
  status?: number;
  headers?: Record<string, string>;
  payload?: unknown;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const port = await reserveUnusedPort();
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const result = handler(req, body);
    res.statusCode = result.status ?? 200;
    res.setHeader("content-type", "application/json");
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      res.setHeader(key, value);
    }
    res.end(JSON.stringify(result.payload ?? {}));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("gateway runtime serves health and forwards Claude Messages requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: unknown[] = [];
  const forwarder: HostGatewayForwarder = {
    async request(params) {
      seenPayloads.push(params.payload);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 12, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const healthResp = await fetch(`${runtime.baseUrl}/health`);
    assert.equal(healthResp.status, 200);
    const health = await healthResp.json();
    assert.equal(health.ok, true);

    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        system: "stay stable",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);
    const payload = await requestResp.json();
    assert.equal(payload.id, "msg_test_1");
    assert.equal((seenPayloads as Record<string, unknown>[]).length, 1);
    assert.equal(((seenPayloads[0] as Record<string, unknown>).model), "claude-sonnet-4-6");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime proxies Claude model discovery and count_tokens for Anthropic-compatible upstreams", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-probes-"));
  const proxyPort = await reserveUnusedPort();
  const seenRequests: Array<{ method: string; url: string; auth?: string; xApiKey?: string }> = [];
  const upstream = await startTestJsonServer((req, body) => {
    seenRequests.push({
      method: String(req.method ?? ""),
      url: String(req.url ?? ""),
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      xApiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
    });
    if (req.method === "GET" && req.url === "/anthropic/v1/models") {
      return {
        payload: {
          data: [{ id: "deepseek-chat", type: "model", display_name: "DeepSeek Chat" }],
        },
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages/count_tokens") {
      return {
        payload: {
          input_tokens: 42,
        },
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages") {
      const parsed = JSON.parse(body) as { model?: string };
      return {
        payload: {
          id: "msg_probe_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: String(parsed.model ?? "ok") }],
        },
      };
    }
    return {
      status: 404,
      payload: {
        error: "not found",
      },
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const modelsResp = await fetch(`${runtime.baseUrl}/v1/models`, {
      headers: {
        authorization: "Bearer inbound-token",
      },
    });
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json() as { data?: Array<{ id?: string }> };
    assert.equal(models.data?.[0]?.id, "deepseek-chat");

    const countResp = await fetch(`${runtime.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer inbound-token",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        system: "stay stable",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      }),
    });
    assert.equal(countResp.status, 200);
    const countPayload = await countResp.json() as { input_tokens?: number };
    assert.equal(countPayload.input_tokens, 42);

    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer inbound-token",
        "x-session-id": "sess-probes-1",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        max_tokens: 64,
      }),
    });
    assert.equal(requestResp.status, 200);
    const payload = await requestResp.json() as { content?: Array<{ text?: string }> };
    assert.equal(payload.content?.[0]?.text, "deepseek-chat");

    assert.deepEqual(
      seenRequests.map((item) => [item.method, item.url]),
      [
        ["GET", "/anthropic/v1/models"],
        ["POST", "/anthropic/v1/messages/count_tokens"],
        ["POST", "/anthropic/v1/messages"],
      ],
    );
    assert.equal(seenRequests[0]?.auth, "Bearer inbound-token");
    assert.equal(seenRequests[0]?.xApiKey, undefined);
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime synthesizes a local model list when DeepSeek anthropic /v1/models is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-model-fallback-"));
  const proxyPort = await reserveUnusedPort();
  const upstream = await startTestJsonServer((req, body) => {
    if (req.method === "GET" && req.url === "/anthropic/v1/models") {
      return {
        status: 404,
        payload: {},
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages") {
      const parsed = JSON.parse(body) as { model?: string };
      return {
        payload: {
          id: "msg_fallback_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: String(parsed.model ?? "ok") }],
        },
      };
    }
    if (req.method === "POST" && req.url === "/anthropic/v1/messages/count_tokens") {
      return {
        payload: {
          input_tokens: 7,
        },
      };
    }
    return {
      status: 404,
      payload: {},
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const modelsResp = await fetch(`${runtime.baseUrl}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json() as { data?: Array<{ id?: string }> };
    const ids = (models.data ?? []).map((item) => item.id);
    assert.ok(ids.length > 0);
    assert.ok(ids.some((id) => typeof id === "string" && id.startsWith("claude-")));
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime synthesizes configured third-party model ids when upstream model discovery is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-generic-models-"));
  const proxyPort = await reserveUnusedPort();
  const seenRequests: Array<{ method: string; url: string; body?: { model?: string } }> = [];
  const upstream = await startTestJsonServer((req, body) => {
    const parsed = body ? JSON.parse(body) as { model?: string } : undefined;
    seenRequests.push({
      method: String(req.method ?? ""),
      url: String(req.url ?? ""),
      body: parsed,
    });
    if (req.method === "POST" && req.url === "/anthropic/v1/messages") {
      return {
        payload: {
          id: "msg_generic_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: String(parsed?.model ?? "ok") }],
        },
      };
    }
    return {
      status: 404,
      payload: {
        error: "not found",
      },
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
      upstreamModel: "glm-5.2[1m]",
      visibleModels: ["glm-5.2[1m]", "glm-4.7"],
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const modelsResp = await fetch(`${runtime.baseUrl}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const models = await modelsResp.json() as { data?: Array<{ id?: string }> };
    assert.deepEqual(models.data?.map((entry) => entry.id), ["glm-5.2[1m]", "glm-4.7"]);

    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-generic-models-1",
      },
      body: JSON.stringify({
        model: "glm-5.2[1m]",
        stream: false,
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        max_tokens: 64,
      }),
    });
    assert.equal(requestResp.status, 200);
    const payload = await requestResp.json() as { content?: Array<{ text?: string }> };
    assert.equal(payload.content?.[0]?.text, "glm-5.2[1m]");
    assert.deepEqual(
      seenRequests.map((item) => [item.method, item.url, item.body?.model]),
      [
        ["GET", "/anthropic/v1/models", undefined],
        ["POST", "/anthropic/v1/messages", "glm-5.2[1m]"],
      ],
    );
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime records session-state and ux-effects after a reduced request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-state-"));
  const proxyPort = await reserveUnusedPort();
  const longToolPayload = `payload\n${"line\n".repeat(800)}`;
  const forwarder: HostGatewayForwarder = {
    async request() {
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_state_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-state-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              { type: "tool_result", tool_use_id: "toolu_1", content: longToolPayload },
            ],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);

    const latest = JSON.parse(
      await readFile(join(dir, "state", "session-state", "latest.json"), "utf8"),
    ) as { sessionId: string };
    assert.equal(latest.sessionId, "sess-state-1");

    const snapshot = JSON.parse(
      await readFile(join(dir, "state", "session-state", "sessions", "sess-state-1.json"), "utf8"),
    ) as { latestResponseId?: string; reductionSavedChars?: number; workspaceHint?: string };
    assert.equal(snapshot.latestResponseId, "msg_state_1");
    assert.equal(typeof snapshot.reductionSavedChars, "number");
    assert.equal(snapshot.workspaceHint, "/repo/demo");

    const ux = JSON.parse(
      await readFile(join(dir, "state", "ux-effects", "latest.json"), "utf8"),
    ) as { sessionId: string; savedCount: number; countMode?: string };
    assert.equal(ux.sessionId, "sess-state-1");
    assert.equal(ux.countMode, "chars");
    assert.ok(ux.savedCount > 0);

    const sessions = await readVisualSessionList(join(dir, "state"));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "sess-state-1");
    assert.equal(sessions[0]?.stabilityCount, 1);
    assert.ok((sessions[0]?.reductionCount ?? 0) > 0);

    const visual = await readVisualSessionData(join(dir, "state"), "sess-state-1");
    assert.equal(visual.stability.length, 1);
    assert.ok(visual.reduction.length > 0);
    assert.match(visual.stability[0]?.developerCanonical ?? "", /<WORKDIR>/);
    assert.match(visual.stability[0]?.dynamicContextText ?? "", /WORKDIR: \/repo\/demo/);
    assert.ok((visual.reduction[0]?.savedChars ?? 0) > 0);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime reuses the latest real Claude hook session when request markers are absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-session-merge-"));
  const proxyPort = await reserveUnusedPort();
  const stateDir = join(dir, "state");
  const longToolPayload = `payload\n${"line\n".repeat(800)}`;
  const forwarder: HostGatewayForwarder = {
    async request() {
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_merge_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  await upsertClaudeCodeSessionSnapshot(stateDir, "claude-real-session-1", {
    lastHookEvent: "SessionStart",
    workspaceHint: "/repo/demo",
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir,
      proxyPort,
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (let turn = 0; turn < 2; turn += 1) {
      const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: false,
          system: "Your working directory is: /repo/demo",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `hello ${turn}` },
                { type: "tool_result", tool_use_id: `toolu_${turn}`, content: longToolPayload },
              ],
            },
          ],
          max_tokens: 64,
        }),
      });
      assert.equal(response.status, 200);
    }

    const latest = JSON.parse(
      await readFile(join(stateDir, "session-state", "latest.json"), "utf8"),
    ) as { sessionId: string };
    assert.equal(latest.sessionId, "claude-real-session-1");

    const sessions = await readVisualSessionList(stateDir);
    assert.deepEqual(sessions.map((entry) => entry.sessionId), ["claude-real-session-1"]);

    const visual = await readVisualSessionData(stateDir, "claude-real-session-1");
    assert.equal(visual.sessionId, "claude-real-session-1");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime reuses disclosed read paths from prior Claude session snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-disclosed-"));
  const proxyPort = await reserveUnusedPort();
  const codePayload = `
export function loadConfig(file: string) {
  return file.trim();
}

export function saveConfig(file: string, text: string) {
  return text + file;
}
`.repeat(30);
  const seenPayloads: Array<Record<string, unknown>> = [];
  const forwarder: HostGatewayForwarder = {
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_disclosed_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          usage: { input_tokens: 20, output_tokens: 5 },
          stop_reason: "end_turn",
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: false,
          agentsStartupOptimization: false,
        },
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (let turn = 0; turn < 2; turn += 1) {
      const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-disclosed-1",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          stream: false,
          system: "Your working directory is: /repo/demo",
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: `toolu_read_${turn}`,
                  name: "Read",
                  input: { path: "/repo/src/config.ts" },
                },
              ],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "summarize this" },
                { type: "tool_result", tool_use_id: `toolu_read_${turn}`, content: codePayload },
              ],
            },
          ],
          max_tokens: 256,
        }),
      });
      assert.equal(response.status, 200);
    }

    assert.equal(seenPayloads.length, 2);
    const firstMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const secondMessages = seenPayloads[1]?.messages as Array<Record<string, unknown>>;
    const firstToolResult = ((firstMessages?.[1]?.content as Array<Record<string, unknown>>)?.[1] ?? {}) as Record<string, unknown>;
    const secondToolResult = ((secondMessages?.[1]?.content as Array<Record<string, unknown>>)?.[1] ?? {}) as Record<string, unknown>;

    assert.match(String(firstToolResult.content ?? firstToolResult.text ?? ""), /\[code outlined lines=/);
    assert.doesNotMatch(String(secondToolResult.content ?? secondToolResult.text ?? ""), /\[code outlined lines=/);
    assert.match(String(secondToolResult.content ?? secondToolResult.text ?? ""), /export function loadConfig/);

    const snapshot = JSON.parse(
      await readFile(join(dir, "state", "session-state", "sessions", "sess-disclosed-1.json"), "utf8"),
    ) as { disclosedReadPaths?: string[] };
    assert.deepEqual(snapshot.disclosedReadPaths, ["/repo/src/config.ts"]);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime does not record ux-effects when reduced request fails upstream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-failed-"));
  const proxyPort = await reserveUnusedPort();
  const longToolPayload = `payload\n${"line\n".repeat(800)}`;
  const forwarder: HostGatewayForwarder = {
    async request() {
      throw new Error("upstream failed");
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      reduction: {
        triggerMinChars: 256,
        maxToolChars: 300,
        passes: {
          readStateCompaction: false,
          toolPayloadTrim: true,
          htmlSlimming: false,
          execOutputTruncation: true,
          agentsStartupOptimization: false,
        },
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-failed-1",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              { type: "tool_result", tool_use_id: "toolu_1", content: longToolPayload },
            ],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 500);
    await assert.rejects(
      readFile(join(dir, "state", "ux-effects", "latest.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime applies stable-prefix rewrite before forwarding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-stable-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_2",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-2",
      },
      body: JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);
    assert.equal(seenPayloads.length, 1);
    assert.equal(seenPayloads[0]?.model, "claude-sonnet-4-6");
    assert.match(String(seenPayloads[0]?.prompt_cache_key ?? ""), /^lightmem2-claude-/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Your working directory is: \/tmp\/demo/);
    assert.doesNotMatch(String(seenPayloads[0]?.system ?? ""), /Runtime: agent=agent-123\s*\|/);
    assert.match(
      String(((seenPayloads[0]?.messages as Array<Record<string, unknown>>)?.[0]?.content as Array<Record<string, unknown>>)?.[0]?.text ?? ""),
      /WORKDIR: \/tmp\/demo/,
    );
    assert.match(
      String(((seenPayloads[0]?.messages as Array<Record<string, unknown>>)?.[0]?.content as Array<Record<string, unknown>>)?.[0]?.text ?? ""),
      /AGENT_ID: agent-123/,
    );
    assert.match(String(seenPayloads[0]?.system ?? ""), /Be precise\./);
    assertRecoveryProtocolText(String(seenPayloads[0]?.system ?? ""));
    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedUserBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(forwardedUserBlocks), true);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime supports developer-targeted stable-prefix injection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-devtarget-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_3",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "developer",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-3",
      },
      body: JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(requestResp.status, 200);
    assert.equal(seenPayloads.length, 1);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Your working directory is: \/tmp\/demo/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Runtime: agent=agent-123 \|/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /WORKDIR: \/tmp\/demo/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /AGENT_ID: agent-123/);

    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedUserBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assert.equal(String(forwardedUserBlocks?.[0]?.text ?? ""), "hello");

    const visual = await readVisualSessionData(join(dir, "state"), "sess-runtime-3");
    assert.equal(visual.stability.length, 1);
    assert.equal(visual.stability[0]?.dynamicContextTarget, "developer");
    assert.match(visual.stability[0]?.developerForwarded ?? "", /WORKDIR: \/tmp\/demo/);
    assert.match(String(seenPayloads[0]?.prompt_cache_key ?? ""), /^lightmem2-claude-/);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime reuses the same Claude prompt_cache_key for the same stable prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-cache-key-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: "msg_test_cache_key",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (const agentId of ["agent-123", "agent-456"]) {
      const requestResp = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-runtime-cache-key",
        },
        body: JSON.stringify({
          model: "tokenpilot/claude-sonnet-4-6",
          stream: false,
          system: `Your working directory is: /tmp/demo\nRuntime: agent=${agentId} |\nBe precise.`,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          max_tokens: 256,
        }),
      });
      assert.equal(requestResp.status, 200);
    }

    assert.equal(seenPayloads.length, 2);
    assert.equal(seenPayloads[0]?.prompt_cache_key, seenPayloads[1]?.prompt_cache_key);
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime preserves inbound Claude prompt_cache_key while converging framework stable keys for diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-force-cache-key-"));
  const proxyPort = await reserveUnusedPort();
  const seenPayloads: Record<string, unknown>[] = [];
  const forwarder: HostGatewayForwarder = {
    async request(params) {
      seenPayloads.push(params.payload as Record<string, unknown>);
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
        text: JSON.stringify({
          id: `msg_force_cache_${seenPayloads.length}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        }),
      };
    },
    async requestStream() {
      throw new Error("stream path should not be used in this test");
    },
  };

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
    forwarder,
  });

  try {
    for (const inboundKey of ["legacy-key-a", "legacy-key-b"]) {
      const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-runtime-force-cache-key",
        },
        body: JSON.stringify({
          model: "tokenpilot/claude-sonnet-4-6",
          stream: false,
          prompt_cache_key: inboundKey,
          system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello" }],
            },
          ],
          max_tokens: 256,
        }),
      });
      assert.equal(response.status, 200);
    }

    assert.equal(seenPayloads.length, 2);
    assert.equal(typeof seenPayloads[0]?.prompt_cache_key, "string");
    assert.equal(seenPayloads[0]?.prompt_cache_key, "legacy-key-a");
    assert.equal(seenPayloads[1]?.prompt_cache_key, "legacy-key-b");
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway runtime caches unsupported prompt_cache_key for Anthropic-compatible upstreams and skips retry later", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-gateway-capability-"));
  const proxyPort = await reserveUnusedPort();
  const seenRequests: Array<Record<string, unknown>> = [];
  const upstream = await startTestJsonServer((_req, body) => {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    seenRequests.push(parsed);
    if ("prompt_cache_key" in parsed) {
      return {
        status: 400,
        payload: {
          error: {
            message: "Unsupported parameter: prompt_cache_key",
            type: "bad_response_status_code",
            param: "",
            code: "bad_response_status_code",
          },
        },
      };
    }
    return {
      payload: {
        id: `msg_cap_${seenRequests.length}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    };
  });

  const runtime = await startClaudeCodeGatewayRuntime({
    config: normalizeTokenPilotClaudeCodeConfig({
      stateDir: join(dir, "state"),
      proxyPort,
      upstreamBaseUrl: `${upstream.baseUrl}/anthropic`,
      hooks: {
        dynamicContextTarget: "user",
      },
    }),
    logger: createConsoleLogger(false),
  });

  try {
    const requestBody = JSON.stringify({
      model: "tokenpilot/claude-sonnet-4-6",
      stream: false,
      system: "Your working directory is: /tmp/demo\nRuntime: agent=agent-123 |\nBe precise.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      max_tokens: 256,
    });

    const first = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-capability-1",
      },
      body: requestBody,
    });
    const second = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-runtime-capability-1",
      },
      body: requestBody,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(seenRequests.length, 3);
    assert.equal(typeof seenRequests[0]?.prompt_cache_key, "string");
    assert.equal("prompt_cache_key" in (seenRequests[1] ?? {}), false);
    assert.equal("prompt_cache_key" in (seenRequests[2] ?? {}), false);

    const capabilityRaw = await readFile(
      join(
        dir,
        "state",
        "upstream-capabilities",
        "anthropic-messages",
        encodeURIComponent(`${upstream.baseUrl}/anthropic/v1/messages`) + ".json",
      ),
      "utf8",
    );
    const capability = JSON.parse(capabilityRaw) as { unsupportedOptionalFields?: string[] };
    assert.deepEqual(capability.unsupportedOptionalFields, ["prompt_cache_key"]);
  } finally {
    await runtime.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
});
