import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { readCliContextState } from "../../../products/cli/src/context-store.js";
import {
  loadTokenPilotCodexConfig,
  normalizeTokenPilotCodexConfig,
  writeTokenPilotCodexConfig,
} from "../src/config.js";
import { daemonPaths, readDaemonStatus } from "../src/daemon.js";
import { inspectCodexDoctor } from "../src/doctor.js";
import {
  installCodexTokenPilot as installCodexTokenPilotBase,
  resolveCodexHookCommandForInstall,
} from "../src/install.js";

function installCodexTokenPilot(
  params: NonNullable<Parameters<typeof installCodexTokenPilotBase>[0]>,
) {
  return installCodexTokenPilotBase({
    ...params,
    cliContextPath: join(
      dirname(params.codexConfigPath ?? params.tokenPilotConfigPath ?? tmpdir()),
      ".lightmem2",
      "state",
      "cli-context.json",
    ),
  });
}

test("installCodexTokenPilot writes provider, MCP, and hooks with expected commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const cliBinDir = join(dir, "bin");
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
    await writeFile(tokenPilotConfigPath, JSON.stringify({ enabled: false }, null, 2), "utf8");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      cliBinDir,
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
    assert.equal(result.cliBinInstalled, true);
    assert.equal(result.cliBinPath, join(cliBinDir, "lightmem2"));
    assert.equal(result.cliBinDir, cliBinDir);
    assert.equal(result.cliBinDirOnPath, false);
    assert.equal(result.hostCliBinPath, join(cliBinDir, "tokenpilot-codex"));
    assert.equal((await lstat(result.cliBinPath)).isSymbolicLink(), true);
    assert.match(await readlink(result.cliBinPath), /products[\/\\]cli[\/\\]dist[\/\\]cli\.js$/);
    assert.equal((await lstat(result.hostCliBinPath!)).isSymbolicLink(), true);
    assert.match(await readlink(result.hostCliBinPath!), /adapters[\/\\]codex[\/\\]dist[\/\\]cli\.js$/);
    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.enabled, true);
    assert.equal(tokenPilotConfig.upstreamProvider, "OPENAI");
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "https://api.openai.com/v1");
    const cliContext = await readCliContextState(join(dir, ".lightmem2", "state", "cli-context.json"));
    assert.equal(cliContext.configPathsByHost?.codex?.tokenPilotConfigPath, tokenPilotConfigPath);
    assert.equal(cliContext.configPathsByHost?.codex?.hostConfigPath, codexConfigPath);
    assert.equal(cliContext.configPathsByHost?.codex?.hostAuxConfigPath, hooksConfigPath);

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
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

test("installCodexTokenPilot restores execute permission on the shared lightmem2 CLI target", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-cli-perm-"));
  const cliDistPath = resolve(__dirname, "..", "..", "..", "products", "cli", "dist", "cli.js");
  const originalMode = (await stat(cliDistPath)).mode & 0o777;
  try {
    await chmod(cliDistPath, 0o644);
    const result = await installCodexTokenPilot({
      codexConfigPath: join(dir, "config.toml"),
      hooksConfigPath: join(dir, "hooks.json"),
      tokenPilotConfigPath: join(dir, "tokenpilot.json"),
      cliBinDir: join(dir, "bin"),
      probeMcp: false,
    });

    assert.equal(result.cliBinInstalled, true);
    assert.equal(((await stat(cliDistPath)).mode & 0o111) !== 0, true);
  } finally {
    await chmod(cliDistPath, originalMode).catch(() => undefined);
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

test("installCodexTokenPilot preserves the last real upstream when the current provider already points at an older local proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-loopback-upstream-"));
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeTokenPilotCodexConfig(
      normalizeTokenPilotCodexConfig({
        proxyPort: 17668,
        providerName: "OPENAI",
        upstreamProvider: "OPENAI",
        upstream: {
          name: "OPENAI",
          baseUrl: "http://47.88.93.22:10001",
          wireApi: "responses",
          requiresOpenAIAuth: true,
        },
      }),
      tokenPilotConfigPath,
    );

    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      "name = \"OPENAI\"",
      "base_url = \"http://127.0.0.1:17667/v1\"",
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

    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.upstream?.baseUrl, "http://47.88.93.22:10001");
    assert.equal(result.providerName, "OPENAI");

    const codexToml = await readFile(codexConfigPath, "utf8");
    assert.match(codexToml, new RegExp(`base_url = "http://127\\.0\\.0\\.1:${tokenPilotConfig.proxyPort}/v1"`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installCodexTokenPilot does not treat a fresh default install as an upstream loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-fresh-upstream-"));
  const originalHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    const result = await installCodexTokenPilot({
      codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
      probeMcp: false,
    });

    const tokenPilotConfig = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(tokenPilotConfig.upstream?.baseUrl, undefined);
    assert.equal(tokenPilotConfig.upstreamProvider, "OpenAI");
    const report = await inspectCodexDoctor({
      config: tokenPilotConfig,
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });
    assert.equal(report.upstreamLoopDetected, false);
    assert.equal(report.upstreamBaseUrl, undefined);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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

test("installCodexTokenPilot stops an existing daemon before resolving the proxy port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-install-stop-daemon-"));
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    const stateDir = join(dir, "state");
    const config = normalizeTokenPilotCodexConfig({
      proxyPort: 17680,
      stateDir,
    });
    await writeTokenPilotCodexConfig(config, tokenPilotConfigPath);
    const { pidPath } = daemonPaths(config);
    await mkdir(dirname(pidPath), { recursive: true });

    dummy = spawn(process.execPath, [
      "-e",
      [
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/health') {",
        "    res.writeHead(200, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ ok: true, adapter: 'tokenpilot-codex' }));",
        "    return;",
        "  }",
        "  res.writeHead(404);",
        "  res.end('not found');",
        "});",
        "server.listen(17680, '127.0.0.1');",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ], {
      stdio: "ignore",
    });
    await writeFile(pidPath, `${dummy.pid}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
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

    const persisted = await loadTokenPilotCodexConfig(tokenPilotConfigPath);
    assert.equal(persisted.proxyPort, 17680);
    assert.equal(result.baseUrl, "http://127.0.0.1:17680/v1");
    assert.equal((await readDaemonStatus(persisted)).running, false);
  } finally {
    if (dummy?.pid) {
      try {
        process.kill(dummy.pid, "SIGKILL");
      } catch {
        // The installer is expected to stop this process.
      }
    }
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
