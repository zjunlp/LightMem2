import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import process from "node:process";

const execFileAsync = promisify(execFile);
const archivePath = resolve(process.argv[2] ?? "");
const expectedVersion = String(process.argv[3] ?? "").trim();

if (!process.argv[2] || !expectedVersion) {
  throw new Error("Usage: node smoke-openclaw-package.mjs <archive.tgz> <version>");
}

const extractDir = await mkdtemp(join(tmpdir(), "lightmem2-release-smoke-"));
try {
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
  const packageDir = join(extractDir, "package");
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));

  assert.equal(manifest.name, "@lightmem2/openclaw-adapter");
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);

  const require = createRequire(import.meta.url);
  const plugin = require(join(packageDir, "dist", "index.js"));
  assert.equal(plugin.id, "tokenpilot");
  assert.equal(typeof plugin.register, "function");

  process.stdout.write(`OpenClaw release smoke passed: ${archivePath}\n`);
} finally {
  await rm(extractDir, { recursive: true, force: true });
}
