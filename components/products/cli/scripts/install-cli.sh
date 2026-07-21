#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_CLI="$ROOT_DIR/dist/cli.js"
BIN_DIR="${LIGHTMEM2_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/lightmem2"

mkdir -p "$BIN_DIR"

if [[ ! -f "$DIST_CLI" ]]; then
  echo "lightmem2 CLI is not built yet. Run 'pnpm lightmem2:build' first." >&2
  exit 1
fi

ln -sf "$DIST_CLI" "$TARGET"
chmod +x "$DIST_CLI" "$TARGET"

echo "Installed lightmem2 -> $TARGET"
echo "If '$BIN_DIR' is not on your PATH, add it before using 'lightmem2'."
