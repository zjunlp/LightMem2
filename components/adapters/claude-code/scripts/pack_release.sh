#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADAPTER_DIR}/../../.." && pwd)"

cd "${REPO_ROOT}"
pnpm --filter @lightmem2/claude-code-adapter build >/dev/null
pnpm --filter @lightmem2/cli build >/dev/null
pnpm --filter @lightmem2/mcp build >/dev/null

PACK_TMP_DIR="$(mktemp -d /tmp/lightmem2-claude-code-pack-XXXXXX)"
cleanup() {
  rm -rf "${PACK_TMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${PACK_TMP_DIR}/package/dist"
for file in index.js cli.js hooks-handler.js install-claude-code.js; do
  cp "${ADAPTER_DIR}/dist/${file}" "${PACK_TMP_DIR}/package/dist/${file}"
done
cp "${REPO_ROOT}/components/products/cli/dist/cli.js" "${PACK_TMP_DIR}/package/dist/lightmem2.js"
cp "${REPO_ROOT}/components/products/mcp/dist/server.js" "${PACK_TMP_DIR}/package/dist/mcp-server.js"
cp "${ADAPTER_DIR}/README.md" "${PACK_TMP_DIR}/package/README.md"

node - "${ADAPTER_DIR}/package.json" "${PACK_TMP_DIR}/package/package.json" <<'NODE'
const fs = require("node:fs");
const [sourcePath, targetPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
delete manifest.dependencies;
delete manifest.devDependencies;
delete manifest.scripts;
manifest.files = ["dist", "README.md"];
fs.writeFileSync(targetPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

NPM_CACHE_DIR="${NPM_CACHE_DIR:-/tmp/lightmem2-npm-cache}"
mkdir -p "${NPM_CACHE_DIR}"
archive_name="$(cd "${PACK_TMP_DIR}/package" && npm_config_cache="${NPM_CACHE_DIR}" npm pack --silent)"
archive_path="${ADAPTER_DIR}/${archive_name}"
cp "${PACK_TMP_DIR}/package/${archive_name}" "${archive_path}"
printf '%s\n' "${archive_path}"
