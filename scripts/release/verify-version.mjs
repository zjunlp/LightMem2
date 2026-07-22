import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const requestedVersion = process.argv[2]?.trim();

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function packageJsonPaths() {
  const roots = [
    join(repoRoot, "components", "packages", "foundation"),
    join(repoRoot, "components", "packages", "features"),
    join(repoRoot, "components", "presets"),
    join(repoRoot, "components", "adapters"),
    join(repoRoot, "components", "products"),
  ];
  const paths = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const packagePath = join(root, entry.name, "package.json");
      try {
        await access(packagePath);
        paths.push(packagePath);
      } catch {
        // Shared source directories are not necessarily workspace packages.
      }
    }
  }
  return paths.sort();
}

const rootManifestPath = join(repoRoot, "package.json");
const rootManifest = await readJson(rootManifestPath);
const expectedVersion = requestedVersion || String(rootManifest.version || "").trim();

if (!expectedVersion) {
  throw new Error("Release version is missing from package.json and command arguments.");
}
if (rootManifest.version !== expectedVersion) {
  throw new Error(`Root version mismatch: expected ${expectedVersion}, got ${rootManifest.version}.`);
}

const mismatches = [];
const packages = [];
for (const path of await packageJsonPaths()) {
  const manifest = await readJson(path);
  packages.push({ name: manifest.name, version: manifest.version, path });
  if (manifest.version !== expectedVersion) {
    mismatches.push(`${manifest.name}: ${manifest.version} (${path})`);
  }
}

const pluginManifestPath = join(repoRoot, "components", "adapters", "openclaw", "openclaw.plugin.json");
const pluginManifest = await readJson(pluginManifestPath);
if (pluginManifest.version !== expectedVersion) {
  mismatches.push(`OpenClaw plugin manifest: ${pluginManifest.version} (${pluginManifestPath})`);
}

const versionSourcePath = join(repoRoot, "components", "packages", "foundation", "kernel", "src", "version.ts");
const versionSource = await readFile(versionSourcePath, "utf8");
const versionMatch = /LIGHTMEM2_VERSION\s*=\s*["']([^"']+)["']/.exec(versionSource);
if (versionMatch?.[1] !== expectedVersion) {
  mismatches.push(`LIGHTMEM2_VERSION: ${versionMatch?.[1] ?? "missing"} (${versionSourcePath})`);
}

if (mismatches.length > 0) {
  throw new Error(`Release version ${expectedVersion} is not synchronized:\n- ${mismatches.join("\n- ")}`);
}

process.stdout.write(
  `Release version verified: ${expectedVersion} (${packages.length} workspace packages + OpenClaw manifest + runtime constant).\n`,
);
