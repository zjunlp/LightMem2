import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCliEntryPathFromHostModule } from "../src/hosts/visual-daemon.js";

test("resolveCliEntryPathFromHostModule finds dist/cli.js from a src host module path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-visual-daemon-src-"));
  try {
    const distDir = join(dir, "dist");
    const srcHostsDir = join(dir, "src", "hosts");
    await mkdir(distDir, { recursive: true });
    await mkdir(srcHostsDir, { recursive: true });
    await writeFile(join(distDir, "cli.js"), "module.exports = {};\n", "utf8");

    const resolved = resolveCliEntryPathFromHostModule(join(srcHostsDir, "visual.ts"));
    assert.equal(resolved, join(distDir, "cli.js"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveCliEntryPathFromHostModule recovers from an old wrong products/cli/cli.js path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightmem2-cli-visual-daemon-wrong-cli-"));
  try {
    const distDir = join(dir, "dist");
    await mkdir(distDir, { recursive: true });
    await writeFile(join(distDir, "cli.js"), "module.exports = {};\n", "utf8");

    const resolved = resolveCliEntryPathFromHostModule(join(dir, "cli.js"));
    assert.equal(resolved, join(distDir, "cli.js"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
