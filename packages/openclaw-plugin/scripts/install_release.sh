#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-${ECOCLAW_OPENCLAW_HOME:-/mnt/20t/xubuqiang}}"
export HOME="${OPENCLAW_HOME}"
export XDG_CACHE_HOME="${HOME}/.cache"
export XDG_CONFIG_HOME="${HOME}/.config"
mkdir -p "${XDG_CACHE_HOME}" "${XDG_CONFIG_HOME}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
DEV_PLUGIN_PATH="${PLUGIN_DIR}"
INSTALLED_PLUGIN_PATH="${HOME}/.openclaw/extensions/ecoclaw"

sanitize_plugin_config() {
  if [[ ! -f "${CONFIG_PATH}" ]]; then
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
  tmp_file="$(mktemp)"
    jq --arg dev_path "${DEV_PLUGIN_PATH}" --arg installed_path "${INSTALLED_PLUGIN_PATH}" '
    if .plugins.load.paths? then
      (.plugins.load.paths |= map(select(. != $dev_path and . != $installed_path))) |
      if ((.plugins.load.paths // []) | length) == 0 then
        del(.plugins.load)
      else
        .
      end
    else
      .
    end
  ' "${CONFIG_PATH}" > "${tmp_file}"
  if ! cmp -s "${tmp_file}" "${CONFIG_PATH}"; then
    cp "${CONFIG_PATH}" "${CONFIG_PATH}.bak.release-install"
    mv "${tmp_file}" "${CONFIG_PATH}"
  else
    rm -f "${tmp_file}"
  fi
  fi

  python3 - "${CONFIG_PATH}" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
load_cfg = plugins.get("load")
if isinstance(load_cfg, dict):
    paths = load_cfg.get("paths")
    if isinstance(paths, list):
        next_paths = []
        for item in paths:
            if not isinstance(item, str):
                continue
            if item == "" or not os.path.exists(item):
                continue
            next_paths.append(item)
        if next_paths:
            load_cfg["paths"] = next_paths
        else:
            plugins.pop("load", None)

allow = plugins.get("allow")
if isinstance(allow, list):
    plugins["allow"] = [item for item in allow if item != "ecoclaw"]

entries = plugins.setdefault("entries", {})
ecoclaw = entries.setdefault("ecoclaw", {})
ecoclaw["enabled"] = True
ecoclaw_cfg = ecoclaw.setdefault("config", {})

allowed_top_level = {
    "enabled",
    "proxyAutostart",
    "proxyPort",
    "proxyBaseUrl",
    "proxyApiKey",
    "modules",
    "eviction",
    "reduction",
    "taskStateEstimator",
}
for key in list(ecoclaw_cfg.keys()):
    if key not in allowed_top_level:
        ecoclaw_cfg.pop(key, None)

ecoclaw_cfg["enabled"] = True
ecoclaw_cfg["proxyAutostart"] = True

modules = ecoclaw_cfg.get("modules")
if not isinstance(modules, dict):
    modules = {}
ecoclaw_cfg["modules"] = {
    "stabilizer": bool(modules.get("stabilizer", True)),
    "policy": bool(modules.get("policy", True)),
    "reduction": bool(modules.get("reduction", True)),
    "eviction": bool(modules.get("eviction", False)),
}

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

sanitize_plugin_config

archive_path="$("${SCRIPT_DIR}/pack_release.sh")"

if openclaw plugins info ecoclaw >/dev/null 2>&1; then
  printf 'y\n' | openclaw plugins uninstall ecoclaw >/dev/null 2>&1 || true
fi

sanitize_plugin_config

openclaw plugins install "${archive_path}"
openclaw gateway restart

printf 'Installed release plugin from %s\n' "${archive_path}"
