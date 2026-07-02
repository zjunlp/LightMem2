import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertRecoveryProtocolText,
  assertStablePrefixRewrite,
  type HostGatewayForwarder,
} from "@tokenpilot/host-adapter";
import { readVisualSessionData, readVisualSessionList } from "@tokenpilot/product-surface";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { createConsoleLogger } from "../src/logger.js";

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
    ) as { sessionId: string; savedCount: number };
    assert.equal(ux.sessionId, "sess-state-1");
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
    assertStablePrefixRewrite({
      sanitizedPromptText: String(seenPayloads[0]?.system ?? ""),
      dynamicContextText: String(((seenPayloads[0]?.messages as Array<Record<string, unknown>>)?.[0]?.content as Array<Record<string, unknown>>)?.[0]?.text ?? ""),
      workdir: "/tmp/demo",
      agentId: "agent-123",
    });
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
