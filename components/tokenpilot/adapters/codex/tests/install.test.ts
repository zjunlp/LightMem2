import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import {
  loadTokenPilotCodexConfig,
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../src/config.js";
import { installCodexTokenPilot, resolveCodexHookCommandForInstall } from "../src/install.js";

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
    assert.match(codexToml, /\[model_providers\.OPENAI\]/);
    assert.match(codexToml, /\[model_providers\.OPENAI\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.doesNotMatch(codexToml, /\[model_providers\.tokenpilot\]/);
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
    assert.equal(result.providerName, "OPENAI");
    assert.deepEqual(result.commandSkillNames, [
      "lightmem2-status",
      "lightmem2-report",
      "lightmem2-doctor",
      "lightmem2-visual",
    ]);
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

    const skillRaw = await readFile(join(result.commandSkillsDir, "lightmem2-report", "SKILL.md"), "utf8");
    assert.match(skillRaw, /lightmem2 codex report/);
    assert.match(skillRaw, /node/);
    const policyRaw = await readFile(join(result.commandSkillsDir, "lightmem2-report", "agents", "openai.yaml"), "utf8");
    assert.match(policyRaw, /allow_implicit_invocation:\s*false/);
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

test("installCodexTokenPilot preserves an existing custom root provider and reroutes that provider to the proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-custom-root-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENROUTER\"",
      "",
      "[model_providers.OPENROUTER]",
      "name = \"OpenRouter\"",
      "base_url = \"https://openrouter.ai/api/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, /model_provider = "OPENROUTER"/);
    assert.match(codexToml, /\[model_providers\.OPENROUTER\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
    assert.equal(result.providerName, "OPENROUTER");
    assert.equal(result.activeProviderName, "OPENROUTER");

    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.providerName, "OPENROUTER");
    assert.equal(tokenPilotConfig.upstreamProvider, "OPENROUTER");
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "https://openrouter.ai/api/v1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot writes Windows hook wrappers into hooks.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-win-hook-"));
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
      platform: "win32",
    });

    assert.match(result.expectedHookCommand, /tokenpilot-codex-hook\.cmd"$/);

    const hooks = JSON.parse(await readFile(hooksConfigPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) {
      const entries = hooks.hooks?.[eventName]?.[0]?.hooks;
      assert.ok(Array.isArray(entries), `${eventName} hook group missing`);
      assert.match(String(entries[0]?.command ?? ""), /tokenpilot-codex-hook\.cmd"$/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot rewrites the MCP server block idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-mcp-idempotent-"));
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

    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });
    await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    const codexToml = await readFile(codexConfigPath, "utf8");
    const envHeaders = codexToml.match(/\[mcp_servers\.tokenpilot_memory_fault_recover\.env\]/g) ?? [];
    assert.equal(envHeaders.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot shifts the proxy port when the preferred port is already occupied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-port-shift-"));
  const blocker = await new Promise<{ server: import("node:net").Server; port: number }>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to reserve blocker port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        proxyPort: blocker.port,
      }),
      tokenPilotConfigPath,
    );
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
      probeMcp: false,
    });

    const config = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.notEqual(config.proxyPort, blocker.port);
    assert.equal(result.baseUrl, `http://127.0.0.1:${config.proxyPort}/v1`);
  } finally {
    await new Promise<void>((resolve) => blocker.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCodexHookCommandForInstall finds the adapter root from the bundled CLI tree", async () => {
  const repoRoot = resolve(__dirname, "..", "..", "..", "..", "..");
  const bundledCliModuleDir = join(repoRoot, "components", "tokenpilot", "products", "cli", "dist");
  const originalCwd = process.cwd();
  try {
    process.chdir(dirname(repoRoot));
    const command = await resolveCodexHookCommandForInstall(process.platform, bundledCliModuleDir);
    assert.match(command, /adapters[\/\\]codex[\/\\]dist[\/\\](hooks-handler\.js|tokenpilot-codex-hook\.cmd)/);
  } finally {
    process.chdir(originalCwd);
  }
});
