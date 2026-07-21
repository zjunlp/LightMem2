import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readCliContextState } from "../../../products/cli/src/context-store.js";
import { installClaudeCodeTokenPilot, resolveClaudeCodeHookCommandForInstall } from "../src/install.js";
import { proxyBaseUrlForPort } from "../src/config.js";

test("installClaudeCodeTokenPilot writes settings, MCP config, and backups existing files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, ".claude.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const cliBinDir = join(dir, "bin");

    await writeFile(settingsPath, `${JSON.stringify({ env: { KEEP_ME: "1" } }, null, 2)}\n`, "utf8");
    await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: { existing: { command: "node" } } }, null, 2)}\n`, "utf8");

    const result = await installClaudeCodeTokenPilot({
      settingsPath,
      mcpConfigPath,
      tokenPilotConfigPath,
      cliBinDir,
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
    assert.deepEqual(result.commandSkillNames, [
      "lightmem2-status",
      "lightmem2-report",
      "lightmem2-doctor",
      "lightmem2-visual",
    ]);
    assert.equal(result.cliBinInstalled, true);
    assert.equal(result.cliBinPath, join(cliBinDir, "lightmem2"));
    assert.equal(result.cliBinDir, cliBinDir);
    assert.equal(result.cliBinDirOnPath, false);
    assert.equal(result.hostCliBinPath, join(cliBinDir, "tokenpilot-claude-code"));
    assert.equal((await lstat(result.cliBinPath)).isSymbolicLink(), true);
    assert.match(await readlink(result.cliBinPath), /products[\/\\]cli[\/\\]dist[\/\\]cli\.js$/);
    assert.equal((await lstat(result.hostCliBinPath!)).isSymbolicLink(), true);
    assert.match(await readlink(result.hostCliBinPath!), /adapters[\/\\]claude-code[\/\\]dist[\/\\]cli\.js$/);
    assert.match(result.expectedHookCommand, /hooks-handler\.(js|ts)/);
    assert.ok(result.expectedMcpArgs.length > 0);
    assert.equal(result.expectedMcpStartupTimeoutSec, 90);
    assert.equal(result.mcpProbe.ok, true);
    assert.equal(result.mcpProbe.degraded, false);
    const cliContext = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(cliContext.configPathsByHost?.["claude-code"]?.tokenPilotConfigPath, tokenPilotConfigPath);
    assert.equal(cliContext.configPathsByHost?.["claude-code"]?.hostConfigPath, settingsPath);
    assert.equal(cliContext.configPathsByHost?.["claude-code"]?.hostAuxConfigPath, mcpConfigPath);

    const skillRaw = await readFile(join(result.commandSkillsDir, "lightmem2-doctor", "SKILL.md"), "utf8");
    assert.match(skillRaw, /lightmem2 claude-code doctor/);
    assert.match(skillRaw, /disable-model-invocation:\s*true/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

test("installClaudeCodeTokenPilot honors custom environment-configured paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-env-paths-"));
  const originalSettingsPath = process.env.CLAUDE_CODE_SETTINGS_PATH;
  const originalMcpConfigPath = process.env.CLAUDE_CODE_MCP_CONFIG_PATH;
  const originalTokenPilotConfigPath = process.env.TOKENPILOT_CLAUDE_CODE_CONFIG;
  process.env.CLAUDE_CODE_SETTINGS_PATH = join(dir, "isolated", "settings.json");
  process.env.CLAUDE_CODE_MCP_CONFIG_PATH = join(dir, "isolated", ".claude.json");
  process.env.TOKENPILOT_CLAUDE_CODE_CONFIG = join(dir, "isolated", "tokenpilot.json");
  try {
    const result = await installClaudeCodeTokenPilot({
      probeMcp: false,
    });
    assert.equal(result.settingsPath, process.env.CLAUDE_CODE_SETTINGS_PATH);
    assert.equal(result.mcpConfigPath, process.env.CLAUDE_CODE_MCP_CONFIG_PATH);
    assert.equal(result.tokenPilotConfigPath, process.env.TOKENPILOT_CLAUDE_CODE_CONFIG);
    assert.equal(result.stateDir, join(dir, "isolated", "tokenpilot-state", "tokenpilot"));
  } finally {
    if (originalSettingsPath === undefined) delete process.env.CLAUDE_CODE_SETTINGS_PATH;
    else process.env.CLAUDE_CODE_SETTINGS_PATH = originalSettingsPath;
    if (originalMcpConfigPath === undefined) delete process.env.CLAUDE_CODE_MCP_CONFIG_PATH;
    else process.env.CLAUDE_CODE_MCP_CONFIG_PATH = originalMcpConfigPath;
    if (originalTokenPilotConfigPath === undefined) delete process.env.TOKENPILOT_CLAUDE_CODE_CONFIG;
    else process.env.TOKENPILOT_CLAUDE_CODE_CONFIG = originalTokenPilotConfigPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("installClaudeCodeTokenPilot preserves custom Claude upstream from settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-custom-upstream-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" } }, null, 2)}\n`,
      "utf8",
    );

    const result = await installClaudeCodeTokenPilot({
      settingsPath,
      mcpConfigPath: join(dir, ".claude.json"),
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, string>;
    };
    assert.equal(settings.env?.ANTHROPIC_BASE_URL, proxyBaseUrlForPort(17668));

    const tokenPilotConfig = JSON.parse(await readFile(tokenPilotConfigPath, "utf8")) as {
      upstreamBaseUrl?: string;
    };
    assert.equal(tokenPilotConfig.upstreamBaseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(result.proxyBaseUrl, proxyBaseUrlForPort(17668));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installClaudeCodeTokenPilot rewrites top-level deepseek model to a Claude-visible model and remembers the upstream model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-root-model-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        model: "deepseek-chat",
        env: {
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    await installClaudeCodeTokenPilot({
      settingsPath,
      mcpConfigPath: join(dir, ".claude.json"),
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      model?: string;
    };
    assert.equal(settings.model, "claude-sonnet-4-6");

    const tokenPilotConfig = JSON.parse(await readFile(tokenPilotConfigPath, "utf8")) as {
      upstreamModel?: string;
      visibleModels?: string[];
    };
    assert.equal(tokenPilotConfig.upstreamModel, "deepseek-chat");
    assert.deepEqual(tokenPilotConfig.visibleModels, ["deepseek-chat"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installClaudeCodeTokenPilot preserves generic Anthropic-compatible model ids for later proxy discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-generic-models-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1m]",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
          CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.7",
        },
      }, null, 2)}\n`,
      "utf8",
    );

    await installClaudeCodeTokenPilot({
      settingsPath,
      mcpConfigPath: join(dir, ".claude.json"),
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, string>;
    };
    assert.equal(settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, "glm-5.2[1m]");
    assert.equal(settings.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "glm-4.7");
    assert.equal(settings.env?.CLAUDE_CODE_SUBAGENT_MODEL, "glm-4.7");

    const tokenPilotConfig = JSON.parse(await readFile(tokenPilotConfigPath, "utf8")) as {
      upstreamBaseUrl?: string;
      upstreamModel?: string;
      visibleModels?: string[];
    };
    assert.equal(tokenPilotConfig.upstreamBaseUrl, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(tokenPilotConfig.upstreamModel, "glm-5.2[1m]");
    assert.deepEqual(tokenPilotConfig.visibleModels, ["glm-5.2[1m]", "glm-4.7"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installClaudeCodeTokenPilot does not override an explicit TokenPilot upstream", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-claude-install-keep-upstream-"));
  try {
    const settingsPath = join(dir, "settings.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      tokenPilotConfigPath,
      `${JSON.stringify({ upstreamBaseUrl: "https://custom.gateway.example/v1/messages" }, null, 2)}\n`,
      "utf8",
    );

    await installClaudeCodeTokenPilot({
      settingsPath,
      mcpConfigPath: join(dir, ".claude.json"),
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const tokenPilotConfig = JSON.parse(await readFile(tokenPilotConfigPath, "utf8")) as {
      upstreamBaseUrl?: string;
    };
    assert.equal(tokenPilotConfig.upstreamBaseUrl, "https://custom.gateway.example/v1/messages");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeHookCommandForInstall finds the adapter root from the bundled CLI tree", async () => {
  const repoRoot = resolve(__dirname, "..", "..", "..", "..", "..");
  const bundledCliModuleDir = join(repoRoot, "components", "tokenpilot", "products", "cli", "dist");
  const originalCwd = process.cwd();
  try {
    process.chdir(dirname(repoRoot));
    const command = resolveClaudeCodeHookCommandForInstall(bundledCliModuleDir);
    assert.match(command, /adapters[\/\\]claude-code[\/\\]dist[\/\\]hooks-handler\.js/);
  } finally {
    process.chdir(originalCwd);
  }
});
