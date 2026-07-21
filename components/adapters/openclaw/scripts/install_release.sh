#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_OPENCLAW_HOME="${HOME}"
OPENCLAW_HOME="${LIGHTMEM2_OPENCLAW_HOME:-${TOKENPILOT_OPENCLAW_HOME:-${DEFAULT_OPENCLAW_HOME}}}"
export HOME="${OPENCLAW_HOME}"
export XDG_CACHE_HOME="${HOME}/.cache"
export XDG_CONFIG_HOME="${HOME}/.config"
mkdir -p "${XDG_CACHE_HOME}" "${XDG_CONFIG_HOME}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
OPENCLAW_PROFILE="${LIGHTMEM2_OPENCLAW_PROFILE:-${OPENCLAW_PROFILE:-}}"
OPENCLAW_STATE_DIR="${LIGHTMEM2_OPENCLAW_STATE_DIR:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-}"
DEV_PLUGIN_PATH="${PLUGIN_DIR}"
INSTALLED_PLUGIN_PATH="${HOME}/.openclaw/extensions/tokenpilot"

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

  python3 - "${CONFIG_PATH}" "${post_install}" <<'PY'
import json
import os
import sys

MODE_PRESETS = {
    "conservative": {
        "triggerMinChars": 4000,
        "maxToolChars": 1800,
        "eviction": False,
        "taskStateEstimator": False,
        "passes": {
            "readStateCompaction": True,
            "toolPayloadTrim": True,
            "htmlSlimming": False,
            "execOutputTruncation": False,
            "agentsStartupOptimization": True,
        },
        "passOptions": {
            "formatSlimming": False,
            "formatCleaning": False,
            "pathTruncation": False,
            "imageDownsample": False,
            "lineNumberStrip": False,
        },
    },
    "normal": {
        "triggerMinChars": 2200,
        "maxToolChars": 1200,
        "eviction": False,
        "taskStateEstimator": False,
        "passes": {
            "readStateCompaction": True,
            "toolPayloadTrim": True,
            "htmlSlimming": True,
            "execOutputTruncation": True,
            "agentsStartupOptimization": True,
        },
        "passOptions": {
            "formatSlimming": True,
            "formatCleaning": True,
            "pathTruncation": True,
            "imageDownsample": True,
            "lineNumberStrip": True,
        },
    },
    "aggressive": {
        "triggerMinChars": 1400,
        "maxToolChars": 900,
        "eviction": True,
        "taskStateEstimator": True,
        "passes": {
            "readStateCompaction": True,
            "toolPayloadTrim": True,
            "htmlSlimming": True,
            "execOutputTruncation": True,
            "agentsStartupOptimization": True,
        },
        "passOptions": {
            "formatSlimming": True,
            "formatCleaning": True,
            "pathTruncation": True,
            "imageDownsample": True,
            "lineNumberStrip": True,
        },
    },
}

config_path = sys.argv[1]
post_install = sys.argv[2] == "1"

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
slots = plugins.setdefault("slots", {})
if post_install:
    slots["contextEngine"] = "layered-context"
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
    next_allow = [item for item in allow if item != "tokenpilot"]
    if post_install and "tokenpilot" not in next_allow:
        next_allow.append("tokenpilot")
    plugins["allow"] = next_allow

entries = plugins.setdefault("entries", {})
tokenpilot = entries.get("tokenpilot")
if not post_install:
    tokenpilot = entries.get("tokenpilot")
else:
    tokenpilot = entries.setdefault("tokenpilot", {})
    tokenpilot["enabled"] = True
    tokenpilot_cfg = tokenpilot.setdefault("config", {})

if post_install:
    allowed_top_level = {
        "enabled",
        "logLevel",
        "proxyAutostart",
        "proxyPort",
        "proxyBaseUrl",
        "proxyApiKey",
        "stateDir",
        "debugTapProviderTraffic",
        "debugTapPath",
        "proxyMode",
        "hooks",
        "contextEngine",
        "ux",
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
    tokenpilot_cfg["logLevel"] = str(tokenpilot_cfg.get("logLevel") or "info")
    tokenpilot_cfg["proxyAutostart"] = True
    tokenpilot_cfg["proxyPort"] = int(tokenpilot_cfg.get("proxyPort") or 17667)
    tokenpilot_cfg["debugTapProviderTraffic"] = bool(tokenpilot_cfg.get("debugTapProviderTraffic", False))

    state_dir = tokenpilot_cfg.get("stateDir")
    if not isinstance(state_dir, str) or not state_dir.strip():
        tokenpilot_cfg["stateDir"] = os.path.join(os.path.expanduser("~"), ".openclaw", "tokenpilot-plugin-state")

    proxy_mode = tokenpilot_cfg.get("proxyMode")
    if not isinstance(proxy_mode, dict):
        proxy_mode = {}
    tokenpilot_cfg["proxyMode"] = {
        "pureForward": bool(proxy_mode.get("pureForward", False)),
    }

    hooks_cfg = tokenpilot_cfg.get("hooks")
    if not isinstance(hooks_cfg, dict):
        hooks_cfg = {}
    tokenpilot_cfg["hooks"] = {
        "beforeToolCall": bool(hooks_cfg.get("beforeToolCall", True)),
        "toolResultPersist": bool(hooks_cfg.get("toolResultPersist", False)),
        "dynamicContextTarget": "user" if str(hooks_cfg.get("dynamicContextTarget", "developer")).strip().lower() == "user" else "developer",
    }

    context_engine = tokenpilot_cfg.get("contextEngine")
    if not isinstance(context_engine, dict):
        context_engine = {}
    tokenpilot_cfg["contextEngine"] = {
        "enabled": bool(context_engine.get("enabled", True)),
        "pruneThresholdChars": max(10000, int(context_engine.get("pruneThresholdChars") or 100000)),
        "keepRecentToolResults": max(0, int(context_engine.get("keepRecentToolResults") or 5)),
        "placeholder": str(context_engine.get("placeholder") or "[pruned]"),
    }

    ux_cfg = tokenpilot_cfg.get("ux")
    if not isinstance(ux_cfg, dict):
        ux_cfg = {}
    tokenpilot_cfg["ux"] = {
        "details": bool(ux_cfg.get("details", False)),
    }

    modules = tokenpilot_cfg.get("modules")
    if not isinstance(modules, dict):
        modules = {}
    tokenpilot_cfg["modules"] = {
        "stabilizer": bool(modules.get("stabilizer", True)),
        "policy": bool(modules.get("policy", True)),
        "reduction": bool(modules.get("reduction", True)),
        "eviction": bool(modules.get("eviction", False)),
    }

    eviction_cfg = tokenpilot_cfg.get("eviction")
    if not isinstance(eviction_cfg, dict):
        eviction_cfg = {}
    tokenpilot_cfg["eviction"] = {
        "enabled": bool(eviction_cfg.get("enabled", False)),
        "policy": str(eviction_cfg.get("policy") or "noop"),
        "maxCandidateBlocks": max(1, int(eviction_cfg.get("maxCandidateBlocks") or 128)),
        "minBlockChars": max(0, int(eviction_cfg.get("minBlockChars") or 256)),
        "replacementMode": "drop" if str(eviction_cfg.get("replacementMode")).strip() == "drop" else "pointer_stub",
    }

    reduction_cfg = tokenpilot_cfg.get("reduction")
    if not isinstance(reduction_cfg, dict):
        reduction_cfg = {}
    mode_preset = MODE_PRESETS["normal"]
    reduction_cfg["engine"] = "layered"
    reduction_cfg["triggerMinChars"] = max(256, int(reduction_cfg.get("triggerMinChars") or mode_preset["triggerMinChars"]))
    reduction_cfg["maxToolChars"] = max(256, int(reduction_cfg.get("maxToolChars") or mode_preset["maxToolChars"]))

    passes = reduction_cfg.get("passes")
    if not isinstance(passes, dict):
        passes = {}
    reduction_cfg["passes"] = {
        "readStateCompaction": bool(passes.get("readStateCompaction", mode_preset["passes"]["readStateCompaction"])),
        "toolPayloadTrim": bool(passes.get("toolPayloadTrim", mode_preset["passes"]["toolPayloadTrim"])),
        "htmlSlimming": bool(passes.get("htmlSlimming", mode_preset["passes"]["htmlSlimming"])),
        "execOutputTruncation": bool(passes.get("execOutputTruncation", mode_preset["passes"]["execOutputTruncation"])),
        "agentsStartupOptimization": bool(passes.get("agentsStartupOptimization", mode_preset["passes"]["agentsStartupOptimization"])),
    }

    pass_options = reduction_cfg.get("passOptions")
    if not isinstance(pass_options, dict):
        pass_options = {}
    reduction_cfg["passOptions"] = {
        "formatSlimming": {
            "enabled": bool(((pass_options.get("formatSlimming") or {}) if isinstance(pass_options.get("formatSlimming"), dict) else {}).get("enabled", mode_preset["passOptions"]["formatSlimming"]))
        },
        "formatCleaning": {
            "enabled": bool(((pass_options.get("formatCleaning") or {}) if isinstance(pass_options.get("formatCleaning"), dict) else {}).get("enabled", mode_preset["passOptions"]["formatCleaning"]))
        },
        "pathTruncation": {
            "enabled": bool(((pass_options.get("pathTruncation") or {}) if isinstance(pass_options.get("pathTruncation"), dict) else {}).get("enabled", mode_preset["passOptions"]["pathTruncation"]))
        },
        "imageDownsample": {
            "enabled": bool(((pass_options.get("imageDownsample") or {}) if isinstance(pass_options.get("imageDownsample"), dict) else {}).get("enabled", mode_preset["passOptions"]["imageDownsample"]))
        },
        "lineNumberStrip": {
            "enabled": bool(((pass_options.get("lineNumberStrip") or {}) if isinstance(pass_options.get("lineNumberStrip"), dict) else {}).get("enabled", mode_preset["passOptions"]["lineNumberStrip"]))
        },
    }
    tokenpilot_cfg["reduction"] = reduction_cfg

    task_state_estimator_cfg = tokenpilot_cfg.get("taskStateEstimator")
    if not isinstance(task_state_estimator_cfg, dict):
        task_state_estimator_cfg = {}
    task_state_estimator_cfg["enabled"] = bool(task_state_estimator_cfg.get("enabled", mode_preset["taskStateEstimator"]))
    tokenpilot_cfg["taskStateEstimator"] = task_state_estimator_cfg

    tokenpilot_cfg["modules"]["eviction"] = bool(tokenpilot_cfg["modules"].get("eviction", mode_preset["eviction"]))
    tokenpilot_cfg["eviction"]["enabled"] = bool(tokenpilot_cfg["eviction"].get("enabled", mode_preset["eviction"]))

if isinstance(entries, dict) and not entries:
    plugins.pop("entries", None)

tools = cfg.get("tools")
if not isinstance(tools, dict):
    tools = {}
    cfg["tools"] = tools

profile = tools.get("profile")
if not isinstance(profile, str) or not profile.strip():
    tools["profile"] = "coding"

allow = tools.get("allow")
also_allow = tools.get("alsoAllow")
if isinstance(allow, list):
    if "memory_fault_recover" not in allow:
        allow.append("memory_fault_recover")
        tools["allow"] = allow
elif isinstance(also_allow, list):
    if "memory_fault_recover" not in also_allow:
        also_allow.append("memory_fault_recover")
        tools["alsoAllow"] = also_allow
else:
    tools["alsoAllow"] = ["memory_fault_recover"]

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
    allow = [item for item in allow if item != "tokenpilot"]
    if allow:
        plugins["allow"] = allow
    else:
        plugins.pop("allow", None)

entries = plugins.get("entries")
if isinstance(entries, dict):
    entries.pop("tokenpilot", None)
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
rm -rf "${INSTALLED_PLUGIN_PATH}"

mkdir -p "${INSTALLED_PLUGIN_PATH}"
tmp_extract_dir="$(mktemp -d)"
tar -xzf "${archive_path}" -C "${tmp_extract_dir}"
cp -R "${tmp_extract_dir}/package/." "${INSTALLED_PLUGIN_PATH}/"
rm -rf "${tmp_extract_dir}"
sanitize_plugin_config 1
if ! openclaw_cmd gateway restart; then
  printf '%s\n' "Warning: gateway restart failed; restart it manually if needed."
fi

printf 'Installed release plugin from %s\n' "${archive_path}"
