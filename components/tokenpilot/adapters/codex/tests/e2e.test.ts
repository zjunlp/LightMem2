import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
  assertProductSurfaceSmoke,
  assertRecoveryProtocolText,
  assertRecoveryRoundTrip,
  assertReductionMarkerText,
  createLongToolPayload,
  reserveUnusedPort,
  startMockJsonUpstream,
  withTempHome,
} from "@tokenpilot/host-adapter";
import { MEMORY_FAULT_RECOVER_TOOL_NAME, handleMcpRequest } from "../../../products/mcp/src/index.js";
import { createCodexCliBridge } from "../../../products/cli/src/hosts/codex.js";
import {
  defaultCodexConfigPath,
  defaultHooksConfigPath,
  defaultTokenPilotConfigPath,
  loadTokenPilotCodexConfig,
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../src/config.js";
import { installCodexTokenPilot } from "../src/install.js";
import { processCodexHookEvent } from "../src/hooks-handler.js";
import { createConsoleLogger } from "../src/logger.js";
import { startCodexResponsesProxy } from "../src/proxy-runtime.js";

test("Codex host e2e wires install, proxy reduction, report/visual, and MCP recovery together", async () => {
  await withTempHome("lightmem2-codex-e2e-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const hooksConfigPath = defaultHooksConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();
    const longToolPayload = createLongToolPayload();
    let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;

    const upstream = await startMockJsonUpstream({
      responseBody: {
        id: "resp_e2e_1",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      },
    });

    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        proxyPort,
        stateDir,
        upstreamProvider: "OpenAI",
        hooks: {
          dynamicContextTarget: "user",
        },
        reduction: {
          triggerMinChars: 256,
          maxToolChars: 280,
          passes: {
            readStateCompaction: false,
            toolPayloadTrim: true,
            htmlSlimming: false,
            execOutputTruncation: true,
            agentsStartupOptimization: false,
          },
        },
      }),
      tokenPilotConfigPath,
    );

    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    const codexToml = [
      "model_provider = \"tokenpilot\"",
      "",
      "[model_providers.tokenpilot]",
      "name = \"TokenPilot\"",
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
      "[model_providers.OpenAI]",
      "name = \"OpenAI\"",
      `base_url = ${JSON.stringify(upstream.baseUrl)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify("/tmp/server.js")}]`,
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover.env]",
      `TOKENPILOT_STATE_DIR = ${JSON.stringify(stateDir)}`,
      "",
    ].join("\n");
    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeFile(codexConfigPath, codexToml, "utf8");

    const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      codexConfigPath,
    });

    const response = await fetch(`${runtime.baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "tokenpilot/gpt-5.4-mini",
        stream: false,
        instructions: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "summarize this tool output" },
            ],
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: longToolPayload,
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0]?.model, "gpt-5.4-mini");
    assert.match(String(upstream.requests[0]?.instructions ?? ""), /Your working directory is: \/repo\/demo/);
    assert.match(String(upstream.requests[0]?.instructions ?? ""), /Runtime: agent=agent-123 \|/);
    assertRecoveryProtocolText(String(upstream.requests[0]?.instructions ?? ""));

    const forwardedInput = upstream.requests[0]?.input as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(forwardedInput));
    const firstUser = forwardedInput[0];
    const firstBlocks = firstUser?.content as Array<Record<string, unknown>>;

    const reducedToolItem = forwardedInput[1];
    const reducedOutput = String(reducedToolItem?.output ?? "");
    assertReductionMarkerText(reducedOutput);
    await assertRecoveryRoundTrip({
      reducedText: reducedOutput,
      stateDir,
      async recover(dataKey) {
        const recovery = await handleMcpRequest(
          {
            id: 1,
            method: "tools/call",
            params: {
              name: MEMORY_FAULT_RECOVER_TOOL_NAME,
              arguments: {
                dataKey,
              },
            },
          },
          { stateDir },
        );
        const recoveryContent = recovery?.result?.content as Array<{ type: string; text: string }>;
        return {
          isError: recovery?.result?.isError === true,
          text: recoveryContent?.[0]?.text ?? "",
        };
      },
    });

    const { handleCommand } = createCodexCliBridge({ host: "codex" });

    await assertProductSurfaceSmoke({
      run(args) {
        return handleCommand({ args });
      },
      doctorPatterns: [
        /TokenPilot Codex doctor:/,
        /provider installed: yes/,
        /recovery MCP installed: yes/,
        /hooks installed: yes/,
        /proxy healthy: yes/,
      ],
      report: {
        unitLabel: "chars",
      },
      visual: {
        header: "TokenPilot Codex visual:",
        requiredPatterns: [
          /model: gpt-5.4-mini/,
          /response chain: resp_e2e_1/,
        ],
      },
    });

    await runtime?.close();
    await upstream.close();
  });
});

test("Codex streaming requests persist response-session mapping before the next turn resolves", async () => {
  await withTempHome("lightmem2-codex-stream-session-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const upstreamPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();
    const requests: Array<Record<string, unknown>> = [];

    const upstream = createHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);

      const stream = requests.length === 1;
      if (stream) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream; charset=utf-8");
        res.write("event: response.created\n");
        res.write("data: {\"response\":{\"id\":\"resp-stream-1\"}}\n\n");
        res.write("event: response.output_text.delta\n");
        res.write("data: {\"delta\":{\"output_text\":\"hello\"}}\n\n");
        res.write("event: response.completed\n");
        res.write("data: {\"usage\":{\"input_tokens\":10,\"output_tokens\":3}}\n\n");
        res.end("data: [DONE]\n\n");
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "resp-turn-2",
        object: "response",
        previous_response_id: "resp-stream-1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "continued" }],
          },
        ],
      }));
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });

    try {
      await writeTokenPilotCodexConfig(
        normalizeTokenPilotCodexConfig({
          proxyPort,
          stateDir,
          upstreamProvider: "OpenAI",
          upstream: {
            name: "OpenAI",
            baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            wireApi: "responses",
            requiresOpenAIAuth: true,
          },
          reduction: {
            triggerMinChars: 999999,
            maxToolChars: 999999,
            passes: {
              readStateCompaction: false,
              toolPayloadTrim: false,
              htmlSlimming: false,
              execOutputTruncation: false,
              agentsStartupOptimization: false,
            },
          },
        }),
        tokenPilotConfigPath,
      );

      const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
      const runtime = await startCodexResponsesProxy({
        config,
        logger: createConsoleLogger(false),
        codexConfigPath,
      });

      try {
        const streamResp = await fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: true,
            input: [{ role: "user", content: "turn one" }],
          }),
        });
        assert.equal(streamResp.status, 200);
        await streamResp.text();

        const secondResp = await fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: false,
            previous_response_id: "resp-stream-1",
            input: [{ role: "user", content: "turn two" }],
          }),
        });
        assert.equal(secondResp.status, 200);

        const latestRaw = await readFile(join(stateDir, "session-state", "latest.json"), "utf8");
        const latest = JSON.parse(latestRaw) as { sessionId?: string };
        const latestSessionId = String(latest.sessionId ?? "");
        assert.match(latestSessionId, /^codex-synth-/);

        const bindingsRaw = await readFile(
          join(stateDir, "session-state", "bindings", `${encodeURIComponent(latestSessionId)}.jsonl`),
          "utf8",
        );
        const bindings = bindingsRaw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as {
          sessionId: string;
          responseId?: string;
          previousResponseId?: string;
        });

        assert.equal(bindings.length, 2);
        assert.equal(bindings[0]?.sessionId, latestSessionId);
        assert.equal(bindings[1]?.sessionId, latestSessionId);
        assert.equal(bindings[0]?.responseId, "resp-stream-1");
        assert.equal(bindings[1]?.responseId, "resp-turn-2");
        assert.equal(requests[1]?.previous_response_id, "resp-stream-1");
      } finally {
        await runtime.close();
      }
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

test("Codex requests reuse synth sessions through prompt_cache_key when previous_response_id is unavailable", async () => {
  await withTempHome("lightmem2-codex-prompt-cache-session-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const upstreamPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();
    const requests: Array<Record<string, unknown>> = [];

    const upstream = createHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `resp-pk-${requests.length}`,
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `turn-${requests.length}` }],
          },
        ],
      }));
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });

    try {
      await writeTokenPilotCodexConfig(
        normalizeTokenPilotCodexConfig({
          proxyPort,
          stateDir,
          upstreamProvider: "OpenAI",
          upstream: {
            name: "OpenAI",
            baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            wireApi: "responses",
            requiresOpenAIAuth: true,
          },
          reduction: {
            triggerMinChars: 999999,
            maxToolChars: 999999,
            passes: {
              readStateCompaction: false,
              toolPayloadTrim: false,
              htmlSlimming: false,
              execOutputTruncation: false,
              agentsStartupOptimization: false,
            },
          },
        }),
        tokenPilotConfigPath,
      );

      const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
      const runtime = await startCodexResponsesProxy({
        config,
        logger: createConsoleLogger(false),
        codexConfigPath,
      });

      try {
        const firstResp = await fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: false,
            prompt_cache_key: "pk-codex-session-1",
            input: [{ role: "user", content: "turn one" }],
          }),
        });
        assert.equal(firstResp.status, 200);

        const secondResp = await fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: false,
            prompt_cache_key: "pk-codex-session-1",
            input: [{ role: "user", content: "turn two" }],
          }),
        });
        assert.equal(secondResp.status, 200);

        const latestRaw = await readFile(join(stateDir, "session-state", "latest.json"), "utf8");
        const latest = JSON.parse(latestRaw) as { sessionId?: string };
        const latestSessionId = String(latest.sessionId ?? "");
        assert.match(latestSessionId, /^codex-synth-/);

        const bindingsRaw = await readFile(
          join(stateDir, "session-state", "bindings", `${encodeURIComponent(latestSessionId)}.jsonl`),
          "utf8",
        );
        const bindings = bindingsRaw.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as {
          sessionId: string;
          responseId?: string;
        });

        assert.equal(bindings.length, 2);
        assert.equal(bindings[0]?.sessionId, latestSessionId);
        assert.equal(bindings[1]?.sessionId, latestSessionId);
        assert.equal(bindings[0]?.responseId, "resp-pk-1");
        assert.equal(bindings[1]?.responseId, "resp-pk-2");
        assert.equal(requests[0]?.prompt_cache_key, "pk-codex-session-1");
        assert.equal(requests[1]?.prompt_cache_key, "pk-codex-session-1");
      } finally {
        await runtime.close();
      }
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

test("Codex CLI report and visual return clear empty-state messages before any runtime data exists", async () => {
  await withTempHome("lightmem2-codex-cli-empty-state-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();

    await mkdir(join(homeDir, ".codex"), { recursive: true });
    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        proxyPort,
        stateDir,
      }),
      tokenPilotConfigPath,
    );

    const { handleCommand } = createCodexCliBridge({ host: "codex" });

    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "No TokenPilot session stats yet.");

    const visual = await handleCommand({ args: "visual" });
    assert.equal(visual.text, "No Codex TokenPilot session data found.");
  });
});

test("Codex proxy merges hook-observed metadata into the synthesized session when prompt_cache_key carries the real Codex session id", async () => {
  await withTempHome("lightmem2-codex-hook-session-merge-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const upstreamPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();

    const upstream = createHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "resp-merge-1",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      }));
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(upstreamPort, "127.0.0.1", () => {
        upstream.off("error", reject);
        resolve();
      });
    });

    try {
      await mkdir(join(homeDir, ".codex"), { recursive: true });
      await writeTokenPilotCodexConfig(
        normalizeTokenPilotCodexConfig({
          proxyPort,
          stateDir,
          upstreamProvider: "OpenAI",
          upstream: {
            name: "OpenAI",
            baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
            wireApi: "responses",
            requiresOpenAIAuth: true,
          },
        }),
        tokenPilotConfigPath,
      );

      await processCodexHookEvent({
        hook_event_name: "PostToolUse",
        session_id: "019f-real-codex-session",
        cwd: "/repo/from-hook",
        tool_name: "read",
        tool_input: "file.ts",
        tool_response: "content",
      });

      const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
      const runtime = await startCodexResponsesProxy({
        config,
        logger: createConsoleLogger(false),
        codexConfigPath,
      });

      try {
        const response = await fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: false,
            prompt_cache_key: "019f-real-codex-session",
            input: [{ role: "user", content: "turn one" }],
          }),
        });
        assert.equal(response.status, 200);

        const latestRaw = await readFile(join(stateDir, "session-state", "latest.json"), "utf8");
        const latest = JSON.parse(latestRaw) as { sessionId?: string };
        const synthSessionId = String(latest.sessionId ?? "");
        assert.match(synthSessionId, /^codex-synth-/);

        const synthSnapshotRaw = await readFile(
          join(stateDir, "session-state", "sessions", `${encodeURIComponent(synthSessionId)}.json`),
          "utf8",
        );
        const synthSnapshot = JSON.parse(synthSnapshotRaw) as {
          workspaceHint?: string;
          lastHookEvent?: string;
          lastToolName?: string;
        };
        assert.equal(synthSnapshot.workspaceHint, "/repo/from-hook");
        assert.equal(synthSnapshot.lastHookEvent, "PostToolUse");
        assert.equal(synthSnapshot.lastToolName, "read");
      } finally {
        await runtime.close();
      }
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
