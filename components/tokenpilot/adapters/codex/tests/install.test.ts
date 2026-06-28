import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installCodexTokenPilot } from "../src/install.js";

test("installCodexTokenPilot writes provider, MCP, and hooks with expected commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, /\[model_providers\.tokenpilot\]/);
    assert.match(codexToml, /\[mcp_servers\.tokenpilot_memory_fault_recover\]/);
    assert.match(codexToml, /startup_timeout_sec\s*=\s*90/);
    assert.match(codexToml, new RegExp(result.expectedMcpCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(result.expectedMcpArgs.length, 1);
    assert.match(result.expectedMcpArgs[0] ?? "", /dist[\/\\]server\.js$/);
    for (const arg of result.expectedMcpArgs) {
      assert.match(codexToml, new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.equal(result.expectedMcpStartupTimeoutSec, 90);
    assert.equal(result.mcpProbe.ok, true);
    assert.equal(result.mcpProbe.degraded, false);

    const hooks = JSON.parse(await readFile(hooksConfigPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
      const entries = hooks.hooks?.[eventName]?.[0]?.hooks;
      assert.ok(Array.isArray(entries), `${eventName} hook group missing`);
      assert.equal(String(entries[0]?.command ?? ""), result.expectedHookCommand);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot reports degraded MCP mode when probe is skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-skip-probe-"));
  try {
    const result = await installCodexTokenPilot({
      codexConfigPath: join(dir, "config.toml"),
      hooksConfigPath: join(dir, "hooks.json"),
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
