import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { formatCodexDoctorReport, inspectCodexDoctor } from "../src/doctor.js";

async function reserveUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

test("inspectCodexDoctor reports missing provider and hooks honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"OpenAI\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, false);
    assert.equal(report.hooksInstalled, false);
    assert.equal(report.hooksComplete, false);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, []);
    assert.deepEqual(report.missingHookEvents, ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]);
    assert.equal(report.daemonRunning, false);
    assert.equal(report.mcpInstalled, false);
    assert.equal(report.mcpStateDirMatches, false);
    assert.equal(report.mcpCommandMatches, false);
    assert.equal(report.mcpArgsMatch, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor checks the configured provider name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-provider-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"tp-custom\"",
      "",
      "[model_providers.tp-custom]",
      "name = \"TokenPilot Custom\"",
      "base_url = \"http://127.0.0.1:17667/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
        providerName: "tp-custom",
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, true);
    assert.equal(report.providerActive, true);
    assert.equal(report.hooksInstalled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor detects installed recovery MCP entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-mcp-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"tokenpilot\"",
      "",
      "[model_providers.tokenpilot]",
      "name = \"TokenPilot\"",
      "base_url = \"http://127.0.0.1:17667/v1\"",
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover]",
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify("/tmp/server.js")}]`,
      "startup_timeout_sec = 90",
      "",
      "[mcp_servers.tokenpilot_memory_fault_recover.env]",
      `TOKENPILOT_STATE_DIR = ${JSON.stringify(join(dir, "state"))}`,
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, true);
    assert.equal(report.mcpInstalled, true);
    assert.equal(report.mcpStateDirMatches, true);
    assert.equal(report.mcpCommandMatches, true);
    assert.equal(report.mcpArgsMatch, false);
    assert.equal(report.mcpStartupTimeoutSecMatches, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor treats a non-tokenpilot active provider as healthy when it is routed through the local proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-intercepted-root-"));
  const proxyPort = await reserveUnusedPort();
  const server = createHttpServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, adapter: "tokenpilot-codex" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(proxyPort, "127.0.0.1", () => resolve());
    });

    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");
    await writeFile(codexConfigPath, [
      "model_provider = \"OPENAI\"",
      "",
      "[model_providers.OPENAI]",
      `name = ${JSON.stringify("OPENAI")}`,
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
        providerName: "OPENAI",
        upstreamProvider: "OPENAI",
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.providerInstalled, true);
    assert.equal(report.providerActive, true);
    assert.equal(report.providerIntercepted, true);
    assert.equal(report.proxyHealthy, true);
    assert.equal(report.coreRuntimeHealthy, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor reports partial hook installs explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-hooks-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"tokenpilot\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: `${process.execPath} /tmp/tokenpilot/hooks-handler.js` }] }],
      },
    }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, false);
    assert.equal(report.hooksMatchExpectedCommand, false);
    assert.deepEqual(report.installedHookEvents, ["SessionStart", "PostToolUse"]);
    assert.deepEqual(report.missingHookEvents, ["PreToolUse", "Stop"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor accepts Windows hook wrapper commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-hooks-win-"));
  try {
    const proxyPort = await reserveUnusedPort();
    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, "model_provider = \"tokenpilot\"\n", "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "D:\\LightMem2\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "D:\\LightMem2\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
        PostToolUse: [{ hooks: [{ type: "command", command: "D:\\LightMem2\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
        Stop: [{ hooks: [{ type: "command", command: "D:\\LightMem2\\codex\\dist\\tokenpilot-codex-hook.cmd" }] }],
      },
    }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.hooksInstalled, true);
    assert.equal(report.hooksComplete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectCodexDoctor rejects a healthy response from a different adapter on the same port", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-doctor-wrong-adapter-"));
  const proxyPort = await reserveUnusedPort();
  const server = createHttpServer((req, res) => {
    if (req.url === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, adapter: "tokenpilot-openclaw" }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(proxyPort, "127.0.0.1", () => resolve());
    });

    const codexConfigPath = join(dir, "config.toml");
    const hooksConfigPath = join(dir, "hooks.json");
    const tokenPilotConfigPath = join(dir, "tokenpilot.json");

    await writeFile(codexConfigPath, [
      "model_provider = \"tokenpilot\"",
      "",
      "[model_providers.tokenpilot]",
      `base_url = ${JSON.stringify(`http://127.0.0.1:${proxyPort}/v1`)}`,
      "wire_api = \"responses\"",
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    await writeFile(hooksConfigPath, JSON.stringify({ hooks: {} }, null, 2), "utf8");
    await mkdir(join(dir, "state"), { recursive: true });

    const report = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({
        stateDir: join(dir, "state"),
        proxyPort,
      }),
      configPath: codexConfigPath,
      hooksConfigPath,
      tokenPilotConfigPath,
    });

    assert.equal(report.proxyHealthy, false);
    assert.equal(report.coreRuntimeHealthy, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatCodexDoctorReport includes remediation hints for drifted installs", async () => {
  const proxyPort = await reserveUnusedPort();
  const report = await inspectCodexDoctor({
    config: normalizeTokenPilotCodexConfig({
      stateDir: join(tmpdir(), "lightmem2-codex-doctor-remediation-state"),
      proxyPort,
    }),
    configPath: join(tmpdir(), "lightmem2-missing-codex-config.toml"),
    hooksConfigPath: join(tmpdir(), "lightmem2-missing-codex-hooks.json"),
    tokenPilotConfigPath: join(tmpdir(), "lightmem2-missing-codex-tokenpilot.json"),
  });
  const text = formatCodexDoctorReport(report);
  assert.match(text, /Suggested fixes:/);
  assert.match(text, /rerun the Codex install command/i);
});

test("formatCodexDoctorReport shows degraded mode when core runtime is healthy but MCP recovery drifted", () => {
  const text = formatCodexDoctorReport({
    configPath: "/tmp/config.toml",
    hooksConfigPath: "/tmp/hooks.json",
    tokenPilotConfigPath: "/tmp/tokenpilot.json",
    proxyBaseUrl: "http://127.0.0.1:17667/v1",
    expectedHookCommand: "node hooks-handler.js",
    expectedMcpCommand: process.execPath,
    expectedMcpArgs: ["/tmp/server.js"],
    expectedMcpStartupTimeoutSec: 90,
    providerInstalled: true,
    providerActive: true,
    hooksInstalled: true,
    hooksComplete: true,
    hooksMatchExpectedCommand: true,
    installedHookEvents: ["SessionStart", "PreToolUse", "PostToolUse", "Stop"],
    missingHookEvents: [],
    daemonRunning: true,
    proxyHealthy: true,
    stateDir: "/tmp/state",
    upstreamProvider: "OpenAI",
    mcpInstalled: true,
    mcpStateDirMatches: true,
    mcpCommandMatches: true,
    mcpArgsMatch: true,
    mcpStartupTimeoutSecMatches: false,
    coreRuntimeHealthy: true,
    recoveryMcpHealthy: false,
    degradedMode: true,
  });

  assert.match(text, /core runtime healthy: yes/);
  assert.match(text, /recovery MCP healthy: no/);
  assert.match(text, /degraded mode: yes/);
  assert.match(text, /stable-prefix rewriting and reduction remain available/);
  assert.match(text, /startup_timeout_sec/);
});
