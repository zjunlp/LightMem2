import { build } from "esbuild";

async function main() {
  await build({
    entryPoints: {
      index: "src/index.ts",
      cli: "src/cli.ts",
      "hooks-handler": "src/hooks-handler.ts",
      "install-codex": "scripts/install-codex.ts",
    },
    bundle: true,
    outdir: "dist",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: false,
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
