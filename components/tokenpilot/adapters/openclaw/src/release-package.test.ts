import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageDir = resolve(__dirname, "..");

test("release package loads without monorepo workspace dependencies", async () => {
  const extractDir = await mkdtemp(join(tmpdir(), "tokenpilot-release-smoke-"));
  let archivePath = "";

  try {
    const result = await execFileAsync("bash", ["scripts/pack_release.sh"], {
      cwd: packageDir,
      env: {
        ...process.env,
        NPM_CACHE_DIR: join(extractDir, "npm-cache"),
      },
    });
    archivePath = result.stdout.trim().split("\n").at(-1) ?? "";
    assert.match(archivePath, /tokenpilot-.*\.tgz$/);

    await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
    const installedDir = join(extractDir, "package");
    const manifest = JSON.parse(await readFile(join(installedDir, "package.json"), "utf8"));
    assert.equal(manifest.name, "tokenpilot");
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);

    const require = createRequire(__filename);
    const plugin = require(join(installedDir, "dist", "index.js"));
    assert.equal(plugin.id, "tokenpilot");
    assert.equal(typeof plugin.register, "function");
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
    await rm(extractDir, { recursive: true, force: true });
  }
});
