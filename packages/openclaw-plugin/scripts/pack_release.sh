#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PLUGIN_DIR}"

rm -f ecoclaw-*.tgz
npm run build >/dev/null 2>&1

NPM_CACHE_DIR="${NPM_CACHE_DIR:-/tmp/tokenpilot-npm-cache}"
mkdir -p "${NPM_CACHE_DIR}"

archive_name="$(npm_config_cache="${NPM_CACHE_DIR}" npm pack --silent)"
archive_path="${PLUGIN_DIR}/${archive_name}"

printf '%s\n' "${archive_path}"
