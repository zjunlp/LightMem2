import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
  assertColdWarmCacheUsage,
  assertProductSurfaceSmoke,
  assertRecoveryProtocolText,
  assertRecoveryRoundTrip,
  assertReductionMarkerText,
  createLongToolPayload,
  reserveUnusedPort,
  startMockCachingJsonUpstream,
  startMockJsonUpstream,
  withTempHome,
} from "@lightmem2/host-adapter";
import { readVisualSessionData, readVisualSessionList } from "@lightmem2/product-surface";
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
        ux: {
          details: true,
        } as any,
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
        tools: [
          { type: "function", function: { name: "z_tool", parameters: { z: 1, a: 2 } } },
          { type: "function", function: { name: "a_tool", parameters: { b: true, a: false } } },
        ],
        input: [
          {
            role: "developer",
            content: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
          },
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
    assert.doesNotMatch(String(upstream.requests[0]?.instructions ?? ""), /Runtime: agent=agent-123 \|/);
    assertRecoveryProtocolText(String(upstream.requests[0]?.instructions ?? ""));
    assert.equal(Array.isArray(upstream.requests[0]?.tools), true);
    assert.equal((upstream.requests[0]?.tools as Array<any>)[0]?.function?.name, "a_tool");
    assert.equal((upstream.requests[0]?.tools as Array<any>)[1]?.function?.name, "z_tool");
    assert.deepEqual((upstream.requests[0]?.tools as Array<any>)[0]?.function?.parameters, { a: false, b: true });
    assert.deepEqual((upstream.requests[0]?.tools as Array<any>)[1]?.function?.parameters, { a: 2, z: 1 });

    const forwardedInput = upstream.requests[0]?.input as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(forwardedInput));
    const firstUser = forwardedInput.find((item) => item?.role === "user");
    const firstBlocks = firstUser?.content as Array<Record<string, unknown>>;
    assert.match(String(firstBlocks?.[0]?.text ?? ""), /WORKDIR: \/repo\/demo/);
    assert.match(String(firstBlocks?.[0]?.text ?? ""), /AGENT_ID: agent-123/);

    const reducedToolItem = forwardedInput.find((item) => String(item?.type ?? "").toLowerCase() === "function_call_output");
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
        unitLabel: "tokens",
      },
      visual: {
        header: "LightMem2 visual:",
        requiredPatterns: [
          /host=codex/,
          /session=codex-synth-/,
          /Codex: 1 session snapshots/,
        ],
      },
    });

    const sessions = await readVisualSessionList(stateDir);
    assert.equal(sessions.length, 1);
    assert.match(sessions[0]?.sessionId ?? "", /^codex-synth-/);
    assert.equal(sessions[0]?.stabilityCount, 1);
    assert.ok((sessions[0]?.reductionCount ?? 0) > 0);
    const latestUx = JSON.parse(
      await readFile(join(stateDir, "ux-effects", "latest.json"), "utf8"),
    ) as { countMode?: string; savedCount?: number };
    assert.equal(latestUx.countMode, "openai_tokens");
    assert.ok((latestUx.savedCount ?? 0) > 0);

    const visual = await readVisualSessionData(stateDir, String(sessions[0]?.sessionId ?? ""));
    assert.equal(visual.stability.length, 1);
    assert.ok(visual.reduction.length > 0);
    assert.match(visual.stability[0]?.developerCanonical ?? "", /<WORKDIR>/);
    assert.match(visual.stability[0]?.dynamicContextText ?? "", /WORKDIR: \/repo\/demo/);
    assert.ok((visual.reduction[0]?.savedChars ?? 0) > 0);
    const cacheAuditLines = (await readFile(join(stateDir, "cache-audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(cacheAuditLines.length > 0, true);
    assert.equal(typeof cacheAuditLines[0]?.stablePrefixFingerprint, "string");
    assert.equal(cacheAuditLines[0]?.originalRequestPromptCacheKey, null);
    assert.equal(typeof cacheAuditLines[0]?.requestPromptCacheKey, "string");
    assert.equal(Array.isArray(cacheAuditLines[0]?.entropyFindings), true);
    assert.equal(Array.isArray(cacheAuditLines[0]?.driftReasons), true);

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

test("Codex cold and warm requests expose prompt cache hit usage when stable prefix stays fixed", async () => {
  await withTempHome("lightmem2-codex-cache-warm-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();

    const upstream = await startMockCachingJsonUpstream();
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
    ].join("\n");
    await writeFile(codexConfigPath, codexToml, "utf8");

    const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    const runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      codexConfigPath,
    });

    try {
      const requestBody = {
        model: "tokenpilot/gpt-5.4-mini",
        stream: false,
        prompt_cache_key: "pk-codex-warm-session-1",
        instructions: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        input: [
          {
            role: "developer",
            content: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "say hi" }],
          },
        ],
      };

      const responseA = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const responseB = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);

      const bodyA = await responseA.json() as Record<string, unknown>;
      const bodyB = await responseB.json() as Record<string, unknown>;
      assert.equal(typeof upstream.requests[0]?.prompt_cache_key, "string");
      assert.equal(upstream.requests[0]?.prompt_cache_key, upstream.requests[1]?.prompt_cache_key);
      assert.equal(upstream.requests[0]?.prompt_cache_key, "pk-codex-warm-session-1");
      assertColdWarmCacheUsage([bodyA.usage, bodyB.usage]);

      const sessions = await readVisualSessionList(stateDir);
      const targetSession = sessions.find((entry) => Number(entry.cacheAuditSummary?.warmHits ?? 0) > 0);
      assert.equal(typeof targetSession?.sessionId, "string");
      const sessionId = String(targetSession?.sessionId ?? "");
      assert.match(sessionId, /^codex-synth-/);
      assert.equal(targetSession?.cacheAuditSummary?.warmCandidates, 1);
      assert.equal(targetSession?.cacheAuditSummary?.warmHits, 1);
      assert.equal(targetSession?.cacheAuditSummary?.warmMisses, 0);

      const visual = await readVisualSessionData(stateDir, sessionId);
      assert.equal(visual.cacheAuditSummary?.warmCandidates, 1);
      assert.equal(visual.cacheAuditSummary?.warmHits, 1);
      assert.equal(visual.cacheAuditSummary?.warmMisses, 0);
      assert.equal((visual.recentCacheAudit?.length ?? 0) >= 2, true);
      assert.equal(visual.recentCacheAudit?.[0]?.diagnosis.matchedResult, "warm hit");
      assert.equal((visual.recentCacheAudit?.[0]?.cachedInputTokens ?? 0) > 0, true);
      assert.deepEqual(visual.recentCacheAudit?.[0]?.driftKeys ?? [], []);

      const warmFingerprintGroup = visual.recentCacheAuditGroups?.find((group) => group.warmHitCount > 0);
      assert.equal(typeof warmFingerprintGroup?.stablePrefixFingerprint, "string");
      assert.equal(warmFingerprintGroup?.warmHitCount, 1);
    } finally {
      await runtime.close();
      await upstream.close();
    }
  });
});

test("Codex preserves different inbound prompt_cache_key values upstream while audit still tracks the same stable request family", async () => {
  await withTempHome("lightmem2-codex-force-key-rewrite-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();
    const upstream = await startMockCachingJsonUpstream();

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
    ].join("\n");
    await writeFile(codexConfigPath, codexToml, "utf8");

    const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    const runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      codexConfigPath,
    });

    try {
      const makeBody = (promptCacheKey: string) => JSON.stringify({
        model: "tokenpilot/gpt-5.4-mini",
        stream: false,
        prompt_cache_key: promptCacheKey,
        instructions: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        input: [
          {
            role: "developer",
            content: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "say hi" }],
          },
        ],
      });

      const responseA = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: makeBody("legacy-key-a"),
      });
      const responseB = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: makeBody("legacy-key-b"),
      });

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);
      assert.equal(typeof upstream.requests[0]?.prompt_cache_key, "string");
      assert.equal(upstream.requests[0]?.prompt_cache_key, "legacy-key-a");
      assert.equal(upstream.requests[1]?.prompt_cache_key, "legacy-key-b");
    } finally {
      await runtime.close();
      await upstream.close();
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
        assert.equal(typeof requests[0]?.prompt_cache_key, "string");
        assert.equal(requests[0]?.prompt_cache_key, requests[1]?.prompt_cache_key);
        assert.equal(requests[0]?.prompt_cache_key, "pk-codex-session-1");
      } finally {
        await runtime.close();
      }
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

test("Codex cache audit reports cold miss and drift key when stable prefix changes", async () => {
  await withTempHome("lightmem2-codex-cache-drift-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
    const codexConfigPath = defaultCodexConfigPath();
    const tokenPilotConfigPath = defaultTokenPilotConfigPath();

    const upstream = await startMockCachingJsonUpstream();
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
    ].join("\n");
    await writeFile(codexConfigPath, codexToml, "utf8");

    const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    const runtime = await startCodexResponsesProxy({
      config,
      logger: createConsoleLogger(false),
      codexConfigPath,
    });

    try {
      const shared = {
        model: "tokenpilot/gpt-5.4-mini",
        stream: false,
        input: [
          {
            role: "developer",
            content: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "say hi" }],
          },
        ],
      };

      const requestA = {
        ...shared,
        instructions: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
      };
      const requestB = {
        ...shared,
        instructions: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
      };
      const requestC = {
        ...shared,
        instructions: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nUse concise bullets.",
        input: [
          {
            role: "developer",
            content: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nUse concise bullets.",
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "say hi" }],
          },
        ],
      };

      const responseA = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestA),
      });
      const bodyA = await responseA.json() as Record<string, unknown>;
      const responseB = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...requestB,
          previous_response_id: bodyA.id,
        }),
      });
      const bodyB = await responseB.json() as Record<string, unknown>;
      const responseC = await fetch(`${runtime.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...requestC,
          previous_response_id: bodyB.id,
        }),
      });

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);
      assert.equal(responseC.status, 200);

      const bodyC = await responseC.json() as Record<string, unknown>;
      assertColdWarmCacheUsage([bodyA.usage, bodyB.usage]);
      assert.equal((bodyC.usage as Record<string, unknown>)?.cache_read_input_tokens ?? 0, 0);

      const sessions = await readVisualSessionList(stateDir);
      const targetSession = sessions.find((entry) => Number(entry.cacheAuditSummary?.warmHits ?? 0) > 0);
      assert.equal(typeof targetSession?.sessionId, "string");
      const sessionId = String(targetSession?.sessionId ?? "");

      const visual = await readVisualSessionData(stateDir, sessionId);
      assert.equal(visual.cacheAuditSummary?.warmCandidates, 1);
      assert.equal(visual.cacheAuditSummary?.warmHits, 1);
      assert.equal(visual.cacheAuditSummary?.warmMisses, 0);
      assert.equal(visual.cacheAuditSummary?.hitRatePercent, 100);

      const diagnosticEntry = visual.recentCacheAudit?.find((entry) => entry.diagnosis.matchedResult !== "warm hit");
      assert.equal(typeof diagnosticEntry?.stablePrefixFingerprint, "string");
      assert.equal(diagnosticEntry?.cachedInputTokens, 0);
      assert.equal(diagnosticEntry?.diagnosis.matchedResult, "cold start");
      assert.match(diagnosticEntry?.diagnosis.currentState ?? "", /Cold start/i);
      assert.match(diagnosticEntry?.diagnosis.optimizationHint ?? "", /(Session-local|Cold start)/i);
    } finally {
      await runtime.close();
      await upstream.close();
    }
  });
});

test("Codex upstream retry drops unsupported prompt_cache_retention while preserving prompt_cache_key", async () => {
  await withTempHome("lightmem2-codex-unsupported-retention-", async (homeDir) => {
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
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(payload);

      if ("prompt_cache_retention" in payload) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: {
            message: "Unsupported parameter: prompt_cache_retention",
            type: "bad_response_status_code",
            param: "",
            code: "bad_response_status_code",
          },
        }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "resp-retry-1",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
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
        const response = await fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: false,
            input: [
              {
                role: "developer",
                content: "Your working directory is: /repo/demo\nBe precise.",
              },
              {
                role: "user",
                content: "hello",
              },
            ],
          }),
        });
        assert.equal(response.status, 200);
        assert.equal(requests.length, 2);
        assert.equal(typeof requests[0]?.prompt_cache_key, "string");
        assert.equal(requests[0]?.prompt_cache_retention, "24h");
        assert.equal(typeof requests[1]?.prompt_cache_key, "string");
        assert.equal("prompt_cache_retention" in (requests[1] ?? {}), false);
      } finally {
        await runtime.close();
      }
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

test("Codex caches unsupported optional Responses fields and skips retry on later requests", async () => {
  await withTempHome("lightmem2-codex-capability-cache-", async (homeDir) => {
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
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(payload);

      if ("prompt_cache_retention" in payload) {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          error: {
            message: "Unsupported parameter: prompt_cache_retention",
            type: "bad_response_status_code",
            param: "",
            code: "bad_response_status_code",
          },
        }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: `resp-capability-${requests.length}`,
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "ok" }],
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
        const makeRequest = () => fetch(`${runtime.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "tokenpilot/gpt-5.4-mini",
            stream: false,
            input: [
              {
                role: "developer",
                content: "Your working directory is: /repo/demo\nBe precise.",
              },
              {
                role: "user",
                content: "hello",
              },
            ],
          }),
        });

        const first = await makeRequest();
        const second = await makeRequest();
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(requests.length, 3);
        assert.equal(requests[0]?.prompt_cache_retention, "24h");
        assert.equal("prompt_cache_retention" in (requests[1] ?? {}), false);
        assert.equal("prompt_cache_retention" in (requests[2] ?? {}), false);

        const capabilityRaw = await readFile(
          join(
            stateDir,
            "upstream-capabilities",
            "responses",
            encodeURIComponent(`http://127.0.0.1:${upstreamPort}/v1/responses`) + ".json",
          ),
          "utf8",
        );
        const capability = JSON.parse(capabilityRaw) as { unsupportedOptionalFields?: string[] };
        assert.deepEqual(capability.unsupportedOptionalFields, ["prompt_cache_retention"]);
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
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=codex/);
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
        assert.notEqual(synthSessionId, "019f-real-codex-session");

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
