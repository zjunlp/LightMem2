import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const componentDir = path.join(rootDir, "components");
const validRoles = new Set(["foundation", "feature", "preset", "adapter", "product"]);
const allowedDependencies = {
  foundation: new Set(["foundation"]),
  feature: new Set(["foundation", "feature"]),
  preset: new Set(["foundation", "feature"]),
  adapter: new Set(["foundation", "feature", "preset", "product"]),
  product: new Set(["foundation", "feature", "preset"]),
};

// Remove each exception as its implementation moves to the correct owner.
const knownBoundaryDebt = new Set([
  "@tokenpilot/host-adapter -> @tokenpilot/stabilizer",
  "@tokenpilot/product-surface -> @tokenpilot/stabilizer",
  "@tokenpilot/runtime-core -> @tokenpilot/reduction",
]);

async function findPackageFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
    return [path.join(directory, "package.json")];
  }

  const nested = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist",
      )
      .map((entry) => findPackageFiles(path.join(directory, entry.name))),
  );
  return nested.flat();
}

const packageFiles = await findPackageFiles(componentDir);
const packages = await Promise.all(
  packageFiles.map(async (packageFile) => {
    const manifest = JSON.parse(await readFile(packageFile, "utf8"));
    return {
      manifest,
      packageFile,
      role: manifest.lightmem2?.role,
    };
  }),
);
const packagesByName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
const errors = [];
const debts = [];
const edges = [];

for (const entry of packages) {
  const relativeFile = path.relative(rootDir, entry.packageFile);
  if (!validRoles.has(entry.role)) {
    errors.push(`${relativeFile}: missing or invalid lightmem2.role`);
    continue;
  }

  const dependencyNames = Object.keys(entry.manifest.dependencies ?? {});
  for (const dependencyName of dependencyNames) {
    const dependency = packagesByName.get(dependencyName);
    if (!dependency) continue;

    const edge = `${entry.manifest.name} -> ${dependencyName}`;
    edges.push(`${edge} [${entry.role} -> ${dependency.role}]`);
    if (allowedDependencies[entry.role].has(dependency.role)) continue;
    if (knownBoundaryDebt.has(edge)) {
      debts.push(edge);
      continue;
    }
    errors.push(`${edge}: ${entry.role} packages cannot depend on ${dependency.role} packages`);
  }
}

if (process.argv.includes("--graph")) {
  for (const edge of edges.sort()) console.log(edge);
}
for (const debt of debts.sort()) console.warn(`Known boundary debt: ${debt}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`Boundary error: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Package boundaries valid (${packages.length} packages, ${edges.length} internal edges).`);
}
