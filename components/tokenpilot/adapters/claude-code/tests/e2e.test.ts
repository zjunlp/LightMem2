import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
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
  withTempHome,
  type HostGatewayForwarder,
} from "@tokenpilot/host-adapter";
import { readVisualSessionData, readVisualSessionList } from "@tokenpilot/product-surface";
import { MEMORY_FAULT_RECOVER_TOOL_NAME, handleMcpRequest } from "../../../products/mcp/src/index.js";
import {
  defaultTokenPilotClaudeCodeConfigPath,
  loadTokenPilotClaudeCodeConfig,
  normalizeTokenPilotClaudeCodeConfig,
  writeTokenPilotClaudeCodeConfig,
} from "../src/config.js";
import { startClaudeCodeGatewayRuntime } from "../src/gateway-runtime.js";
import { installClaudeCodeTokenPilot } from "../src/install.js";
import { createConsoleLogger } from "../src/logger.js";
import { createClaudeCodeCliBridge } from "../../../products/cli/src/hosts/claude-code.js";

function extractToolResultText(block: Record<string, unknown> | undefined): string {
  if (!block) return "";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

test("Claude Code host e2e wires install, gateway reduction, report/visual, and MCP recovery together", async () => {
  await withTempHome("lightmem2-claude-e2e-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();
    const seenPayloads: Array<Record<string, unknown>> = [];
    const longToolPayload = createLongToolPayload();
    const forwarder: HostGatewayForwarder = {
      async request(params) {
        seenPayloads.push(params.payload as Record<string, unknown>);
        return {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
          text: JSON.stringify({
            id: "msg_e2e_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            usage: { input_tokens: 32, output_tokens: 6 },
            stop_reason: "end_turn",
          }),
        };
      },
      async requestStream() {
        throw new Error("stream path should not be used in this test");
      },
    };

    let runtime: Awaited<ReturnType<typeof startClaudeCodeGatewayRuntime>> | undefined;
    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
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
      configPath,
    );

    const installResult = await installClaudeCodeTokenPilot();
    assert.equal(installResult.tokenPilotConfigPath, configPath);
    assert.equal(installResult.stateDir, stateDir);

    const config = await loadTokenPilotClaudeCodeConfig(configPath);
    runtime = await startClaudeCodeGatewayRuntime({
      config,
      logger: createConsoleLogger(false),
      forwarder,
    });

    const response = await fetch(`${runtime.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-id": "sess-e2e-1",
      },
      body: JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this tool output" },
              { type: "tool_result", tool_use_id: "toolu_1", content: longToolPayload },
            ],
          },
        ],
        max_tokens: 256,
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(seenPayloads.length, 1);
    assert.equal(seenPayloads[0]?.model, "claude-sonnet-4-6");
    const forwardedMessages = seenPayloads[0]?.messages as Array<Record<string, unknown>>;
    const forwardedBlocks = forwardedMessages?.[0]?.content as Array<Record<string, unknown>>;
    assert.match(String(seenPayloads[0]?.system ?? ""), /Your working directory is: \/repo\/demo/);
    assert.doesNotMatch(String(seenPayloads[0]?.system ?? ""), /Runtime: agent=agent-123\s*\|/);
    assert.match(String(forwardedBlocks?.[0]?.text ?? ""), /WORKDIR: \/repo\/demo/);
    assert.match(String(forwardedBlocks?.[0]?.text ?? ""), /AGENT_ID: agent-123/);
    assert.match(String(seenPayloads[0]?.system ?? ""), /Be precise\./);
    assertRecoveryProtocolText(String(seenPayloads[0]?.system ?? ""));

    const reducedToolText = extractToolResultText(forwardedBlocks?.[1]);
    assertReductionMarkerText(reducedToolText);
    const cacheAuditRaw = await readFile(join(stateDir, "cache-audit.jsonl"), "utf8");
    const cacheAuditLines = cacheAuditRaw.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(cacheAuditLines.length, 1);
    assert.equal(typeof cacheAuditLines[0]?.stablePrefixFingerprint, "string");
    assert.equal(cacheAuditLines[0]?.sessionId, "sess-e2e-1");
    assert.equal(cacheAuditLines[0]?.cachedInputTokens, 0);
    await assertRecoveryRoundTrip({
      reducedText: reducedToolText,
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

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });

    await assertProductSurfaceSmoke({
      run(args) {
        return handleCommand({ args });
      },
      doctorPatterns: [
        /TokenPilot Claude Code doctor:/,
        /settings installed: yes/,
        /observability hooks installed: yes/,
        /observability hooks complete: yes/,
        /recovery MCP installed: yes/,
        /recovery MCP stateDir matches: yes/,
        /routed via gateway: yes/,
        /tool search enabled: yes/,
        /proxy healthy: yes/,
        /session state available: yes/,
        /ux effects available: yes/,
      ],
      report: {
        sessionId: "sess-e2e-1",
        unitLabel: "chars",
        optimizedTurns: 1,
      },
      visual: {
        header: "LightMem2 visual:",
        sessionId: "sess-e2e-1",
        requiredPatterns: [
          /host=claude-code/,
          /session=sess-e2e-1/,
          /Claude Code: 1 session snapshots/,
        ],
      },
    });

    const sessions = await readVisualSessionList(stateDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "sess-e2e-1");
    assert.equal(sessions[0]?.stabilityCount, 1);
    assert.ok((sessions[0]?.reductionCount ?? 0) > 0);

    const visual = await readVisualSessionData(stateDir, "sess-e2e-1");
    assert.equal(visual.stability.length, 1);
    assert.ok(visual.reduction.length > 0);
    assert.match(visual.stability[0]?.developerCanonical ?? "", /<WORKDIR>/);
    assert.match(visual.stability[0]?.dynamicContextText ?? "", /WORKDIR: \/repo\/demo/);

    await runtime?.close();
  });
});

test("Claude Code CLI report and visual return clear empty-state messages before any runtime data exists", async () => {
  await withTempHome("lightmem2-claude-cli-empty-state-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();

    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
      }),
      configPath,
    );

    const { handleCommand } = createClaudeCodeCliBridge({ host: "claude-code" });

    const report = await handleCommand({ args: "report" });
    assert.equal(report.text, "No TokenPilot session stats yet.");

    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /LightMem2 visual: http:\/\/127\.0\.0\.1:/);
    assert.match(visual.text, /host=claude-code/);
  });
});

test("Claude Code cold and warm requests expose prompt cache hit usage when stable prefix stays fixed", async () => {
  await withTempHome("lightmem2-claude-cache-warm-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();
    const upstream = await startMockCachingJsonUpstream({
      path: "/anthropic/v1/messages",
      responseFactory(request, index) {
        const usage = upstream.requestUsages[index] ?? {
          input_tokens: 64,
          output_tokens: 6,
          cache_read_input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
        };
        return {
          id: `msg_cache_${index + 1}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${index + 1}` }],
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            input_tokens_details: usage.input_tokens_details,
          },
          prompt_cache_key: typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined,
          stop_reason: "end_turn",
        };
      },
    });

    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
        upstreamBaseUrl: `${upstream.baseUrl.replace(/\/v1$/, "")}/anthropic`,
        ux: {
          details: true,
        } as any,
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
      configPath,
    );

    const config = await loadTokenPilotClaudeCodeConfig(configPath);
    const runtime = await startClaudeCodeGatewayRuntime({
      config,
      logger: createConsoleLogger(false),
    });

    try {
      const requestBody = {
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "say hi" }],
          },
        ],
        max_tokens: 256,
      };

      const responseA = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-warm-1",
        },
        body: JSON.stringify(requestBody),
      });
      const responseB = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-warm-1",
        },
        body: JSON.stringify(requestBody),
      });

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);

      const bodyA = await responseA.json() as Record<string, unknown>;
      const bodyB = await responseB.json() as Record<string, unknown>;
      assert.equal(typeof upstream.requests[0]?.prompt_cache_key, "string");
      assert.equal(upstream.requests[0]?.prompt_cache_key, upstream.requests[1]?.prompt_cache_key);
      assertColdWarmCacheUsage([bodyA.usage, bodyB.usage]);

      const sessions = await readVisualSessionList(stateDir);
      const targetSession = sessions.find((entry) => Number(entry.cacheAuditSummary?.warmHits ?? 0) > 0);
      assert.equal(targetSession?.sessionId, "sess-claude-warm-1");
      assert.equal(targetSession?.cacheAuditSummary?.warmCandidates, 1);
      assert.equal(targetSession?.cacheAuditSummary?.warmHits, 1);
      assert.equal(targetSession?.cacheAuditSummary?.warmMisses, 0);

      const visual = await readVisualSessionData(stateDir, "sess-claude-warm-1");
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

test("Claude Code rewrites different inbound prompt_cache_key values to the same stable upstream key", async () => {
  await withTempHome("lightmem2-claude-force-key-rewrite-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();
    const upstream = await startMockCachingJsonUpstream({
      path: "/anthropic/v1/messages",
      responseFactory(request, index) {
        return {
          id: `msg_force_key_${index + 1}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${index + 1}` }],
          usage: {
            input_tokens: 64,
            output_tokens: 6,
            cache_read_input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
          },
          prompt_cache_key: typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined,
          stop_reason: "end_turn",
        };
      },
    });

    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
        upstreamBaseUrl: `${upstream.baseUrl.replace(/\/v1$/, "")}/anthropic`,
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
      configPath,
    );

    const config = await loadTokenPilotClaudeCodeConfig(configPath);
    const runtime = await startClaudeCodeGatewayRuntime({
      config,
      logger: createConsoleLogger(false),
    });

    try {
      const makeBody = (promptCacheKey: string) => JSON.stringify({
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        prompt_cache_key: promptCacheKey,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "say hi" }],
          },
        ],
        max_tokens: 256,
      });

      const responseA = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-force-key-1",
        },
        body: makeBody("legacy-key-a"),
      });
      const responseB = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-force-key-1",
        },
        body: makeBody("legacy-key-b"),
      });

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);
      assert.equal(typeof upstream.requests[0]?.prompt_cache_key, "string");
      assert.equal(upstream.requests[0]?.prompt_cache_key, upstream.requests[1]?.prompt_cache_key);
      assert.notEqual(upstream.requests[0]?.prompt_cache_key, "legacy-key-a");
      assert.notEqual(upstream.requests[1]?.prompt_cache_key, "legacy-key-b");
    } finally {
      await runtime.close();
      await upstream.close();
    }
  });
});

test("Claude Code cache audit reports cold start when stable prefix changes and rotates the stable request key", async () => {
  await withTempHome("lightmem2-claude-cache-drift-", async (homeDir) => {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(homeDir, ".claude", "tokenpilot-state", "tokenpilot");
    const configPath = defaultTokenPilotClaudeCodeConfigPath();
    const upstream = await startMockCachingJsonUpstream({
      path: "/anthropic/v1/messages",
      responseFactory(request, index) {
        const usage = upstream.requestUsages[index] ?? {
          input_tokens: 64,
          output_tokens: 6,
          cache_read_input_tokens: 0,
          input_tokens_details: { cached_tokens: 0 },
        };
        return {
          id: `msg_drift_${index + 1}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${index + 1}` }],
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            input_tokens_details: usage.input_tokens_details,
          },
          prompt_cache_key: typeof request.prompt_cache_key === "string" ? request.prompt_cache_key : undefined,
          stop_reason: "end_turn",
        };
      },
    });

    await mkdir(join(homeDir, ".claude"), { recursive: true });
    await writeTokenPilotClaudeCodeConfig(
      normalizeTokenPilotClaudeCodeConfig({
        proxyPort,
        stateDir,
        upstreamBaseUrl: `${upstream.baseUrl.replace(/\/v1$/, "")}/anthropic`,
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
      configPath,
    );

    const config = await loadTokenPilotClaudeCodeConfig(configPath);
    const runtime = await startClaudeCodeGatewayRuntime({
      config,
      logger: createConsoleLogger(false),
    });

    try {
      const shared = {
        model: "tokenpilot/claude-sonnet-4-6",
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "say hi" }],
          },
        ],
        max_tokens: 256,
      };

      const requestA = {
        ...shared,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
      };
      const requestB = {
        ...shared,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nBe precise.",
      };
      const requestC = {
        ...shared,
        system: "Your working directory is: /repo/demo\nRuntime: agent=agent-123 |\nUse concise bullets.",
      };

      const responseA = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-drift-1",
        },
        body: JSON.stringify(requestA),
      });
      const responseB = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-drift-1",
        },
        body: JSON.stringify(requestB),
      });
      const responseC = await fetch(`${runtime.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-session-id": "sess-claude-drift-1",
        },
        body: JSON.stringify(requestC),
      });

      assert.equal(responseA.status, 200);
      assert.equal(responseB.status, 200);
      assert.equal(responseC.status, 200);

      const bodyA = await responseA.json() as Record<string, unknown>;
      const bodyB = await responseB.json() as Record<string, unknown>;
      const bodyC = await responseC.json() as Record<string, unknown>;
      assertColdWarmCacheUsage([bodyA.usage, bodyB.usage]);
      assert.equal((bodyC.usage as Record<string, unknown>)?.cache_read_input_tokens ?? 0, 0);

      const visual = await readVisualSessionData(stateDir, "sess-claude-drift-1");
      assert.equal(visual.cacheAuditSummary?.warmCandidates, 1);
      assert.equal(visual.cacheAuditSummary?.warmHits, 1);
      assert.equal(visual.cacheAuditSummary?.warmMisses, 0);
      assert.equal(visual.cacheAuditSummary?.hitRatePercent, 100);

      const diagnosticEntry = visual.recentCacheAudit?.find((entry) => entry.diagnosis.matchedResult === "cold start");
      assert.equal(typeof diagnosticEntry?.stablePrefixFingerprint, "string");
      assert.equal(diagnosticEntry?.cachedInputTokens, 0);
      assert.deepEqual(diagnosticEntry?.driftKeys ?? [], []);
      assert.equal(diagnosticEntry?.diagnosis.matchedResult, "cold start");
      assert.match(diagnosticEntry?.diagnosis.optimizationHint ?? "", /same target warm baseline|adjacent request/i);
    } finally {
      await runtime.close();
      await upstream.close();
    }
  });
});
