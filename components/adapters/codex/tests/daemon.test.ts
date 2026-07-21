import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { reserveUnusedPort } from "@tokenpilot/host-adapter";
import { daemonPaths, startDaemon, stopDaemon } from "../src/daemon.js";
import { normalizeTokenPilotCodexConfig, writeTokenPilotCodexConfig } from "../src/config.js";

test("startDaemon replaces a stale pid when the configured proxy port is unhealthy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-codex-daemon-"));
  let dummy: ReturnType<typeof spawn> | undefined;
  try {
    const proxyPort = await reserveUnusedPort();
    const stateDir = join(dir, "state");
    const configPath = join(dir, "tokenpilot.json");
    const config = normalizeTokenPilotCodexConfig({
      proxyPort,
      stateDir,
      upstreamProvider: "OPENAI",
      upstream: {
        name: "OpenAI",
        baseUrl: "http://127.0.0.1:9",
        wireApi: "responses",
        requiresOpenAIAuth: true,
      },
    });
    await mkdir(stateDir, { recursive: true });
    await writeTokenPilotCodexConfig(config, configPath);

    dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const { pidPath, logPath } = daemonPaths(config);
    await writeFile(pidPath, `${dummy.pid}\n`, "utf8");

    const cliPath = join(process.cwd(), "dist", "cli.js");
    const result = await startDaemon(config, {
      configPath,
      cliPath,
    });

    assert.equal(result.running, true);
    assert.equal(result.started, true);
    assert.notEqual(result.pid, dummy.pid);
    const persistedPid = Number.parseInt((await readFile(pidPath, "utf8")).trim(), 10);
    assert.equal(persistedPid, result.pid);
    assert.match(await readFile(logPath, "utf8"), /proxy listening at http:\/\/127\.0\.0\.1:/);

    await stopDaemon(config);
  } finally {
    if (dummy?.pid) {
      try {
        process.kill(dummy.pid, "SIGKILL");
      } catch {
        // The stale process should already be gone.
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
