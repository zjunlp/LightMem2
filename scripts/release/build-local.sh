#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VERSION="${1:-$(node -p "require('${REPO_ROOT}/package.json').version")}"
OUTPUT_ROOT="${RELEASE_OUTPUT_DIR:-${REPO_ROOT}/release-artifacts}"
OUTPUT_DIR="${OUTPUT_ROOT}/v${VERSION}"

cd "${REPO_ROOT}"

TRACKED_STATUS="$(git status --porcelain=v1 --untracked-files=no)"
DIRTY=false
if [[ -n "${TRACKED_STATUS}" ]]; then
  DIRTY=true
  if [[ "${RELEASE_ALLOW_DIRTY:-0}" != "1" ]]; then
    printf '%s\n' "Release candidates must be built from a clean tracked worktree." >&2
    printf '%s\n' "Commit or stash tracked changes, or set RELEASE_ALLOW_DIRTY=1 for a development-only rehearsal." >&2
    exit 1
  fi
fi

node "${SCRIPT_DIR}/verify-version.mjs" "${VERSION}"
pnpm check:boundaries
pnpm -r typecheck
pnpm -r build

rm -rf "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}"

ARCHIVE_PATH="$(bash "${REPO_ROOT}/components/adapters/openclaw/scripts/pack_release.sh" | tail -n 1)"
if [[ ! -f "${ARCHIVE_PATH}" ]]; then
  printf 'Release archive was not created: %s\n' "${ARCHIVE_PATH}" >&2
  exit 1
fi

ARCHIVE_NAME="$(basename "${ARCHIVE_PATH}")"
cp "${ARCHIVE_PATH}" "${OUTPUT_DIR}/${ARCHIVE_NAME}"
rm -f "${ARCHIVE_PATH}"

node "${SCRIPT_DIR}/smoke-openclaw-package.mjs" "${OUTPUT_DIR}/${ARCHIVE_NAME}" "${VERSION}"

(
  cd "${OUTPUT_DIR}"
  sha256sum "${ARCHIVE_NAME}" > SHA256SUMS
)

COMMIT="$(git rev-parse HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node - "${OUTPUT_DIR}/release-manifest.json" "${VERSION}" "${COMMIT}" "${BUILT_AT}" "${ARCHIVE_NAME}" "${DIRTY}" <<'NODE'
const fs = require("node:fs");
const [path, version, commit, builtAt, archive, dirty] = process.argv.slice(2);
fs.writeFileSync(path, `${JSON.stringify({
  product: "LightMem2",
  version,
  tag: `v${version}`,
  commit,
  builtAt,
  dirty: dirty === "true",
  prerelease: version.includes("-"),
  presets: [{ id: "tokenpilot", version: "1" }],
  artifacts: [{
    package: "@lightmem2/openclaw-adapter",
    file: archive,
    runtimePluginId: "tokenpilot",
  }],
}, null, 2)}\n`);
NODE

cat > "${OUTPUT_DIR}/RELEASE_NOTES.md" <<EOF
# LightMem2 v${VERSION}

Commit: \`${COMMIT}\`
Dirty worktree: \`${DIRTY}\`

## Presets

- TokenPilot preset v1

## Release Assets

- \`${ARCHIVE_NAME}\`: bundled OpenClaw adapter with TokenPilot runtime compatibility
- \`SHA256SUMS\`: artifact checksum
- \`release-manifest.json\`: machine-readable release metadata

## Installation Status

- OpenClaw: bundled release artifact available
- Codex: source installation in this release candidate
- Claude Code: source installation in this release candidate

## Compatibility

- OpenClaw plugin id remains \`tokenpilot\`
- existing TokenPilot commands and state paths remain compatible

## Known Limitations

- npm packages are not published by this release
- edit this draft before creating a public GitHub Release
EOF

printf 'Local release candidate created: %s\n' "${OUTPUT_DIR}"
printf 'Artifact: %s\n' "${OUTPUT_DIR}/${ARCHIVE_NAME}"
