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
OPENCLAW_PROFILE="${OPENCLAW_PROFILE:-}"
OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-}"
DEV_PLUGIN_PATH="${PLUGIN_DIR}"
INSTALLED_PLUGIN_PATH="${HOME}/.openclaw/extensions/tokenpilot"
LEGACY_INSTALLED_PLUGIN_PATH="${HOME}/.openclaw/extensions/ecoclaw"

openclaw_cmd() {
  local -a cmd=("openclaw")
  if [[ -n "${OPENCLAW_PROFILE}" ]]; then
    cmd+=("--profile" "${OPENCLAW_PROFILE}")
  fi
  cmd+=("$@")
  env \
    HOME="${HOME}" \
    XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
    XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
    OPENCLAW_CONFIG_PATH="${CONFIG_PATH}" \
    OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" \
    ${OPENCLAW_GATEWAY_PORT:+OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT}"} \
    "${cmd[@]}"
}

sanitize_plugin_config() {
  local post_install="${1:-0}"
  if [[ ! -f "${CONFIG_PATH}" ]]; then
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
  tmp_file="$(mktemp)"
    jq --arg dev_path "${DEV_PLUGIN_PATH}" --arg installed_path "${INSTALLED_PLUGIN_PATH}" --arg legacy_installed_path "${LEGACY_INSTALLED_PLUGIN_PATH}" '
    if .plugins.load.paths? then
      (.plugins.load.paths |= map(select(. != $dev_path and . != $installed_path and . != $legacy_installed_path))) |
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

  python3 - "${CONFIG_PATH}" "${post_install}" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]
post_install = sys.argv[2] == "1"

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
    next_allow = [item for item in allow if item != "ecoclaw"]
    if post_install and "tokenpilot" not in next_allow:
        next_allow.append("tokenpilot")
    plugins["allow"] = next_allow

entries = plugins.setdefault("entries", {})
entries.pop("ecoclaw", None)
tokenpilot = entries.get("tokenpilot")
if not post_install:
    tokenpilot = None
    entries.pop("tokenpilot", None)
else:
    tokenpilot = entries.setdefault("tokenpilot", {})
    tokenpilot["enabled"] = True
    tokenpilot_cfg = tokenpilot.setdefault("config", {})

if post_install:
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
        "memory",
    }
    for key in list(tokenpilot_cfg.keys()):
        if key not in allowed_top_level:
            tokenpilot_cfg.pop(key, None)

    tokenpilot_cfg["enabled"] = True
    tokenpilot_cfg["proxyAutostart"] = True

    modules = tokenpilot_cfg.get("modules")
    if not isinstance(modules, dict):
        modules = {}
    tokenpilot_cfg["modules"] = {
        "stabilizer": bool(modules.get("stabilizer", True)),
        "policy": bool(modules.get("policy", True)),
        "reduction": bool(modules.get("reduction", True)),
        "eviction": bool(modules.get("eviction", False)),
    }

if isinstance(entries, dict) and not entries:
    plugins.pop("entries", None)

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

prepare_config_for_install() {
  if [[ ! -f "${CONFIG_PATH}" ]]; then
    return 0
  fi
  python3 - "${CONFIG_PATH}" <<'PY'
import json
import sys

config_path = sys.argv[1]
with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
allow = plugins.get("allow")
if isinstance(allow, list):
    allow = [item for item in allow if item not in ("tokenpilot", "ecoclaw")]
    if allow:
        plugins["allow"] = allow
    else:
        plugins.pop("allow", None)

entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("tokenpilot", None)
    entries.pop("ecoclaw", None)
    if not entries:
        plugins.pop("entries", None)

tools = cfg.get("tools")
if isinstance(tools, dict):
    elevated = tools.get("elevated")
    if isinstance(elevated, dict):
        allow_from = elevated.get("allowFrom")
        if isinstance(allow_from, dict):
            fixed = {}
            changed = False
            for key, value in allow_from.items():
                if isinstance(value, bool):
                    fixed[key] = ["exec"] if value else []
                    changed = True
                else:
                    fixed[key] = value
            if changed:
                elevated["allowFrom"] = fixed

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
}

sanitize_plugin_config 0

archive_path="$("${SCRIPT_DIR}/pack_release.sh")"
prepare_config_for_install
rm -rf "${INSTALLED_PLUGIN_PATH}" "${LEGACY_INSTALLED_PLUGIN_PATH}"

mkdir -p "${INSTALLED_PLUGIN_PATH}"
tmp_extract_dir="$(mktemp -d)"
tar -xzf "${archive_path}" -C "${tmp_extract_dir}"
cp -R "${tmp_extract_dir}/package/." "${INSTALLED_PLUGIN_PATH}/"
rm -rf "${tmp_extract_dir}"
sanitize_plugin_config 1
openclaw_cmd gateway restart

printf 'Installed release plugin from %s\n' "${archive_path}"
