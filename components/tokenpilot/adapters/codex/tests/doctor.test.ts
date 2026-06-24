import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";

import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { inspectCodexDoctor } from "../src/doctor.js";

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
    assert.equal(report.daemonRunning, false);
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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
