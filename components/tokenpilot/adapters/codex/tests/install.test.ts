import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { loadTokenPilotCodexConfig } from "../src/config.js";
import { installCodexTokenPilot } from "../src/install.js";

test("installCodexTokenPilot writes provider, MCP, and hooks with expected commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, /model_provider = "OPENAI"/);
    assert.match(codexToml, /\[model_providers\.tokenpilot\]/);
    assert.match(codexToml, /\[model_providers\.OPENAI\]/);
    assert.match(codexToml, /base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
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
    assert.equal(result.activeProviderName, "OPENAI");
    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.upstreamProvider, "OPENAI");
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "https://api.openai.com/v1");

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

test("installCodexTokenPilot retags old tokenpilot threads back to the active provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-retag-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const dbPath = join(dir, "state_5.sqlite");

    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OpenAI\"",
      "base_url = \"https://api.openai.com/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await mkdir(dir, { recursive: true });

    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
      db.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("a", "tokenpilot");
      db.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("b", "OPENAI");
    } finally {
      db.close();
    }

    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    const verifyDb = new DatabaseSync(dbPath);
    try {
      const tokenpilotCount = Number(
        verifyDb.prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?").get("tokenpilot")?.count ?? 0,
      );
      const openaiCount = Number(
        verifyDb.prepare("SELECT COUNT(*) AS count FROM threads WHERE model_provider = ?").get("OPENAI")?.count ?? 0,
      );
      assert.equal(tokenpilotCount, 0);
      assert.equal(openaiCount, 2);
    } finally {
      verifyDb.close();
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
