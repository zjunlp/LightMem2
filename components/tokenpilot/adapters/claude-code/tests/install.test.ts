import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installClaudeCodeTokenPilot } from "../src/install.js";

test("installClaudeCodeTokenPilot writes settings, MCP config, and backups existing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(settingsPath, `${JSON.stringify({ env: { KEEP_ME: "1" } }, null, 2)}\n`, "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: { existing: { command: "node" } } }, null, 2)}\n`, "utf8");

    const result = await installClaudeCodeTokenPilot({
      settingsPath,
      mcpConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(result.settingsBackedUp, true);
    assert.equal(result.mcpConfigBackedUp, true);

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, string>;
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    assert.equal(typeof settings.env?.ANTHROPIC_BASE_URL, "string");
    assert.equal(settings.env?.ENABLE_TOOL_SEARCH, "true");
    assert.equal(settings.env?.KEEP_ME, "1");
    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
      const entries = settings.hooks?.[eventName]?.[0]?.hooks;
      assert.ok(Array.isArray(entries), `${eventName} hook group missing`);
      assert.equal(String(entries[0]?.command ?? ""), result.expectedHookCommand);
    }

    const mcp = JSON.parse(await readFile(mcpConfigPath, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; startup_timeout_sec?: number }>;
    };
    assert.equal(typeof mcp.mcpServers?.tokenpilot_memory_fault_recover?.command, "string");
    assert.equal(
      mcp.mcpServers?.tokenpilot_memory_fault_recover?.env?.TOKENPILOT_STATE_DIR,
      result.stateDir,
    );
    assert.equal(mcp.mcpServers?.tokenpilot_memory_fault_recover?.command, result.expectedMcpCommand);
    assert.equal(result.expectedMcpArgs.length, 1);
    assert.match(result.expectedMcpArgs[0] ?? "", /dist[\/\\]server\.js$/);
    assert.deepEqual(mcp.mcpServers?.tokenpilot_memory_fault_recover?.args ?? [], result.expectedMcpArgs);
    assert.equal(mcp.mcpServers?.tokenpilot_memory_fault_recover?.startup_timeout_sec, 90);
    assert.equal(typeof mcp.mcpServers?.existing?.command, "string");
    assert.equal(result.hooksInstalled, true);
    assert.match(result.expectedHookCommand, /hooks-handler\.(js|ts)/);
    assert.ok(result.expectedMcpArgs.length > 0);
    assert.equal(result.expectedMcpStartupTimeoutSec, 90);
    assert.equal(result.mcpProbe.ok, true);
    assert.equal(result.mcpProbe.degraded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installClaudeCodeTokenPilot reports degraded MCP mode when probe is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-skip-probe-"));
  try {
    const result = await installClaudeCodeTokenPilot({
      settingsPath: join(dir, "settings.json"),
      mcpConfigPath: join(dir, ".claude.json"),
      tokenPilotConfigPath: join(dir, "tokenpilot.json"),
      probeMcp: false,
    });

    assert.equal(result.mcpProbe.ok, false);
    assert.equal(result.mcpProbe.degraded, true);
    assert.match(result.mcpProbe.detail, /skipped/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
