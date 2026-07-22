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

declare -a ARCHIVE_NAMES=()

pack_adapter() {
  local host="$1"
  local pack_script="$2"
  local archive_path
  local archive_name

  archive_path="$(bash "${pack_script}" | tail -n 1)"
  if [[ ! -f "${archive_path}" ]]; then
    printf 'Release archive was not created for %s: %s\n' "${host}" "${archive_path}" >&2
    exit 1
  fi

  archive_name="$(basename "${archive_path}")"
  cp "${archive_path}" "${OUTPUT_DIR}/${archive_name}"
  rm -f "${archive_path}"
  ARCHIVE_NAMES+=("${archive_name}")

  if [[ "${host}" == "openclaw" ]]; then
    node "${SCRIPT_DIR}/smoke-openclaw-package.mjs" "${OUTPUT_DIR}/${archive_name}" "${VERSION}"
  else
    node "${SCRIPT_DIR}/smoke-host-package.mjs" "${OUTPUT_DIR}/${archive_name}" "${host}" "${VERSION}"
  fi
}

pack_adapter "openclaw" "${REPO_ROOT}/components/adapters/openclaw/scripts/pack_release.sh"
pack_adapter "codex" "${REPO_ROOT}/components/adapters/codex/scripts/pack_release.sh"
pack_adapter "claude-code" "${REPO_ROOT}/components/adapters/claude-code/scripts/pack_release.sh"

(
  cd "${OUTPUT_DIR}"
  sha256sum "${ARCHIVE_NAMES[@]}" > SHA256SUMS
)

COMMIT="$(git rev-parse HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

node - "${OUTPUT_DIR}/release-manifest.json" "${VERSION}" "${COMMIT}" "${BUILT_AT}" "${DIRTY}" "${ARCHIVE_NAMES[@]}" <<'NODE'
const fs = require("node:fs");
const [path, version, commit, builtAt, dirty, ...archives] = process.argv.slice(2);
const packageByFile = {
  openclaw: "@lightmem2/openclaw-adapter",
  codex: "@lightmem2/codex-adapter",
  "claude-code": "@lightmem2/claude-code-adapter",
};
const hostForArchive = (archive) => {
  if (archive.includes("openclaw")) return "openclaw";
  if (archive.includes("claude-code")) return "claude-code";
  if (archive.includes("codex")) return "codex";
  throw new Error(`Unknown adapter archive: ${archive}`);
};
fs.writeFileSync(path, `${JSON.stringify({
  product: "LightMem2",
  version,
  tag: `v${version}`,
  commit,
  builtAt,
  dirty: dirty === "true",
  prerelease: version.includes("-"),
  presets: [{ id: "tokenpilot", version: "1" }],
  artifacts: archives.map((file) => {
    const host = hostForArchive(file);
    return {
      package: packageByFile[host],
      file,
      host,
      ...(host === "openclaw" ? { runtimePluginId: "tokenpilot" } : {}),
    };
  }),
}, null, 2)}\n`);
NODE

OPENCLAW_ARCHIVE="${ARCHIVE_NAMES[0]}"
CODEX_ARCHIVE="${ARCHIVE_NAMES[1]}"
CLAUDE_ARCHIVE="${ARCHIVE_NAMES[2]}"

cat > "${OUTPUT_DIR}/RELEASE_NOTES.md" <<EOF
# LightMem2 v${VERSION}

Commit: \`${COMMIT}\`
Dirty worktree: \`${DIRTY}\`

## Presets

- TokenPilot preset v1

## Release Assets

- \`${OPENCLAW_ARCHIVE}\`: bundled OpenClaw adapter with TokenPilot runtime compatibility
- \`${CODEX_ARCHIVE}\`: self-contained Codex adapter, installer, shared CLI, hooks, and recovery MCP
- \`${CLAUDE_ARCHIVE}\`: self-contained Claude Code adapter, installer, shared CLI, hooks, and recovery MCP
- \`SHA256SUMS\`: artifact checksum
- \`release-manifest.json\`: machine-readable release metadata

## Installation Status

- OpenClaw: bundled release artifact available
- Codex: self-contained release artifact available
- Claude Code: self-contained release artifact available

## Compatibility

- OpenClaw plugin id remains \`tokenpilot\`
- existing TokenPilot commands, config names, and state paths remain compatible
- Codex and Claude Code installers preserve the existing \`tokenpilot-*\` host commands

## Known Limitations

- npm packages are not published by this release
- edit this draft before creating a public GitHub Release
EOF

printf 'Local release candidate created: %s\n' "${OUTPUT_DIR}"
for archive_name in "${ARCHIVE_NAMES[@]}"; do
  printf 'Artifact: %s\n' "${OUTPUT_DIR}/${archive_name}"
done
