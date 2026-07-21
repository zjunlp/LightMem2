import { build } from "esbuild";

async function main() {
  await build({
    entryPoints: ["src/index.ts", "src/cli.ts", "src/hooks-handler.ts"],
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
