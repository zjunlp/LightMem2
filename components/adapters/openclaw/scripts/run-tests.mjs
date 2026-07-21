import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { cwd, exit } from "node:process";
import { spawn } from "node:child_process";

async function collectTests(dir, root, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTests(fullPath, root, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      acc.push(relative(root, fullPath));
    }
  }
  return acc;
}

const root = cwd();
const testFiles = (await collectTests(join(root, "src"), root)).sort();

if (testFiles.length === 0) {
  console.error("No test files found under src/");
  exit(1);
}

const child = spawn("node", ["--import", "tsx", "--test", ...testFiles], {
  cwd: root,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  exit(code ?? 1);
});
