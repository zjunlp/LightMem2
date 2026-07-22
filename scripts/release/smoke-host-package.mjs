import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
const archivePath = resolve(process.argv[2] ?? "");
const host = String(process.argv[3] ?? "").trim();
const expectedVersion = String(process.argv[4] ?? "").trim();

if (!process.argv[2] || !["codex", "claude-code"].includes(host) || !expectedVersion) {
  throw new Error("Usage: node smoke-host-package.mjs <archive.tgz> <codex|claude-code> <version>");
}

const expectedPackageName = `@lightmem2/${host}-adapter`;
const installEntry = host === "codex" ? "install-codex.js" : "install-claude-code.js";
const hostCliName = host === "codex" ? "tokenpilot-codex" : "tokenpilot-claude-code";
const extractDir = await mkdtemp(join(tmpdir(), `lightmem2-${host}-release-smoke-`));

try {
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
  const packageDir = join(extractDir, "package");
  const distDir = join(packageDir, "dist");
  const homeDir = join(extractDir, "home");
  const binDir = join(homeDir, ".local", "bin");
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

  assert.equal(manifest.name, expectedPackageName);
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  for (const file of ["index.js", "cli.js", "hooks-handler.js", installEntry, "lightmem2.js", "mcp-server.js"]) {
    await readFile(join(distDir, file));
  }

  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  let hostConfigPath;
  let auxiliaryConfigPath;
  if (host === "codex") {
    hostConfigPath = join(homeDir, ".codex", "config.toml");
    auxiliaryConfigPath = join(homeDir, ".codex", "hooks.json");
    env.CODEX_CONFIG_PATH = hostConfigPath;
    env.CODEX_HOOKS_CONFIG_PATH = auxiliaryConfigPath;
    env.TOKENPILOT_CODEX_CONFIG = join(homeDir, ".codex", "tokenpilot.json");
  } else {
    hostConfigPath = join(homeDir, ".claude", "settings.json");
    auxiliaryConfigPath = join(homeDir, ".claude.json");
    env.CLAUDE_CODE_SETTINGS_PATH = hostConfigPath;
    env.CLAUDE_CODE_MCP_CONFIG_PATH = auxiliaryConfigPath;
    env.TOKENPILOT_CLAUDE_CODE_CONFIG = join(homeDir, ".claude", "tokenpilot.json");
  }

  await execFileAsync(process.execPath, [join(distDir, installEntry)], {
    cwd: packageDir,
    env,
    timeout: 45_000,
  });

  const hostConfig = await readFile(hostConfigPath, "utf8");
  const auxiliaryConfig = await readFile(auxiliaryConfigPath, "utf8");
  const installedConfig = `${hostConfig}\n${auxiliaryConfig}`;
  assert.match(installedConfig, new RegExp(join(distDir, "hooks-handler.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(installedConfig, new RegExp(join(distDir, "mcp-server.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.equal(await readlink(join(binDir, "lightmem2")), join(distDir, "lightmem2.js"));
  assert.equal(await readlink(join(binDir, hostCliName)), join(distDir, "cli.js"));

  const skillsRoot = host === "codex" ? join(homeDir, ".codex", "skills") : join(homeDir, ".claude", "skills");
  const skill = await readFile(join(skillsRoot, "lightmem2-doctor", "SKILL.md"), "utf8");
  assert.match(skill, new RegExp(join(distDir, "lightmem2.js").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const loaded = await import(join(distDir, "index.js"));
  assert.ok(Object.keys(loaded).length > 0);
  process.stdout.write(`${host} release smoke passed: ${archivePath}\n`);
} finally {
  await rm(extractDir, { recursive: true, force: true });
}
