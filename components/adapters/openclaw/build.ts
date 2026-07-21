import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

async function main() {
  await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/index.js",
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: false,
    logLevel: "info",
    logOverride: {
      // import.meta is used as an ESM fallback; __dirname is always available in CJS.
      "empty-import-meta": "silent",
    },
  });

  // Keep the runtime manifest beside the bundled extension entry so the local
  // OpenClaw extension directory can be synced directly from dist/.
  const pluginManifestSrc = join(process.cwd(), "openclaw.plugin.json");
  const pluginManifestDest = join(process.cwd(), "dist", "openclaw.plugin.json");
  await copyFile(pluginManifestSrc, pluginManifestDest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
