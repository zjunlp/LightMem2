#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

normalize_openclaw_runtime_env() {
  local openclaw_home="${TOKENPILOT_OPENCLAW_HOME:-${ECOCLAW_OPENCLAW_HOME:-/mnt/20t/xubuqiang}}"
  export HOME="${openclaw_home}"
  export XDG_CACHE_HOME="${HOME}/.cache"
  export XDG_CONFIG_HOME="${HOME}/.config"
  mkdir -p "${XDG_CACHE_HOME}" "${XDG_CACHE_HOME}/fontconfig" "${XDG_CONFIG_HOME}"
}

normalize_openclaw_runtime_env

promote_tokenpilot_aliases() {
  local key=""
  local legacy_key=""
  while IFS='=' read -r key _; do
    [[ -z "${key}" ]] && continue
    [[ "${key}" != TOKENPILOT_* ]] && continue
    legacy_key="ECOCLAW_${key#TOKENPILOT_}"
    if [[ -z "${!legacy_key+x}" || -z "${!legacy_key}" ]]; then
      export "${legacy_key}=${!key}"
    fi
  done < <(env)
}

import_dotenv() {
  local env_path="${1:-${REPO_ROOT}/.env}"
  if [[ ! -f "${env_path}" ]]; then
    return 0
  fi

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" ]] && continue
    [[ "${line}" == \#* ]] && continue
    [[ "${line}" != *=* ]] && continue
    local key="${line%%=*}"
    local value="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ -n "${!key+x}" ]]; then
      continue
    fi
    export "${key}=${value}"
  done < "${env_path}"
}

import_runtime_envs() {
  import_dotenv "${PINCHBENCH_ROOT}/.env"
  import_dotenv "${REPO_ROOT}/.env"
  promote_tokenpilot_aliases
}

normalize_model_name() {
  local model_like="${1:-}"
  if [[ "${model_like}" == *"gpt-5-4-mini"* ]]; then
    model_like="${model_like//gpt-5-4-mini/gpt-5.4-mini}"
  fi
  if [[ "${model_like}" == */* ]]; then
    model_like="${model_like##*/}"
  fi
  printf '%s\n' "${model_like}"
}

model_env_key() {
  local model_name
  model_name="$(normalize_model_name "${1:-}")"
  model_name="$(printf '%s' "${model_name}" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g')"
  printf '%s\n' "${model_name}"
}

apply_model_runtime_env() {
  local model_like="${1:?model is required}"
  local model_key
  model_key="$(model_env_key "${model_like}")"

  local route_base_var="PINCHBENCH_MODEL_${model_key}_BASE_URL"
  local route_key_var="PINCHBENCH_MODEL_${model_key}_API_KEY"
  local route_provider_var="PINCHBENCH_MODEL_${model_key}_PROVIDER_PREFIX"

  if [[ -n "${!route_base_var:-}" ]]; then
    export ECOCLAW_BASE_URL="${!route_base_var}"
  fi
  if [[ -n "${!route_key_var:-}" ]]; then
    export ECOCLAW_API_KEY="${!route_key_var}"
  fi
  if [[ -n "${!route_provider_var:-}" ]]; then
    export PINCHBENCH_MODEL_PROVIDER_PREFIX="${!route_provider_var}"
  fi
}

resolve_model_alias() {
  local model_like="${1:?model alias is required}"
  local provider_prefix="${PINCHBENCH_MODEL_PROVIDER_PREFIX:-${ECOCLAW_OPENAI_PROVIDER:-}}"
  if [[ "${model_like}" == *"gpt-5-4-mini"* ]]; then
    model_like="${model_like//gpt-5-4-mini/gpt-5.4-mini}"
  fi
  if [[ "${model_like}" == */* ]]; then
    printf '%s\n' "${model_like}"
    return 0
  fi
  if [[ -z "${provider_prefix}" ]]; then
    printf 'Model alias %s requires PINCHBENCH_MODEL_PROVIDER_PREFIX (or ECOCLAW_OPENAI_PROVIDER).\n' "${model_like}" >&2
    return 1
  fi

  case "${model_like}" in
    gpt-oss-20b) printf '%s/gpt-oss-20b\n' "${provider_prefix}" ;;
    gpt-oss-120b) printf '%s/gpt-oss-120b\n' "${provider_prefix}" ;;
    gpt-5-nano) printf '%s/gpt-5-nano\n' "${provider_prefix}" ;;
    gpt-5.4-mini) printf '%s/gpt-5.4-mini\n' "${provider_prefix}" ;;
    gpt-5-4-mini) printf '%s/gpt-5.4-mini\n' "${provider_prefix}" ;;
    gpt-5-mini) printf '%s/gpt-5-mini\n' "${provider_prefix}" ;;
    gpt-5) printf '%s/gpt-5\n' "${provider_prefix}" ;;
    gpt-5-chat) printf '%s/gpt-5-chat\n' "${provider_prefix}" ;;
    gpt-4.1-nano) printf '%s/gpt-4.1-nano\n' "${provider_prefix}" ;;
    gpt-4.1-mini) printf '%s/gpt-4.1-mini\n' "${provider_prefix}" ;;
    gpt-4.1) printf '%s/gpt-4.1\n' "${provider_prefix}" ;;
    gpt-4o-mini) printf '%s/gpt-4o-mini\n' "${provider_prefix}" ;;
    gpt-4o) printf '%s/gpt-4o\n' "${provider_prefix}" ;;
    o1) printf '%s/o1\n' "${provider_prefix}" ;;
    o1-mini) printf '%s/o1-mini\n' "${provider_prefix}" ;;
    o1-pro) printf '%s/o1-pro\n' "${provider_prefix}" ;;
    o3-mini) printf '%s/o3-mini\n' "${provider_prefix}" ;;
    o3) printf '%s/o3\n' "${provider_prefix}" ;;
    o4-mini) printf '%s/o4-mini\n' "${provider_prefix}" ;;
    claude-3.5-sonnet) printf 'openrouter/anthropic/claude-3.5-sonnet\n' ;;
    claude-3.5-haiku) printf 'openrouter/anthropic/claude-3.5-haiku\n' ;;
    claude-3.7-sonnet) printf 'openrouter/anthropic/claude-3.7-sonnet\n' ;;
    claude-sonnet-4) printf 'openrouter/anthropic/claude-sonnet-4\n' ;;
    claude-opus-4.1) printf 'openrouter/anthropic/claude-opus-4.1\n' ;;
    claude-haiku-4.5) printf 'openrouter/anthropic/claude-haiku-4.5\n' ;;
    minimax2.7) printf 'minimax/MiniMax-M2.7\n' ;;
    minimax2) printf 'minimax/MiniMax-M2.7\n' ;;
    minimax) printf 'minimax/MiniMax-M2.7\n' ;;
    *)
      printf 'Unknown model alias: %s\n' "${model_like}" >&2
      return 1
      ;;
  esac
}

apply_ecoclaw_env() {
  if [[ -n "${ECOCLAW_API_KEY:-}" ]]; then
    export OPENAI_API_KEY="${ECOCLAW_API_KEY}"
    export OPENROUTER_API_KEY="${ECOCLAW_API_KEY}"
  fi
  if [[ -n "${ECOCLAW_BASE_URL:-}" ]]; then
    export OPENAI_BASE_URL="${ECOCLAW_BASE_URL}"
    export OPENROUTER_BASE_URL="${ECOCLAW_BASE_URL}"
  fi
  if [[ -n "${MINIMAX_API_KEY:-}" ]]; then
    export MINIMAX_API_KEY="${MINIMAX_API_KEY}"
  fi
  if [[ -n "${GMN_API_KEY:-}" ]]; then
    export GMN_API_KEY="${GMN_API_KEY}"
  fi
  if [[ -z "${ECOCLAW_UPSTREAM_HTTP_PROXY:-}" && -z "${ECOCLAW_UPSTREAM_HTTPS_PROXY:-}" ]]; then
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
    unset ECOCLAW_UPSTREAM_NO_PROXY NO_PROXY no_proxy
  fi
  if [[ -n "${ECOCLAW_UPSTREAM_HTTP_PROXY:-}" ]]; then
    export ECOCLAW_UPSTREAM_HTTPS_PROXY="${ECOCLAW_UPSTREAM_HTTPS_PROXY:-${ECOCLAW_UPSTREAM_HTTP_PROXY}}"
  fi
  if [[ -n "${ECOCLAW_UPSTREAM_HTTPS_PROXY:-}" ]]; then
    export ECOCLAW_UPSTREAM_HTTP_PROXY="${ECOCLAW_UPSTREAM_HTTP_PROXY:-${ECOCLAW_UPSTREAM_HTTPS_PROXY}}"
  fi
  if [[ -z "${ECOCLAW_UPSTREAM_NO_PROXY:-}" ]]; then
    export ECOCLAW_UPSTREAM_NO_PROXY="127.0.0.1,localhost"
  fi
  if [[ -n "${ECOCLAW_UPSTREAM_HTTP_PROXY:-}" ]]; then
    export HTTP_PROXY="${HTTP_PROXY:-${ECOCLAW_UPSTREAM_HTTP_PROXY}}"
    export http_proxy="${http_proxy:-${ECOCLAW_UPSTREAM_HTTP_PROXY}}"
  fi
  if [[ -n "${ECOCLAW_UPSTREAM_HTTPS_PROXY:-}" ]]; then
    export HTTPS_PROXY="${HTTPS_PROXY:-${ECOCLAW_UPSTREAM_HTTPS_PROXY}}"
    export https_proxy="${https_proxy:-${ECOCLAW_UPSTREAM_HTTPS_PROXY}}"
  fi
  export NO_PROXY="${NO_PROXY:-${ECOCLAW_UPSTREAM_NO_PROXY}}"
  export no_proxy="${no_proxy:-${ECOCLAW_UPSTREAM_NO_PROXY}}"
}

require_method_runtime_env() {
  if [[ -z "${ECOCLAW_BASE_URL:-}" ]]; then
    printf 'Missing ECOCLAW_BASE_URL. Define it in experiments/pinchbench/.env or the shell environment.\n' >&2
    return 1
  fi
  if [[ -z "${ECOCLAW_API_KEY:-}" ]]; then
    printf 'Missing ECOCLAW_API_KEY. Define it in experiments/pinchbench/.env or the shell environment.\n' >&2
    return 1
  fi
}

ensure_ecoclaw_plugin_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  local proxy_base_url="${ECOCLAW_BASE_URL:-}"
  local proxy_api_key="${ECOCLAW_API_KEY:-}"
  local proxy_port="${ECOCLAW_PROXY_PORT:-17668}"
  local plugin_load_path="${ECOCLAW_PLUGIN_LOAD_PATH:-${HOME}/.openclaw/extensions/ecoclaw}"
  local proxy_pure_forward="${ECOCLAW_PROXY_PURE_FORWARD:-false}"
  local reduction_trigger_min_chars="${ECOCLAW_REDUCTION_TRIGGER_MIN_CHARS:-2200}"
  local reduction_max_tool_chars="${ECOCLAW_REDUCTION_MAX_TOOL_CHARS:-1200}"
  local reduction_pass_repeated_read_dedup="${ECOCLAW_REDUCTION_PASS_REPEATED_READ_DEDUP:-true}"
  local reduction_pass_tool_payload_trim="${ECOCLAW_REDUCTION_PASS_TOOL_PAYLOAD_TRIM:-false}"
  local reduction_pass_html_slimming="${ECOCLAW_REDUCTION_PASS_HTML_SLIMMING:-true}"
  local reduction_pass_exec_output_truncation="${ECOCLAW_REDUCTION_PASS_EXEC_OUTPUT_TRUNCATION:-true}"
  local reduction_pass_agents_startup_optimization="${ECOCLAW_REDUCTION_PASS_AGENTS_STARTUP_OPTIMIZATION:-true}"
  local default_model="${TOKENPILOT_MODEL:-${ECOCLAW_MODEL:-tokenpilot/gpt-5.4-mini}}"
  local exec_host="${ECOCLAW_EXEC_HOST:-gateway}"
  local exec_security="${ECOCLAW_EXEC_SECURITY:-full}"
  local exec_ask="${ECOCLAW_EXEC_ASK:-off}"
  local enable_eviction="${ECOCLAW_ENABLE_EVICTION:-false}"
  local eviction_policy="${ECOCLAW_EVICTION_POLICY:-lru}"
  local eviction_min_block_chars="${ECOCLAW_EVICTION_MIN_BLOCK_CHARS:-256}"
  local eviction_replacement_mode="${ECOCLAW_EVICTION_REPLACEMENT_MODE:-pointer_stub}"
  local task_state_estimator_enabled="${ECOCLAW_TASK_STATE_ESTIMATOR_ENABLED:-false}"
  local task_state_estimator_base_url="${ECOCLAW_TASK_STATE_ESTIMATOR_BASE_URL:-}"
  local task_state_estimator_api_key="${ECOCLAW_TASK_STATE_ESTIMATOR_API_KEY:-}"
  local task_state_estimator_model="${ECOCLAW_TASK_STATE_ESTIMATOR_MODEL:-}"
  local task_state_estimator_request_timeout_ms="${ECOCLAW_TASK_STATE_ESTIMATOR_REQUEST_TIMEOUT_MS:-60000}"
  local task_state_estimator_batch_turns="${ECOCLAW_TASK_STATE_ESTIMATOR_BATCH_TURNS:-5}"
  local task_state_estimator_eviction_lookahead_turns="${ECOCLAW_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS:-3}"
  local task_state_estimator_input_mode="${ECOCLAW_TASK_STATE_ESTIMATOR_INPUT_MODE:-sliding_window}"
  if [[ ! -f "${config_path}" ]]; then
    echo "WARN: openclaw config not found, skip ecoclaw config patch: ${config_path}" >&2
    return 0
  fi

  python3 - "${config_path}" "${proxy_base_url}" "${proxy_api_key}" "${proxy_port}" "${plugin_load_path}" "${proxy_pure_forward}" "${reduction_trigger_min_chars}" "${reduction_max_tool_chars}" "${reduction_pass_repeated_read_dedup}" "${reduction_pass_tool_payload_trim}" "${reduction_pass_html_slimming}" "${reduction_pass_exec_output_truncation}" "${reduction_pass_agents_startup_optimization}" "${default_model}" "${exec_host}" "${exec_security}" "${exec_ask}" "${enable_eviction}" "${eviction_policy}" "${eviction_min_block_chars}" "${eviction_replacement_mode}" "${task_state_estimator_enabled}" "${task_state_estimator_base_url}" "${task_state_estimator_api_key}" "${task_state_estimator_model}" "${task_state_estimator_request_timeout_ms}" "${task_state_estimator_batch_turns}" "${task_state_estimator_eviction_lookahead_turns}" "${task_state_estimator_input_mode}" <<'PATCH_PY'
import json
import os
import sys

(
    config_path,
    proxy_base_url,
    proxy_api_key,
    proxy_port_raw,
    plugin_load_path,
    proxy_pure_forward_raw,
    trigger_min_chars_raw,
    max_tool_chars_raw,
    pass_repeated_read_dedup_raw,
    pass_tool_payload_trim_raw,
    pass_html_slimming_raw,
    pass_exec_output_truncation_raw,
    pass_agents_startup_optimization_raw,
    default_model,
    exec_host,
    exec_security,
    exec_ask,
    enable_eviction_raw,
    eviction_policy,
    eviction_min_block_chars_raw,
    eviction_replacement_mode,
    task_state_estimator_enabled_raw,
    task_state_estimator_base_url,
    task_state_estimator_api_key,
    task_state_estimator_model,
    task_state_estimator_request_timeout_ms_raw,
    task_state_estimator_batch_turns_raw,
    task_state_estimator_eviction_lookahead_turns_raw,
    task_state_estimator_input_mode,
 ) = sys.argv[1:30]

proxy_port = int(proxy_port_raw)
proxy_pure_forward = str(proxy_pure_forward_raw).strip().lower() in ("1", "true", "yes", "on")
trigger_min_chars = int(trigger_min_chars_raw)
max_tool_chars = int(max_tool_chars_raw)
parse_bool = lambda x: str(x).strip().lower() in ("1", "true", "yes", "on")
pass_repeated_read_dedup = parse_bool(pass_repeated_read_dedup_raw)
pass_tool_payload_trim = parse_bool(pass_tool_payload_trim_raw)
pass_html_slimming = parse_bool(pass_html_slimming_raw)
pass_exec_output_truncation = parse_bool(pass_exec_output_truncation_raw)
pass_agents_startup_optimization = parse_bool(pass_agents_startup_optimization_raw)
enable_eviction = parse_bool(enable_eviction_raw)
eviction_min_block_chars = int(eviction_min_block_chars_raw)
task_state_estimator_enabled = parse_bool(task_state_estimator_enabled_raw)
task_state_estimator_request_timeout_ms = int(task_state_estimator_request_timeout_ms_raw)
task_state_estimator_batch_turns = int(task_state_estimator_batch_turns_raw)
task_state_estimator_eviction_lookahead_turns = int(task_state_estimator_eviction_lookahead_turns_raw)

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
load_cfg = plugins.setdefault("load", {})
load_cfg["paths"] = [plugin_load_path]
entries = plugins.setdefault("entries", {})
ecoclaw = entries.setdefault("ecoclaw", {})
ecoclaw["enabled"] = True
slots = plugins.setdefault("slots", {})
slots["contextEngine"] = "ecoclaw-context"
ecoclaw_cfg = ecoclaw.setdefault("config", {})
ecoclaw_cfg["enabled"] = True
ecoclaw_cfg["proxyAutostart"] = True
ecoclaw_cfg["proxyPort"] = proxy_port
ecoclaw_cfg["proxyBaseUrl"] = proxy_base_url
if proxy_api_key:
    ecoclaw_cfg["proxyApiKey"] = proxy_api_key
modules = ecoclaw_cfg.setdefault("modules", {})
modules["stabilizer"] = True
modules["policy"] = True
modules["reduction"] = True
modules["eviction"] = enable_eviction

ecoclaw_cfg.pop("compaction", None)
ecoclaw_cfg.pop("proxyMode", None)
ecoclaw_cfg.pop("hooks", None)
ecoclaw_cfg.pop("contextEngine", None)
modules = ecoclaw_cfg.get("modules")
if isinstance(modules, dict):
    modules.pop("compaction", None)
    modules.pop("decisionLedger", None)

eviction = ecoclaw_cfg.setdefault("eviction", {})
eviction["enabled"] = enable_eviction
eviction["policy"] = eviction_policy
eviction["minBlockChars"] = max(16, eviction_min_block_chars)
eviction["replacementMode"] = "drop" if eviction_replacement_mode == "drop" else "pointer_stub"

reduction = ecoclaw_cfg.setdefault("reduction", {})
reduction["engine"] = "layered"
reduction["triggerMinChars"] = max(256, trigger_min_chars)
reduction["maxToolChars"] = max(256, max_tool_chars)
passes = reduction.setdefault("passes", {})
passes["repeatedReadDedup"] = pass_repeated_read_dedup
passes["toolPayloadTrim"] = pass_tool_payload_trim
passes["htmlSlimming"] = pass_html_slimming
passes["execOutputTruncation"] = pass_exec_output_truncation
passes["agentsStartupOptimization"] = pass_agents_startup_optimization
pass_options = reduction.setdefault("passOptions", {})

def maybe_apply_json_env(env_name: str, key: str) -> None:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return
    try:
        parsed = json.loads(raw)
    except Exception as exc:
        raise SystemExit(f"Invalid JSON in {env_name}: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit(f"{env_name} must decode to a JSON object")
    pass_options[key] = parsed

maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_REPEATED_READ_DEDUP_JSON", "repeatedReadDedup")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_TOOL_PAYLOAD_TRIM_JSON", "toolPayloadTrim")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_HTML_SLIMMING_JSON", "htmlSlimming")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_EXEC_OUTPUT_TRUNCATION_JSON", "execOutputTruncation")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_AGENTS_STARTUP_OPTIMIZATION_JSON", "agentsStartupOptimization")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_FORMAT_SLIMMING_JSON", "formatSlimming")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_SEMANTIC_LLMLINGUA2_JSON", "semanticLlmlingua2")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_FORMAT_CLEANING_JSON", "formatCleaning")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_PATH_TRUNCATION_JSON", "pathTruncation")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_IMAGE_DOWNSAMPLE_JSON", "imageDownsample")
maybe_apply_json_env("ECOCLAW_REDUCTION_PASS_OPTIONS_LINE_NUMBER_STRIP_JSON", "lineNumberStrip")

agents = cfg.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
model_defaults = defaults.setdefault("model", {})
model_defaults["primary"] = default_model
model_defaults["fallbacks"] = []

tools = cfg.setdefault("tools", {})
allow = tools.setdefault("allow", [])
if isinstance(allow, list) and "memory_fault_recover" not in allow:
    allow.append("memory_fault_recover")
exec_cfg = tools.setdefault("exec", {})
exec_cfg["host"] = exec_host
exec_cfg["security"] = exec_security
exec_cfg["ask"] = exec_ask
task_state_estimator = ecoclaw_cfg.setdefault("taskStateEstimator", {})
task_state_estimator["enabled"] = task_state_estimator_enabled
if task_state_estimator_base_url.strip():
    task_state_estimator["baseUrl"] = task_state_estimator_base_url.strip()
if task_state_estimator_api_key.strip():
    task_state_estimator["apiKey"] = task_state_estimator_api_key.strip()
if task_state_estimator_model.strip():
    task_state_estimator["model"] = task_state_estimator_model.strip()
task_state_estimator["requestTimeoutMs"] = max(1000, task_state_estimator_request_timeout_ms)
task_state_estimator["batchTurns"] = max(1, task_state_estimator_batch_turns)
task_state_estimator["evictionLookaheadTurns"] = max(1, task_state_estimator_eviction_lookahead_turns)
task_state_estimator["inputMode"] = (
    "completed_summary_plus_active_turns"
    if task_state_estimator_input_mode == "completed_summary_plus_active_turns"
    else "sliding_window"
)

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(
    "Ensured plugin runtime config:",
    f"loadPath={plugin_load_path}",
    f"port={ecoclaw_cfg.get('proxyPort')}",
    f"base={ecoclaw_cfg.get('proxyBaseUrl')}",
    f"engine={reduction.get('engine')}",
    f"trim={passes.get('toolPayloadTrim')}",
    f"contextEngineSlot={slots.get('contextEngine')}",
    f"primary={model_defaults.get('primary')}",
    f"execHost={exec_cfg.get('host')}",
    f"execSecurity={exec_cfg.get('security')}",
    f"execAsk={exec_cfg.get('ask')}",
    f"evictionReplacementMode={eviction.get('replacementMode')}",
    f"taskStateEstimatorEnabled={task_state_estimator.get('enabled')}",
    f"taskStateEstimatorModel={task_state_estimator.get('model')}",
    f"taskStateEstimatorInputMode={task_state_estimator.get('inputMode')}",
    f"fallbacks={len(model_defaults.get('fallbacks', []))}",
)
PATCH_PY
}

sanitize_ecoclaw_plugin_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  local enable_eviction="${ECOCLAW_ENABLE_EVICTION:-false}"
  if [[ ! -f "${config_path}" ]]; then
    echo "WARN: openclaw config not found, skip plugin runtime config sanitize: ${config_path}" >&2
    return 0
  fi

  python3 - "${config_path}" "${enable_eviction}" <<'SANITIZE_PY'
import json
import sys

config_path, enable_eviction_raw = sys.argv[1:3]
enable_eviction = str(enable_eviction_raw).strip().lower() in ("1", "true", "yes", "on")

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
plugins.setdefault("slots", {}).setdefault("contextEngine", "ecoclaw-context")
ecoclaw_entry = plugins.setdefault("entries", {}).setdefault("ecoclaw", {})
ecoclaw_entry["enabled"] = True
ecoclaw_cfg = ecoclaw_entry.setdefault("config", {})

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
    "stabilizer": True,
    "policy": True,
    "reduction": True,
    "eviction": enable_eviction,
}

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
SANITIZE_PY
}

validate_openclaw_runtime_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  OPENCLAW_CONFIG_PATH="${config_path}" openclaw config validate >/dev/null
}

resolve_dataset_dir() {
  if [[ -n "${PINCHBENCH_DATASET_DIR:-}" && -d "${PINCHBENCH_DATASET_DIR}" ]]; then
    printf '%s\n' "${PINCHBENCH_DATASET_DIR}"
    return 0
  fi
  if [[ -d "${PINCHBENCH_ROOT}/dataset" ]]; then
    printf '%s\n' "${PINCHBENCH_ROOT}/dataset"
    return 0
  fi
  if [[ -n "${ECOCLAW_SKILL_DIR:-}" && -d "${ECOCLAW_SKILL_DIR}" ]]; then
    printf '%s\n' "${ECOCLAW_SKILL_DIR}"
    return 0
  fi
  printf 'PinchBench dataset directory not found. Set PINCHBENCH_DATASET_DIR or update the local layout.\n' >&2
  return 1
}

resolve_skill_dir() {
  resolve_dataset_dir
}

latest_json_in_dir() {
  local dir_path="${1:?directory path is required}"
  if [[ ! -d "${dir_path}" ]]; then
    return 1
  fi
  local latest_file
  latest_file="$(find "${dir_path}" -maxdepth 1 -type f -name '*.json' -printf '%T@ %p\n' | sort -nr | head -n 1 | awk '{print $2}')"
  if [[ -z "${latest_file}" ]]; then
    return 1
  fi
  printf '%s\n' "${latest_file}"
}

generate_cost_report_and_print_summary() {
  local result_json="${1:?result json is required}"
  local report_json="${2:?report json is required}"
  local cache_write_ttl="${ECOCLAW_CACHE_WRITE_TTL:-5m}"

  if [[ ! -f "${result_json}" ]]; then
    echo "Cost report skipped: result file not found: ${result_json}" >&2
    return 0
  fi

  if ! python3 "${SCRIPT_DIR}/calculate_llm_cost.py" \
    --input "${result_json}" \
    --output "${report_json}" \
    --cache-write-ttl "${cache_write_ttl}" >/dev/null; then
    echo "Cost report generation failed for ${result_json}" >&2
    return 0
  fi

  python3 - <<'PY' "${report_json}"
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
data = json.loads(report_path.read_text(encoding="utf-8"))
totals = data.get("totals", {})
by_model = data.get("by_model", [])

print("=" * 80)
print("COST SUMMARY")
print("=" * 80)
print(f"Report: {report_path}")
print(f"Total cost: ${totals.get('cost_usd', 0.0):.6f} (¥{totals.get('cost_cny', 0.0):.6f})")
print(f"Requests priced: {totals.get('priced_requests', 0)}/{totals.get('requests', 0)}")
if by_model:
    print("-" * 80)
    print(f"{'MODEL':42} {'COST_USD':>12} {'COST_CNY':>12} {'REQUESTS':>10}")
    print("-" * 80)
    for row in by_model:
        model = str(row.get("model", "unknown"))[:42]
        print(
            f"{model:42} "
            f"{float(row.get('cost_usd', 0.0)):12.6f} "
            f"{float(row.get('cost_cny', 0.0)):12.6f} "
            f"{int(row.get('requests', 0)):10d}"
        )
print("=" * 80)
PY
}

generate_reduction_pass_report_and_print_summary() {
  local trace_jsonl="${1:?trace jsonl is required}"
  local report_json="${2:?report json is required}"
  local run_start_iso="${3:?run start iso is required}"

  if [[ ! -f "${trace_jsonl}" ]]; then
    echo "Reduction pass report skipped: trace file not found: ${trace_jsonl}" >&2
    return 0
  fi

  python3 - <<'PY' "${trace_jsonl}" "${report_json}" "${run_start_iso}"
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

trace_path = Path(sys.argv[1])
report_path = Path(sys.argv[2])
run_start_iso = sys.argv[3]
run_start = datetime.fromisoformat(run_start_iso.replace("Z", "+00:00"))

rows = []
for line in trace_path.read_text(encoding="utf-8", errors="replace").splitlines():
    line = line.strip()
    if not line:
      continue
    try:
      row = json.loads(line)
    except Exception:
      continue
    try:
      at = datetime.fromisoformat(str(row.get("at", "")).replace("Z", "+00:00"))
    except Exception:
      continue
    if at < run_start:
      continue
    rows.append(row)

by_pass = defaultdict(lambda: {
    "rows": 0,
    "changed": 0,
    "saved_chars": 0,
    "stages": defaultdict(int),
    "phases": defaultdict(int),
    "targets": defaultdict(int),
    "skipped": defaultdict(int),
})

for row in rows:
    pass_id = str(row.get("passId", "unknown"))
    info = by_pass[pass_id]
    info["rows"] += 1
    if row.get("changed"):
        info["changed"] += 1
    info["saved_chars"] += int(row.get("savedChars", 0) or 0)
    info["stages"][str(row.get("stage", ""))] += 1
    info["phases"][str(row.get("phase", ""))] += 1
    info["targets"][str(row.get("target", ""))] += 1
    skipped = str(row.get("skippedReason", "") or "")
    if skipped:
        info["skipped"][skipped] += 1

report = {
    "trace_path": str(trace_path),
    "run_start_iso": run_start_iso,
    "rows": len(rows),
    "passes": [],
}

for pass_id in sorted(by_pass):
    info = by_pass[pass_id]
    report["passes"].append({
        "pass_id": pass_id,
        "rows": info["rows"],
        "changed": info["changed"],
        "saved_chars": info["saved_chars"],
        "stages": dict(sorted(info["stages"].items())),
        "phases": dict(sorted(info["phases"].items())),
        "targets": dict(sorted(info["targets"].items())),
        "skipped": dict(sorted(info["skipped"].items())),
    })

report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

print("=" * 80)
print("REDUCTION PASS SUMMARY")
print("=" * 80)
print(f"Trace: {trace_path}")
print(f"Report: {report_path}")
print(f"Rows in run window: {len(rows)}")
if report["passes"]:
    print("-" * 80)
    print(f"{'PASS':32} {'ROWS':>6} {'CHANGED':>8} {'SAVED_CHARS':>12}")
    print("-" * 80)
    for row in report["passes"]:
        print(
            f"{row['pass_id'][:32]:32} "
            f"{int(row['rows']):6d} "
            f"{int(row['changed']):8d} "
            f"{int(row['saved_chars']):12d}"
        )
else:
    print("No reduction pass rows found for this run window.")
print("=" * 80)
PY
}

# ---------------------------------------------------------------------------
# Multi-agent config management
# ---------------------------------------------------------------------------

OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
OPENCLAW_CONFIG_BACKUP="${OPENCLAW_CONFIG_BACKUP:-${OPENCLAW_CONFIG_PATH}.bak.bench}"

backup_openclaw_config() {
  if [[ -f "${OPENCLAW_CONFIG_BACKUP}" ]]; then
    echo "ERROR: Benchmark config backup already exists: ${OPENCLAW_CONFIG_BACKUP}" >&2
    echo "A previous run may not have restored cleanly. Inspect and remove manually." >&2
    return 1
  fi
  cp "${OPENCLAW_CONFIG_PATH}" "${OPENCLAW_CONFIG_BACKUP}"
  echo "Backed up openclaw.json to ${OPENCLAW_CONFIG_BACKUP}"
}

restore_openclaw_config() {
  if [[ ! -f "${OPENCLAW_CONFIG_BACKUP}" ]]; then
    return 0
  fi
  cp "${OPENCLAW_CONFIG_BACKUP}" "${OPENCLAW_CONFIG_PATH}"
  rm -f "${OPENCLAW_CONFIG_BACKUP}"
  echo "Restored openclaw.json from backup"
}

recover_stale_openclaw_config_backup() {
  if [[ ! -f "${OPENCLAW_CONFIG_BACKUP}" ]]; then
    return 0
  fi
  echo "Found stale benchmark backup at ${OPENCLAW_CONFIG_BACKUP}; restoring it before starting a new run."
  cp "${OPENCLAW_CONFIG_BACKUP}" "${OPENCLAW_CONFIG_PATH}"
  rm -f "${OPENCLAW_CONFIG_BACKUP}"
}

ensure_openclaw_gateway_running() {
  normalize_openclaw_runtime_env
  local force_restart="${TOKENPILOT_FORCE_GATEWAY_RESTART:-${ECOCLAW_FORCE_GATEWAY_RESTART:-false}}"
  local gateway_port="${ECOCLAW_GATEWAY_PORT:-}"
  if [[ -z "${gateway_port}" ]]; then
    gateway_port="$(python3 - <<'PY'
import json
from pathlib import Path
p = Path("/mnt/20t/xubuqiang/.openclaw/openclaw.json")
try:
    obj = json.loads(p.read_text(encoding="utf-8"))
    print(obj.get("gateway", {}).get("port", 28789))
except Exception:
    print(28789)
PY
)"
  fi
  if [[ "${force_restart}" =~ ^(true|1|yes)$ ]]; then
    echo "Forcing OpenClaw gateway restart on port ${gateway_port}..."
    rm -f /tmp/openclaw_gateway.log
    nohup env \
      HOME="${HOME}" \
      XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
      XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
      ECOCLAW_UPSTREAM_HTTP_PROXY="${ECOCLAW_UPSTREAM_HTTP_PROXY:-}" \
      ECOCLAW_UPSTREAM_HTTPS_PROXY="${ECOCLAW_UPSTREAM_HTTPS_PROXY:-}" \
      ECOCLAW_UPSTREAM_NO_PROXY="${ECOCLAW_UPSTREAM_NO_PROXY:-}" \
      openclaw gateway run --force --port "${gateway_port}" >/tmp/openclaw_gateway.log 2>&1 &
    local gateway_pid=$!
    local attempts=0
    while [[ ${attempts} -lt 30 ]]; do
      if openclaw gateway health >/dev/null 2>&1; then
        echo "OpenClaw gateway restarted (pid=${gateway_pid})"
        return 0
      fi
      attempts=$((attempts + 1))
      sleep 1
    done
    echo "ERROR: forced OpenClaw gateway restart failed. See /tmp/openclaw_gateway.log" >&2
    return 1
  fi
  if ! openclaw gateway health >/dev/null 2>&1; then
    echo "OpenClaw gateway is unreachable; starting a local gateway..."
    nohup openclaw gateway --force >/tmp/openclaw_gateway.log 2>&1 &
    local gateway_pid=$!
    local attempts=0
    while [[ ${attempts} -lt 20 ]]; do
      if openclaw gateway health >/dev/null 2>&1; then
        echo "OpenClaw gateway is ready (pid=${gateway_pid})"
        return 0
      fi
      attempts=$((attempts + 1))
      sleep 1
    done
    if openclaw gateway health >/dev/null 2>&1; then
      echo "OpenClaw gateway became reachable after startup race."
      return 0
    fi
    echo "ERROR: OpenClaw gateway failed to become reachable. See /tmp/openclaw_gateway.log" >&2
    return 1
  fi
  echo "OpenClaw gateway is reachable"
}

# ── AgentSwing context engine configuration injection ──────────────
# Injects the agentswing-context-engine plugin into openclaw.json with the
# specified context management mode and parameters.
# Usage: inject_context_engine_config <mode> [trigger_mode] [trigger_ratio] [trigger_turn_count] [keep_last_n] [context_window]
#   mode:               "keep-last-n" or "summary"
#   trigger_mode:       "token-ratio" or "turn-count", default "token-ratio"
#   trigger_ratio:      float, default 0.4  (used when trigger_mode=token-ratio)
#   trigger_turn_count: int, default 10     (used when trigger_mode=turn-count)
#   keep_last_n:        int, default 5
#   context_window:     int, optional (omit to let engine infer from tokenBudget)
inject_context_engine_config() {
  local mode="${1:?context mode is required (keep-last-n or summary)}"
  local trigger_mode="${2:-token-ratio}"
  local trigger_ratio="${3:-0.4}"
  local trigger_turn_count="${4:-10}"
  local keep_last_n="${5:-5}"
  local context_window="${6:-}"

python3 - "${OPENCLAW_CONFIG_PATH}" "${mode}" "${trigger_mode}" "${trigger_ratio}" "${trigger_turn_count}" "${keep_last_n}" "${context_window}" <<'INJECT_CE_PY'
import json
import sys

config_path = sys.argv[1]
mode = sys.argv[2]
trigger_mode = sys.argv[3]
trigger_ratio = float(sys.argv[4])
trigger_turn_count = int(sys.argv[5])
keep_last_n = int(sys.argv[6])
context_window = sys.argv[7] if len(sys.argv) > 7 and sys.argv[7] else ""

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

# Ensure plugins section exists
plugins = cfg.setdefault("plugins", {})

# Set the active context engine slot
slots = plugins.setdefault("slots", {})
slots["contextEngine"] = "agentswing-context-engine"

# Configure the plugin entry
entries = plugins.setdefault("entries", {})
entry = entries.setdefault("agentswing-context-engine", {})
entry["enabled"] = True

# Build plugin config
plugin_config = {
    "mode": mode,
    "triggerMode": trigger_mode,
    "triggerRatio": trigger_ratio,
    "triggerTurnCount": trigger_turn_count,
    "keepLastN": keep_last_n,
}
if context_window:
    plugin_config["contextWindow"] = int(context_window)
entry["config"] = plugin_config

with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"Injected context engine config: mode={mode} triggerMode={trigger_mode} " +
      f"triggerRatio={trigger_ratio} triggerTurnCount={trigger_turn_count} keepLastN={keep_last_n}" +
      (f" contextWindow={context_window}" if context_window else ""))
INJECT_CE_PY
}
