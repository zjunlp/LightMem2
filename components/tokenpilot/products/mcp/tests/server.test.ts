import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveContent } from "@tokenpilot/runtime-core";
import {
  handleMcpRequest,
  MEMORY_FAULT_RECOVER_TOOL_NAME,
  resolveMemoryFaultRecover,
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
