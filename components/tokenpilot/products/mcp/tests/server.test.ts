import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveContent } from "@tokenpilot/runtime-core";
import {
  encodeMcpMessage,
  handleMcpRequest,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  probeTokenPilotMcpServer,
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
    assert.equal(list?.result?.tools instanceof Array, true);

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
  const spec = resolveTokenPilotMcpServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-probe-state"),
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
  const spec = resolveTokenPilotMcpServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-newline-state"),
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
    const parsed = JSON.parse(firstLine) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(parsed.result?.serverInfo?.name, "tokenpilot-memory-fault-recover");
  } finally {
    child.kill();
  }
});

test("MCP server remains compatible with content-length framing", async () => {
  const spec = resolveTokenPilotMcpServerSpec({
    stateDir: join(tmpdir(), "lightmem2-mcp-content-length-state"),
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
