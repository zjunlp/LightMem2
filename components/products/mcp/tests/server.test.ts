import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveContent } from "@lightmem2/artifact-store";
import { LIGHTMEM2_VERSION } from "@lightmem2/kernel";
import {
  encodeMcpMessage,
  handleMcpRequest,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  probeTokenPilotMcpServer,
  resolveTokenPilotMcpPackageRoot,
  resolveTokenPilotMcpProbeServerSpec,
  resolveMemoryFaultRecover,
  resolveTokenPilotMcpServerSpec,
} from "../src/index.js";

test("resolveMemoryFaultRecover restores archived content across sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-mcp-"));
  try {
    await archiveContent({
      sessionId: "session-a",
      segmentId: "segment-1",
      sourcePass: "tool_payload_trim",
      toolName: "web_fetch",
      dataKey: "segment:web-1-output",
      originalText: "recovered payload",
      archiveDir: join(dir, "tokenpilot", "tool-result-archives", "session-a"),
    });

    const result = await resolveMemoryFaultRecover({
      dataKey: "segment:web-1-output",
      stateDir: dir,
    });

    assert.match(result.text, /recovered payload/);
    assert.equal(result.details.recovered, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveMemoryFaultRecover can restore only a requested line window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-mcp-lines-"));
  try {
    await archiveContent({
      sessionId: "session-lines",
      segmentId: "segment-lines",
      sourcePass: "tool_payload_trim",
      toolName: "read",
      dataKey: "segment:code-window",
      originalText: [
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
      ].join("\n"),
      archiveDir: join(dir, "tokenpilot", "tool-result-archives", "session-lines"),
    });

    const result = await resolveMemoryFaultRecover({
      dataKey: "segment:code-window",
      stateDir: dir,
      startLine: 2,
      endLine: 4,
    });

    assert.match(result.text, /Recovered lines: 2-4/);
    assert.doesNotMatch(result.text, /line 1/);
    assert.match(result.text, /line 2/);
    assert.match(result.text, /line 4/);
    assert.doesNotMatch(result.text, /line 5/);
    assert.equal(result.details.recoveredStartLine, 2);
    assert.equal(result.details.recoveredEndLine, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleMcpRequest returns tools/list and tools/call responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-mcp-rpc-"));
  try {
    await archiveContent({
      sessionId: "session-b",
      segmentId: "segment-2",
      sourcePass: "exec_output_truncation",
      toolName: "bash",
      dataKey: "segment:bash-2-output",
      originalText: "stdout lines",
      archiveDir: join(dir, "tokenpilot", "tool-result-archives", "session-b"),
    });

    const list = await handleMcpRequest({ id: 1, method: "tools/list" });
    const tools = Array.isArray(list?.result?.tools) ? list.result.tools : [];
    assert.ok(tools.length > 0);
    assert.match(JSON.stringify(tools[0] ?? {}), /startLine/);

    const call = await handleMcpRequest(
      {
        id: 2,
        method: "tools/call",
        params: {
          name: MEMORY_FAULT_RECOVER_TOOL_NAME,
          arguments: { dataKey: "segment:bash-2-output" },
        },
      },
      { stateDir: dir },
    );

    const content = call?.result?.content as Array<{ type: string; text: string }>;
    assert.match(content[0]?.text ?? "", /stdout lines/);
    assert.equal(call?.result?.isError, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleMcpRequest marks archive miss as tool error", async () => {
  const response = await handleMcpRequest(
    {
      id: 3,
      method: "tools/call",
      params: {
        name: MEMORY_FAULT_RECOVER_TOOL_NAME,
        arguments: { dataKey: "missing-key" },
      },
    },
    { stateDir: join(tmpdir(), "lightmem2-no-such-state") },
  );

  assert.equal(response?.result?.isError, true);
  const content = response?.result?.content as Array<{ type: string; text: string }>;
  assert.match(content[0]?.text ?? "", /No archived content found/);
});

test("probeTokenPilotMcpServer completes initialize handshake", async () => {
  const spec = resolveTokenPilotMcpProbeServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-probe-state"),
    requireBuild: false,
  });
  const result = await probeTokenPilotMcpServer(spec, {
    timeoutMs: 3_000,
    clientName: "mcp-test",
    clientVersion: "0.1.0",
    protocol: "newline_json",
  });

  assert.equal(result.ok, true);
  assert.equal(result.timedOut, false);
  assert.match(result.detail, /initialize succeeded/i);
});

test("install MCP spec always resolves to built runtime entry", () => {
  const spec = resolveTokenPilotMcpServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-install-state"),
  });

  assert.equal(spec.command, process.execPath);
  assert.equal(spec.args.length, 1);
  assert.match(spec.entryPath, /dist[\/\\]server\.js$/);
  assert.deepEqual(spec.args, [spec.entryPath]);
});

test("probe MCP spec can fall back to source entry when dist is unavailable", () => {
  const spec = resolveTokenPilotMcpProbeServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-probe-fallback-state"),
    requireBuild: false,
  });

  assert.equal(spec.command, process.execPath);
  assert.ok(spec.args.length >= 1);
  assert.ok(
    /dist[\/\\]server\.js$/.test(spec.entryPath)
      || /src[\/\\]server\.ts$/.test(spec.entryPath),
  );
  if (/src[\/\\]server\.ts$/.test(spec.entryPath)) {
    assert.deepEqual(spec.args.slice(0, 2), ["--import", "tsx"]);
    assert.equal(spec.args[2], spec.entryPath);
  } else {
    assert.deepEqual(spec.args, [spec.entryPath]);
  }
});

test("MCP package root resolver does not confuse bundled CLI dist with the MCP package", () => {
  const packageRoot = resolveTokenPilotMcpPackageRoot({
    moduleDir: join(
      process.cwd(),
      "components",
      "tokenpilot",
      "products",
      "cli",
      "dist",
    ),
    cwd: process.cwd(),
  });

  assert.match(packageRoot, /components[\/\\]products[\/\\]mcp$/);
});

test("MCP package root resolver honors explicit override", () => {
  const override = join(process.cwd(), "components", "tokenpilot", "products", "mcp");
  const packageRoot = resolveTokenPilotMcpPackageRoot({
    override,
  });

  assert.equal(packageRoot, override);
});

function tryExtractContentLengthBody(stdout: string): string | null {
  const boundary = stdout.indexOf("\r\n\r\n");
  if (boundary < 0) return null;
  const header = stdout.slice(0, boundary);
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  if (!match) return null;
  const contentLength = Number(match[1]);
  const body = stdout.slice(boundary + 4);
  if (Buffer.byteLength(body, "utf8") < contentLength) return null;
  return body.slice(0, contentLength);
}

test("MCP server responds to newline-delimited JSON-RPC stdio", async () => {
  const spec = resolveTokenPilotMcpProbeServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-newline-state"),
    requireBuild: false,
  });
  const child = spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...spec.env,
    },
  });

  try {
    const response = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => {
        reject(new Error("newline MCP response timeout"));
      }, 3_000);
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          resolve(stdout);
        }
      });
      child.once("error", reject);
      child.stdin.write(encodeMcpMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "newline-test", version: "0.1.0" },
        },
      }, "newline_json"));
    });

    const firstLine = response.trim().split("\n")[0] ?? "";
    const parsed = JSON.parse(firstLine) as { result?: { serverInfo?: { name?: string; version?: string } } };
    assert.equal(parsed.result?.serverInfo?.name, "tokenpilot-memory-fault-recover");
    assert.equal(parsed.result?.serverInfo?.version, LIGHTMEM2_VERSION);
  } finally {
    child.kill();
  }
});

test("MCP server remains compatible with content-length framing", async () => {
  const spec = resolveTokenPilotMcpProbeServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-content-length-state"),
    requireBuild: false,
  });
  const child = spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...spec.env,
    },
  });

  try {
    const response = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const timer = setTimeout(() => {
        reject(new Error("content-length MCP response timeout"));
      }, 3_000);
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (tryExtractContentLengthBody(stdout)) {
          clearTimeout(timer);
          resolve(stdout);
        }
      });
      child.once("error", reject);
      child.stdin.write(encodeMcpMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "content-length-test", version: "0.1.0" },
        },
      }, "content_length"));
    });

    assert.match(response, /Content-Length:/);
    const body = tryExtractContentLengthBody(response);
    assert.ok(body);
    assert.match(body, /tokenpilot-memory-fault-recover/);
  } finally {
    child.kill();
  }
});
