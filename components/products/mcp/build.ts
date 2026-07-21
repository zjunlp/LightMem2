import { build } from "esbuild";

async function main() {
  await build({
    entryPoints: ["src/index.ts", "src/server.ts"],
    bundle: true,
    outdir: "dist",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
    logLevel: "info",
    logOverride: {
      "empty-import-meta": "silent",
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
