import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { createConsoleLogger } from "../src/logger.js";
import { startCodexResponsesProxy } from "../src/proxy-runtime.js";

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

test("Codex host e2e wires install, proxy reduction, report/visual, and MCP recovery together", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "lightmem2-codex-e2e-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  const proxyPort = await reserveUnusedPort();
  const stateDir = join(homeDir, ".codex", "tokenpilot-state", "tokenpilot");
  const codexConfigPath = defaultCodexConfigPath();
  const hooksConfigPath = defaultHooksConfigPath();
  const tokenPilotConfigPath = defaultTokenPilotConfigPath();
  const seenRequests: Array<Record<string, unknown>> = [];
  const longToolPayload = `payload\n${"line\n".repeat(900)}`;
  let upstreamServer: ReturnType<typeof createHttpServer> | undefined;
  let runtime: Awaited<ReturnType<typeof startCodexResponsesProxy>> | undefined;

  try {
    const upstreamPort = await reserveUnusedPort();
    upstreamServer = createHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      try {
        seenRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        // ignore malformed body in test harness
      }

      const payload = JSON.stringify({
        id: "resp_e2e_1",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(payload);
    });
    await new Promise<void>((resolve, reject) => {
      upstreamServer?.once("error", reject);
      upstreamServer?.listen(upstreamPort, "127.0.0.1", () => {
        upstreamServer?.off("error", reject);
        resolve();
      });
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
      `base_url = ${JSON.stringify(`http://127.0.0.1:${upstreamPort}/v1`)}`,
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
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0]?.model, "gpt-5.4-mini");
    assert.match(String(seenRequests[0]?.instructions ?? ""), /Your working directory is: \/repo\/demo/);
    assert.match(String(seenRequests[0]?.instructions ?? ""), /Runtime: agent=agent-123 \|/);
    assert.match(String(seenRequests[0]?.instructions ?? ""), /\[Recovery Protocol\]/);

    const forwardedInput = seenRequests[0]?.input as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(forwardedInput));
    const firstUser = forwardedInput[0];
    const firstBlocks = firstUser?.content as Array<Record<string, unknown>>;

    const reducedToolItem = forwardedInput[1];
    const reducedOutput = String(reducedToolItem?.output ?? "");
    assert.match(reducedOutput, /\[Tool payload trimmed\]|\[Exec output truncated\]/);
    const dataKeyMatch = reducedOutput.match(/memory_fault_recover with \{"dataKey":"([^"]+)"\}/);
    assert.ok(dataKeyMatch);

    const recovery = await handleMcpRequest(
      {
        id: 1,
        method: "tools/call",
        params: {
          name: MEMORY_FAULT_RECOVER_TOOL_NAME,
          arguments: {
            dataKey: dataKeyMatch?.[1] ?? "",
          },
        },
      },
      { stateDir },
    );
    const recoveryContent = recovery?.result?.content as Array<{ type: string; text: string }>;
    assert.equal(recovery?.result?.isError, false);
    assert.match(recoveryContent[0]?.text ?? "", /Recovered content for:/);
    assert.match(recoveryContent[0]?.text ?? "", /payload/);
    assert.match(recoveryContent[0]?.text ?? "", /line/);

    const { handleCommand } = createCodexCliBridge({ host: "codex" });

    const doctor = await handleCommand({ args: "doctor" });
    assert.match(doctor.text, /TokenPilot Codex doctor:/);
    assert.match(doctor.text, /provider installed: yes/);
    assert.match(doctor.text, /recovery MCP installed: yes/);
    assert.match(doctor.text, /hooks installed: yes/);
    assert.match(doctor.text, /proxy healthy: yes/);

    const report = await handleCommand({ args: "report" });
    assert.match(report.text, /TokenPilot report:/);
    assert.match(report.text, /saved chars:/);

    const visual = await handleCommand({ args: "visual" });
    assert.match(visual.text, /TokenPilot Codex visual:/);
    assert.match(visual.text, /model: gpt-5.4-mini/);
    assert.match(visual.text, /response chain: resp_e2e_1/);
  } finally {
    await runtime?.close();
    await new Promise<void>((resolve) => upstreamServer?.close(() => resolve()));
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});
