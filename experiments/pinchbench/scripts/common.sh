#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

normalize_openclaw_runtime_env() {
  local openclaw_home="${TOKENPILOT_OPENCLAW_HOME:-${HOME}}"
  local runtime_local_bin="${openclaw_home}/.local/bin"
  local shared_local_bin="/mnt/20t/xubuqiang/.local/bin"
  export HOME="${openclaw_home}"
  export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
  export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/openclaw-cache}"
  export XDG_CONFIG_HOME="${HOME}/.config"
  export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
  case ":${PATH}:" in
    *":${runtime_local_bin}:"*) ;;
    *) export PATH="${runtime_local_bin}:${PATH}" ;;
  esac
  if [[ -d "${shared_local_bin}" ]]; then
    case ":${PATH}:" in
      *":${shared_local_bin}:"*) ;;
      *) export PATH="${shared_local_bin}:${PATH}" ;;
    esac
  fi
  mkdir -p "${XDG_CACHE_HOME}" "${XDG_CACHE_HOME}/fontconfig" "${XDG_CONFIG_HOME}" "${runtime_local_bin}" "${UV_CACHE_DIR}"
}

normalize_openclaw_runtime_env

openclaw_cmd() {
  if [[ -n "${OPENCLAW_PROFILE:-}" ]]; then
    openclaw --profile "${OPENCLAW_PROFILE}" "$@"
  else
    openclaw "$@"
  fi
}

openclaw_cmd_array() {
  if [[ -n "${OPENCLAW_PROFILE:-}" ]]; then
    printf '%s\0' openclaw --profile "${OPENCLAW_PROFILE}" "$@"
  else
    printf '%s\0' openclaw "$@"
  fi
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
    export TOKENPILOT_BASE_URL="${!route_base_var}"
  fi
  if [[ -n "${!route_key_var:-}" ]]; then
    export TOKENPILOT_API_KEY="${!route_key_var}"
  fi
  if [[ -n "${!route_provider_var:-}" ]]; then
    export PINCHBENCH_MODEL_PROVIDER_PREFIX="${!route_provider_var}"
  fi
}

resolve_model_alias() {
  local model_like="${1:?model alias is required}"
  local provider_prefix="${PINCHBENCH_MODEL_PROVIDER_PREFIX:-}"
  if [[ "${model_like}" == *"gpt-5-4-mini"* ]]; then
    model_like="${model_like//gpt-5-4-mini/gpt-5.4-mini}"
  fi
  if [[ "${model_like}" == */* ]]; then
    printf '%s\n' "${model_like}"
    return 0
  fi
  if [[ -z "${provider_prefix}" ]]; then
    printf 'Model alias %s requires PINCHBENCH_MODEL_PROVIDER_PREFIX.\n' "${model_like}" >&2
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

apply_runtime_env() {
  if [[ -n "${TOKENPILOT_API_KEY:-}" ]]; then
    export OPENAI_API_KEY="${TOKENPILOT_API_KEY}"
    export OPENROUTER_API_KEY="${TOKENPILOT_API_KEY}"
  fi
  if [[ -n "${TOKENPILOT_BASE_URL:-}" ]]; then
    export OPENAI_BASE_URL="${TOKENPILOT_BASE_URL}"
    export OPENROUTER_BASE_URL="${TOKENPILOT_BASE_URL}"
  fi
  if [[ -n "${MINIMAX_API_KEY:-}" ]]; then
    export MINIMAX_API_KEY="${MINIMAX_API_KEY}"
  fi
  if [[ -n "${GMN_API_KEY:-}" ]]; then
    export GMN_API_KEY="${GMN_API_KEY}"
  fi
  if [[ -z "${TOKENPILOT_UPSTREAM_HTTP_PROXY:-}" && -z "${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-}" ]]; then
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
    unset TOKENPILOT_UPSTREAM_NO_PROXY NO_PROXY no_proxy
  fi
  if [[ -n "${TOKENPILOT_UPSTREAM_HTTP_PROXY:-}" ]]; then
    export TOKENPILOT_UPSTREAM_HTTPS_PROXY="${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-${TOKENPILOT_UPSTREAM_HTTP_PROXY}}"
  fi
  if [[ -n "${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-}" ]]; then
    export TOKENPILOT_UPSTREAM_HTTP_PROXY="${TOKENPILOT_UPSTREAM_HTTP_PROXY:-${TOKENPILOT_UPSTREAM_HTTPS_PROXY}}"
  fi
  if [[ -z "${TOKENPILOT_UPSTREAM_NO_PROXY:-}" ]]; then
    export TOKENPILOT_UPSTREAM_NO_PROXY="127.0.0.1,localhost"
  fi
  if [[ -n "${TOKENPILOT_UPSTREAM_HTTP_PROXY:-}" ]]; then
    export HTTP_PROXY="${HTTP_PROXY:-${TOKENPILOT_UPSTREAM_HTTP_PROXY}}"
    export http_proxy="${http_proxy:-${TOKENPILOT_UPSTREAM_HTTP_PROXY}}"
  fi
  if [[ -n "${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-}" ]]; then
    export HTTPS_PROXY="${HTTPS_PROXY:-${TOKENPILOT_UPSTREAM_HTTPS_PROXY}}"
    export https_proxy="${https_proxy:-${TOKENPILOT_UPSTREAM_HTTPS_PROXY}}"
  fi
  export NO_PROXY="${NO_PROXY:-${TOKENPILOT_UPSTREAM_NO_PROXY}}"
  export no_proxy="${no_proxy:-${TOKENPILOT_UPSTREAM_NO_PROXY}}"
}

require_method_runtime_env() {
  if [[ -z "${TOKENPILOT_BASE_URL:-}" ]]; then
    printf 'Missing TOKENPILOT_BASE_URL. Define it in experiments/pinchbench/.env or the shell environment.\n' >&2
    return 1
  fi
  if [[ -z "${TOKENPILOT_API_KEY:-}" ]]; then
    printf 'Missing TOKENPILOT_API_KEY. Define it in experiments/pinchbench/.env or the shell environment.\n' >&2
    return 1
  fi
}

ensure_plugin_runtime_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  local proxy_base_url="${TOKENPILOT_BASE_URL:-}"
  local proxy_api_key="${TOKENPILOT_API_KEY:-}"
  local proxy_port="${TOKENPILOT_PROXY_PORT:-17668}"
  local plugin_load_path="${TOKENPILOT_PLUGIN_LOAD_PATH:-${HOME}/.openclaw/extensions/tokenpilot}"
  local proxy_pure_forward="${TOKENPILOT_PROXY_PURE_FORWARD:-false}"
  local enable_reduction="${TOKENPILOT_ENABLE_REDUCTION:-true}"
  local reduction_trigger_min_chars="${TOKENPILOT_REDUCTION_TRIGGER_MIN_CHARS:-2200}"
  local reduction_max_tool_chars="${TOKENPILOT_REDUCTION_MAX_TOOL_CHARS:-1200}"
  local reduction_pass_repeated_read_dedup="${TOKENPILOT_REDUCTION_PASS_REPEATED_READ_DEDUP:-false}"
  local reduction_pass_tool_payload_trim="${TOKENPILOT_REDUCTION_PASS_TOOL_PAYLOAD_TRIM:-false}"
  local reduction_pass_html_slimming="${TOKENPILOT_REDUCTION_PASS_HTML_SLIMMING:-false}"
  local reduction_pass_exec_output_truncation="${TOKENPILOT_REDUCTION_PASS_EXEC_OUTPUT_TRUNCATION:-false}"
  local reduction_pass_agents_startup_optimization="${TOKENPILOT_REDUCTION_PASS_AGENTS_STARTUP_OPTIMIZATION:-false}"
  local reduction_pass_format_slimming="${TOKENPILOT_REDUCTION_PASS_FORMAT_SLIMMING:-false}"
  local reduction_pass_format_cleaning="${TOKENPILOT_REDUCTION_PASS_FORMAT_CLEANING:-false}"
  local reduction_pass_path_truncation="${TOKENPILOT_REDUCTION_PASS_PATH_TRUNCATION:-false}"
  local reduction_pass_image_downsample="${TOKENPILOT_REDUCTION_PASS_IMAGE_DOWNSAMPLE:-false}"
  local reduction_pass_line_number_strip="${TOKENPILOT_REDUCTION_PASS_LINE_NUMBER_STRIP:-false}"
  local dynamic_context_target="${TOKENPILOT_DYNAMIC_CONTEXT_TARGET:-developer}"
  local default_model="${TOKENPILOT_MODEL:-}"
  local exec_host="${TOKENPILOT_EXEC_HOST:-gateway}"
  local exec_security="${TOKENPILOT_EXEC_SECURITY:-full}"
  local exec_ask="${TOKENPILOT_EXEC_ASK:-off}"
  local elevated_enabled="${TOKENPILOT_ELEVATED_ENABLED:-true}"
  local elevated_allow_from="${TOKENPILOT_ELEVATED_ALLOW_FROM:-webchat}"
  local enable_eviction="${TOKENPILOT_ENABLE_EVICTION:-true}"
  local eviction_policy="${TOKENPILOT_EVICTION_POLICY:-lru}"
  local eviction_min_block_chars="${TOKENPILOT_EVICTION_MIN_BLOCK_CHARS:-256}"
  local eviction_replacement_mode="${TOKENPILOT_EVICTION_REPLACEMENT_MODE:-drop}"
  local task_state_estimator_enabled="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-__KEEP__}"
  local task_state_estimator_base_url="${TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL:-__KEEP__}"
  local task_state_estimator_api_key="${TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY:-__KEEP__}"
  local task_state_estimator_model="${TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL:-__KEEP__}"
  local task_state_estimator_request_timeout_ms="${TOKENPILOT_TASK_STATE_ESTIMATOR_REQUEST_TIMEOUT_MS:-__KEEP__}"
  local task_state_estimator_batch_turns="${TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS:-__KEEP__}"
  local task_state_estimator_eviction_lookahead_turns="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS:-__KEEP__}"
  local task_state_estimator_input_mode="${TOKENPILOT_TASK_STATE_ESTIMATOR_INPUT_MODE:-__KEEP__}"
  local task_state_estimator_lifecycle_mode="${TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE:-__KEEP__}"
  local task_state_estimator_eviction_promotion_policy="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY:-__KEEP__}"
  local task_state_estimator_eviction_promotion_hot_tail_size="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE:-__KEEP__}"
  local memory_enabled="${TOKENPILOT_MEMORY_ENABLED:-__KEEP__}"
  local memory_auto_distill="${TOKENPILOT_MEMORY_AUTO_DISTILL:-__KEEP__}"
  local memory_distiller_type="${TOKENPILOT_MEMORY_DISTILLER_TYPE:-__KEEP__}"
  local memory_batch_size="${TOKENPILOT_MEMORY_BATCH_SIZE:-__KEEP__}"
  local memory_top_k="${TOKENPILOT_MEMORY_TOP_K:-__KEEP__}"
  local memory_inject_as_system_hint="${TOKENPILOT_MEMORY_INJECT_AS_SYSTEM_HINT:-__KEEP__}"
  local memory_distill_base_url="${TOKENPILOT_MEMORY_DISTILL_BASE_URL:-__KEEP__}"
  local memory_distill_api_key="${TOKENPILOT_MEMORY_DISTILL_API_KEY:-__KEEP__}"
  local memory_distill_model="${TOKENPILOT_MEMORY_DISTILL_MODEL:-__KEEP__}"
  local memory_distill_timeout_ms="${TOKENPILOT_MEMORY_DISTILL_TIMEOUT_MS:-__KEEP__}"
  if [[ ! -f "${config_path}" ]]; then
    echo "WARN: openclaw config not found, skip plugin runtime config patch: ${config_path}" >&2
    return 0
  fi

  python3 - "${config_path}" "${proxy_base_url}" "${proxy_api_key}" "${proxy_port}" "${plugin_load_path}" "${proxy_pure_forward}" "${enable_reduction}" "${reduction_trigger_min_chars}" "${reduction_max_tool_chars}" "${reduction_pass_repeated_read_dedup}" "${reduction_pass_tool_payload_trim}" "${reduction_pass_html_slimming}" "${reduction_pass_exec_output_truncation}" "${reduction_pass_agents_startup_optimization}" "${reduction_pass_format_slimming}" "${reduction_pass_format_cleaning}" "${reduction_pass_path_truncation}" "${reduction_pass_image_downsample}" "${reduction_pass_line_number_strip}" "${dynamic_context_target}" "${default_model}" "${exec_host}" "${exec_security}" "${exec_ask}" "${elevated_enabled}" "${elevated_allow_from}" "${enable_eviction}" "${eviction_policy}" "${eviction_min_block_chars}" "${eviction_replacement_mode}" "${task_state_estimator_enabled}" "${task_state_estimator_base_url}" "${task_state_estimator_api_key}" "${task_state_estimator_model}" "${task_state_estimator_request_timeout_ms}" "${task_state_estimator_batch_turns}" "${task_state_estimator_eviction_lookahead_turns}" "${task_state_estimator_input_mode}" "${task_state_estimator_lifecycle_mode}" "${task_state_estimator_eviction_promotion_policy}" "${task_state_estimator_eviction_promotion_hot_tail_size}" "${memory_enabled}" "${memory_auto_distill}" "${memory_distiller_type}" "${memory_batch_size}" "${memory_top_k}" "${memory_inject_as_system_hint}" "${memory_distill_base_url}" "${memory_distill_api_key}" "${memory_distill_model}" "${memory_distill_timeout_ms}" <<'PATCH_PY'
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
    enable_reduction_raw,
    trigger_min_chars_raw,
    max_tool_chars_raw,
    pass_repeated_read_dedup_raw,
    pass_tool_payload_trim_raw,
    pass_html_slimming_raw,
    pass_exec_output_truncation_raw,
    pass_agents_startup_optimization_raw,
    pass_format_slimming_raw,
    pass_format_cleaning_raw,
    pass_path_truncation_raw,
    pass_image_downsample_raw,
    pass_line_number_strip_raw,
    dynamic_context_target,
    default_model,
    exec_host,
    exec_security,
    exec_ask,
    elevated_enabled_raw,
    elevated_allow_from,
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
    task_state_estimator_lifecycle_mode,
    task_state_estimator_eviction_promotion_policy,
    task_state_estimator_eviction_promotion_hot_tail_size_raw,
    memory_enabled_raw,
    memory_auto_distill_raw,
    memory_distiller_type,
    memory_batch_size_raw,
    memory_top_k_raw,
    memory_inject_as_system_hint_raw,
    memory_distill_base_url,
    memory_distill_api_key,
    memory_distill_model,
    memory_distill_timeout_ms_raw,
) = sys.argv[1:52]

proxy_port = int(proxy_port_raw)
proxy_pure_forward = str(proxy_pure_forward_raw).strip().lower() in ("1", "true", "yes", "on")
enable_reduction = str(enable_reduction_raw).strip().lower() in ("1", "true", "yes", "on")
trigger_min_chars = int(trigger_min_chars_raw)
max_tool_chars = int(max_tool_chars_raw)
parse_bool = lambda x: str(x).strip().lower() in ("1", "true", "yes", "on")
pass_repeated_read_dedup = parse_bool(pass_repeated_read_dedup_raw)
pass_tool_payload_trim = parse_bool(pass_tool_payload_trim_raw)
pass_html_slimming = parse_bool(pass_html_slimming_raw)
pass_exec_output_truncation = parse_bool(pass_exec_output_truncation_raw)
pass_agents_startup_optimization = parse_bool(pass_agents_startup_optimization_raw)
pass_format_slimming = parse_bool(pass_format_slimming_raw)
pass_format_cleaning = parse_bool(pass_format_cleaning_raw)
pass_path_truncation = parse_bool(pass_path_truncation_raw)
pass_image_downsample = parse_bool(pass_image_downsample_raw)
pass_line_number_strip = parse_bool(pass_line_number_strip_raw)
enable_eviction = parse_bool(enable_eviction_raw)
elevated_enabled = parse_bool(elevated_enabled_raw)
eviction_min_block_chars = int(eviction_min_block_chars_raw)
task_state_estimator_enabled = parse_bool(task_state_estimator_enabled_raw)
keep_estimator_enabled = task_state_estimator_enabled_raw == "__KEEP__"
keep_estimator_base_url = task_state_estimator_base_url == "__KEEP__"
keep_estimator_api_key = task_state_estimator_api_key == "__KEEP__"
keep_estimator_model = task_state_estimator_model == "__KEEP__"
keep_estimator_request_timeout_ms = task_state_estimator_request_timeout_ms_raw == "__KEEP__"
keep_estimator_batch_turns = task_state_estimator_batch_turns_raw == "__KEEP__"
keep_estimator_eviction_lookahead_turns = task_state_estimator_eviction_lookahead_turns_raw == "__KEEP__"
keep_estimator_input_mode = task_state_estimator_input_mode == "__KEEP__"
keep_estimator_lifecycle_mode = task_state_estimator_lifecycle_mode == "__KEEP__"
keep_estimator_eviction_promotion_policy = task_state_estimator_eviction_promotion_policy == "__KEEP__"
keep_estimator_eviction_promotion_hot_tail_size = task_state_estimator_eviction_promotion_hot_tail_size_raw == "__KEEP__"
keep_memory_enabled = memory_enabled_raw == "__KEEP__"
keep_memory_auto_distill = memory_auto_distill_raw == "__KEEP__"
keep_memory_distiller_type = memory_distiller_type == "__KEEP__"
keep_memory_batch_size = memory_batch_size_raw == "__KEEP__"
keep_memory_top_k = memory_top_k_raw == "__KEEP__"
keep_memory_inject_as_system_hint = memory_inject_as_system_hint_raw == "__KEEP__"
keep_memory_distill_base_url = memory_distill_base_url == "__KEEP__"
keep_memory_distill_api_key = memory_distill_api_key == "__KEEP__"
keep_memory_distill_model = memory_distill_model == "__KEEP__"
keep_memory_distill_timeout_ms = memory_distill_timeout_ms_raw == "__KEEP__"

if keep_estimator_enabled and (
    (not keep_estimator_base_url and task_state_estimator_base_url.strip())
    or (not keep_estimator_api_key and task_state_estimator_api_key.strip())
    or (not keep_estimator_model and task_state_estimator_model.strip())
):
    keep_estimator_enabled = False
    task_state_estimator_enabled = True

task_state_estimator_request_timeout_ms = None if keep_estimator_request_timeout_ms else int(task_state_estimator_request_timeout_ms_raw)
task_state_estimator_batch_turns = None if keep_estimator_batch_turns else int(task_state_estimator_batch_turns_raw)
task_state_estimator_eviction_lookahead_turns = None if keep_estimator_eviction_lookahead_turns else int(task_state_estimator_eviction_lookahead_turns_raw)
task_state_estimator_eviction_promotion_hot_tail_size = None if keep_estimator_eviction_promotion_hot_tail_size else int(task_state_estimator_eviction_promotion_hot_tail_size_raw)
memory_enabled = parse_bool(memory_enabled_raw)
memory_auto_distill = parse_bool(memory_auto_distill_raw)
memory_batch_size = None if keep_memory_batch_size else int(memory_batch_size_raw)
memory_top_k = None if keep_memory_top_k else int(memory_top_k_raw)
memory_inject_as_system_hint = parse_bool(memory_inject_as_system_hint_raw)
memory_distill_timeout_ms = None if keep_memory_distill_timeout_ms else int(memory_distill_timeout_ms_raw)

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
load_cfg = plugins.setdefault("load", {})
existing_paths = load_cfg.get("paths")
preserved_paths = []
if isinstance(existing_paths, list):
    preserved_paths = [
        str(path)
        for path in existing_paths
        if isinstance(path, str) and path not in ("",)
    ]
legacy_roots = {
    "/mnt/20t/xubuqiang/EcoClaw/代码打包/代码打包/plugins",
}
normalized_paths = []
for path_str in preserved_paths + [plugin_load_path]:
    if path_str in legacy_roots:
        continue
    if path_str not in normalized_paths:
        normalized_paths.append(path_str)
load_cfg["paths"] = normalized_paths
existing_allow = plugins.get("allow")
preserved_allow = []
if isinstance(existing_allow, list):
    preserved_allow = [
        item for item in existing_allow
        if isinstance(item, str) and item not in ("ecoclaw",)
    ]
next_allow = []
for item in preserved_allow + ["tokenpilot"]:
    if item not in next_allow:
        next_allow.append(item)
plugins["allow"] = next_allow
entries = plugins.setdefault("entries", {})
entries.pop("ecoclaw", None)
tokenpilot = entries.setdefault("tokenpilot", {})
tokenpilot["enabled"] = True
slots = plugins.setdefault("slots", {})
slots["contextEngine"] = "layered-context"
tokenpilot_cfg = tokenpilot.setdefault("config", {})
tokenpilot_cfg["enabled"] = True
tokenpilot_cfg["proxyAutostart"] = True
if proxy_port:
    tokenpilot_cfg["proxyPort"] = proxy_port
if proxy_base_url:
    tokenpilot_cfg["proxyBaseUrl"] = proxy_base_url
if proxy_api_key:
    tokenpilot_cfg["proxyApiKey"] = proxy_api_key
modules = tokenpilot_cfg.setdefault("modules", {})
modules["stabilizer"] = True
modules["policy"] = True
modules["reduction"] = enable_reduction
modules["eviction"] = enable_eviction

tokenpilot_cfg.pop("compaction", None)
tokenpilot_cfg.pop("proxyMode", None)
modules = tokenpilot_cfg.get("modules")
if isinstance(modules, dict):
    modules.pop("compaction", None)
    modules.pop("decisionLedger", None)

hooks_cfg = tokenpilot_cfg.setdefault("hooks", {})
hooks_cfg["beforeToolCall"] = True
hooks_cfg["toolResultPersist"] = False
hooks_cfg["dynamicContextTarget"] = "user" if str(dynamic_context_target).strip().lower() == "user" else "developer"

context_engine = tokenpilot_cfg.setdefault("contextEngine", {})
context_engine["enabled"] = True

eviction = tokenpilot_cfg.setdefault("eviction", {})
eviction["enabled"] = enable_eviction
eviction["policy"] = eviction_policy
eviction["minBlockChars"] = max(16, eviction_min_block_chars)
eviction["replacementMode"] = "drop" if eviction_replacement_mode == "drop" else "pointer_stub"

reduction = tokenpilot_cfg.setdefault("reduction", {})
reduction["engine"] = "layered"
reduction["triggerMinChars"] = max(256, trigger_min_chars)
reduction["maxToolChars"] = max(256, max_tool_chars)
proxy_mode = tokenpilot_cfg.setdefault("proxyMode", {})
proxy_mode["pureForward"] = proxy_pure_forward
passes = reduction.setdefault("passes", {})
passes["repeatedReadDedup"] = pass_repeated_read_dedup
passes["toolPayloadTrim"] = pass_tool_payload_trim
passes["htmlSlimming"] = pass_html_slimming
passes["execOutputTruncation"] = pass_exec_output_truncation
passes["agentsStartupOptimization"] = pass_agents_startup_optimization
pass_options = reduction.setdefault("passOptions", {})
pass_options["formatSlimming"] = {"enabled": pass_format_slimming}
pass_options["formatCleaning"] = {"enabled": pass_format_cleaning}
pass_options["pathTruncation"] = {"enabled": pass_path_truncation}
pass_options["imageDownsample"] = {"enabled": pass_image_downsample}
pass_options["lineNumberStrip"] = {"enabled": pass_line_number_strip}

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

maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_REPEATED_READ_DEDUP_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_REPEATED_READ_DEDUP_JSON"), "repeatedReadDedup")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_TOOL_PAYLOAD_TRIM_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_TOOL_PAYLOAD_TRIM_JSON"), "toolPayloadTrim")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_HTML_SLIMMING_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_HTML_SLIMMING_JSON"), "htmlSlimming")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_EXEC_OUTPUT_TRUNCATION_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_EXEC_OUTPUT_TRUNCATION_JSON"), "execOutputTruncation")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_AGENTS_STARTUP_OPTIMIZATION_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_AGENTS_STARTUP_OPTIMIZATION_JSON"), "agentsStartupOptimization")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_FORMAT_SLIMMING_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_FORMAT_SLIMMING_JSON"), "formatSlimming")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_SEMANTIC_LLMLINGUA2_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_SEMANTIC_LLMLINGUA2_JSON"), "semanticLlmlingua2")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_FORMAT_CLEANING_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_FORMAT_CLEANING_JSON"), "formatCleaning")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_PATH_TRUNCATION_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_PATH_TRUNCATION_JSON"), "pathTruncation")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_IMAGE_DOWNSAMPLE_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_IMAGE_DOWNSAMPLE_JSON"), "imageDownsample")
maybe_apply_json_env(os.environ.get("TOKENPILOT_REDUCTION_PASS_OPTIONS_LINE_NUMBER_STRIP_ENV", "TOKENPILOT_REDUCTION_PASS_OPTIONS_LINE_NUMBER_STRIP_JSON"), "lineNumberStrip")

agents = cfg.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
model_defaults = defaults.setdefault("model", {})
if default_model:
    model_defaults["primary"] = default_model
model_defaults["fallbacks"] = []

tools = cfg.setdefault("tools", {})
allow = tools.setdefault("allow", [])
tools["allow"] = ["memory_fault_recover"]
tools["deny"] = []
exec_cfg = tools.setdefault("exec", {})
exec_cfg["host"] = exec_host
exec_cfg["security"] = exec_security
exec_cfg["ask"] = exec_ask
elevated_cfg = tools.setdefault("elevated", {})
elevated_cfg["enabled"] = elevated_enabled
allow_from = elevated_cfg.setdefault("allowFrom", {})
if elevated_allow_from.strip():
    allow_from[elevated_allow_from.strip()] = ["exec"]
task_state_estimator = tokenpilot_cfg.setdefault("taskStateEstimator", {})
if not keep_estimator_enabled:
    task_state_estimator["enabled"] = task_state_estimator_enabled
if not keep_estimator_base_url and task_state_estimator_base_url.strip():
    task_state_estimator["baseUrl"] = task_state_estimator_base_url.strip()
if not keep_estimator_api_key and task_state_estimator_api_key.strip():
    task_state_estimator["apiKey"] = task_state_estimator_api_key.strip()
if not keep_estimator_model and task_state_estimator_model.strip():
    task_state_estimator["model"] = task_state_estimator_model.strip()
if not keep_estimator_request_timeout_ms:
    task_state_estimator["requestTimeoutMs"] = max(1000, task_state_estimator_request_timeout_ms)
if not keep_estimator_batch_turns:
    task_state_estimator["batchTurns"] = max(1, task_state_estimator_batch_turns)
if not keep_estimator_eviction_lookahead_turns:
    task_state_estimator["evictionLookaheadTurns"] = max(1, task_state_estimator_eviction_lookahead_turns)
if not keep_estimator_input_mode:
    task_state_estimator["inputMode"] = (
        "completed_summary_plus_active_turns"
        if task_state_estimator_input_mode == "completed_summary_plus_active_turns"
        else "sliding_window"
    )
if not keep_estimator_lifecycle_mode:
    task_state_estimator["lifecycleMode"] = (
        "decoupled"
        if task_state_estimator_lifecycle_mode == "decoupled"
        else "coupled"
    )
if not keep_estimator_eviction_promotion_policy:
    task_state_estimator["evictionPromotionPolicy"] = "fifo"
if not keep_estimator_eviction_promotion_hot_tail_size:
    task_state_estimator["evictionPromotionHotTailSize"] = max(0, task_state_estimator_eviction_promotion_hot_tail_size)

memory = tokenpilot_cfg.setdefault("memory", {})
if not keep_memory_enabled:
    memory["enabled"] = memory_enabled
if not keep_memory_auto_distill:
    memory["autoDistill"] = memory_auto_distill
if not keep_memory_distiller_type and memory_distiller_type.strip():
    memory["distillerType"] = memory_distiller_type.strip()
if not keep_memory_batch_size:
    memory["batchSize"] = max(1, memory_batch_size)
if not keep_memory_top_k:
    memory["topK"] = max(0, memory_top_k)
if not keep_memory_inject_as_system_hint:
    memory["injectAsSystemHint"] = memory_inject_as_system_hint
distill_provider = memory.setdefault("distillProvider", {})
if not keep_memory_distill_base_url and memory_distill_base_url.strip():
    distill_provider["baseUrl"] = memory_distill_base_url.strip()
if not keep_memory_distill_api_key and memory_distill_api_key.strip():
    distill_provider["apiKey"] = memory_distill_api_key.strip()
if not keep_memory_distill_model and memory_distill_model.strip():
    distill_provider["model"] = memory_distill_model.strip()
if not keep_memory_distill_timeout_ms:
    distill_provider["requestTimeoutMs"] = max(1000, memory_distill_timeout_ms)

tmp_path = f"{config_path}.tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp_path, config_path)

print(
    "Ensured plugin runtime config:",
    f"loadPath={plugin_load_path}",
    f"port={tokenpilot_cfg.get('proxyPort')}",
    f"base={tokenpilot_cfg.get('proxyBaseUrl')}",
    f"engine={reduction.get('engine')}",
    f"proxyPureForward={proxy_mode.get('pureForward')}",
    f"reductionEnabled={modules.get('reduction')}",
    f"trim={passes.get('toolPayloadTrim')}",
    f"contextEngineSlot={slots.get('contextEngine')}",
    f"primary={model_defaults.get('primary')}",
    f"execHost={exec_cfg.get('host')}",
    f"execSecurity={exec_cfg.get('security')}",
    f"execAsk={exec_cfg.get('ask')}",
    f"elevatedEnabled={elevated_cfg.get('enabled')}",
    f"elevatedAllowFrom={','.join(sorted(k for k,v in allow_from.items() if v))}",
    f"evictionReplacementMode={eviction.get('replacementMode')}",
    f"taskStateEstimatorEnabled={task_state_estimator.get('enabled')}",
    f"taskStateEstimatorModel={task_state_estimator.get('model')}",
    f"taskStateEstimatorInputMode={task_state_estimator.get('inputMode')}",
    f"taskStateEstimatorLifecycleMode={task_state_estimator.get('lifecycleMode')}",
    f"taskStateEstimatorPromotionPolicy={task_state_estimator.get('evictionPromotionPolicy')}",
    f"taskStateEstimatorHotTailSize={task_state_estimator.get('evictionPromotionHotTailSize')}",
    f"memoryEnabled={memory.get('enabled')}",
    f"memoryAutoDistill={memory.get('autoDistill')}",
    f"memoryDistillerType={memory.get('distillerType')}",
    f"memoryBatchSize={memory.get('batchSize')}",
    f"memoryTopK={memory.get('topK')}",
    f"fallbacks={len(model_defaults.get('fallbacks', []))}",
)
PATCH_PY

  dump_tokenpilot_runtime_config_snapshot "after-ensure-plugin-runtime-config"
}

sanitize_plugin_runtime_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  local enable_eviction="${TOKENPILOT_ENABLE_EVICTION:-false}"
  local enable_reduction="${TOKENPILOT_ENABLE_REDUCTION:-true}"
  if [[ ! -f "${config_path}" ]]; then
    echo "WARN: openclaw config not found, skip plugin runtime config sanitize: ${config_path}" >&2
    return 0
  fi

  python3 - "${config_path}" "${enable_eviction}" "${enable_reduction}" <<'SANITIZE_PY'
import json
import os
import sys

config_path, enable_eviction_raw, enable_reduction_raw = sys.argv[1:4]
enable_eviction = str(enable_eviction_raw).strip().lower() in ("1", "true", "yes", "on")
enable_reduction = str(enable_reduction_raw).strip().lower() in ("1", "true", "yes", "on")

with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.setdefault("plugins", {})
plugins.setdefault("slots", {}).setdefault("contextEngine", "layered-context")
entries = plugins.setdefault("entries", {})
entries.pop("ecoclaw", None)
tokenpilot_entry = entries.setdefault("tokenpilot", {})
tokenpilot_entry["enabled"] = True
tokenpilot_cfg = tokenpilot_entry.setdefault("config", {})

allowed_top_level = {
    "enabled",
    "proxyAutostart",
    "proxyPort",
    "proxyBaseUrl",
    "proxyApiKey",
    "contextEngine",
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
context_engine = tokenpilot_cfg.get("contextEngine")
if not isinstance(context_engine, dict):
    context_engine = {}
tokenpilot_cfg["contextEngine"] = {
    "enabled": True,
    **context_engine,
}

modules = tokenpilot_cfg.get("modules")
if not isinstance(modules, dict):
    modules = {}
tokenpilot_cfg["modules"] = {
    "stabilizer": True,
    "policy": True,
    "reduction": enable_reduction,
    "eviction": enable_eviction,
}

reduction = tokenpilot_cfg.get("reduction")
if not isinstance(reduction, dict):
    reduction = {}
tokenpilot_cfg["reduction"] = reduction

passes = reduction.get("passes")
if not isinstance(passes, dict):
    passes = {}
allowed_passes = {
    "repeatedReadDedup",
    "toolPayloadTrim",
    "htmlSlimming",
    "execOutputTruncation",
    "agentsStartupOptimization",
    "memoryFaultRecovery",
}
for key in list(passes.keys()):
    if key not in allowed_passes:
        passes.pop(key, None)
reduction["passes"] = passes

pass_options = reduction.get("passOptions")
if not isinstance(pass_options, dict):
    pass_options = {}
allowed_pass_options = {
    "repeatedReadDedup",
    "toolPayloadTrim",
    "htmlSlimming",
    "execOutputTruncation",
    "agentsStartupOptimization",
    "memoryFaultRecovery",
    "formatSlimming",
    "formatCleaning",
    "pathTruncation",
    "imageDownsample",
    "lineNumberStrip",
}
for key in list(pass_options.keys()):
    if key not in allowed_pass_options:
        pass_options.pop(key, None)
reduction["passOptions"] = pass_options

tmp_path = f"{config_path}.tmp"
with open(tmp_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.replace(tmp_path, config_path)
SANITIZE_PY

  dump_tokenpilot_runtime_config_snapshot "after-sanitize-plugin-runtime-config"
}

dump_tokenpilot_runtime_config_snapshot() {
  local stage="${1:-snapshot}"
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  if [[ ! -f "${config_path}" ]]; then
    echo "[tokenpilot-config:${stage}] missing config: ${config_path}"
    return 0
  fi
  python3 - "${stage}" "${config_path}" <<'DUMP_CFG_PY'
import json
import sys

stage, config_path = sys.argv[1:3]
with open(config_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

plugins = cfg.get("plugins", {})
entries = plugins.get("entries", {})
tokenpilot = entries.get("tokenpilot") or {}
tokenpilot_cfg = tokenpilot.get("config")

def compact(section):
    if not isinstance(section, dict):
        return section
    task_state_estimator = section.get("taskStateEstimator")
    if isinstance(task_state_estimator, dict) and "apiKey" in task_state_estimator:
        task_state_estimator = dict(task_state_estimator)
        task_state_estimator["apiKey"] = "***REDACTED***" if task_state_estimator.get("apiKey") else ""
    memory = section.get("memory")
    if isinstance(memory, dict):
        memory = dict(memory)
        distill_provider = memory.get("distillProvider")
        if isinstance(distill_provider, dict) and "apiKey" in distill_provider:
            distill_provider = dict(distill_provider)
            distill_provider["apiKey"] = "***REDACTED***" if distill_provider.get("apiKey") else ""
            memory["distillProvider"] = distill_provider
    return {
        "taskStateEstimator": task_state_estimator,
        "memory": memory,
    }

print(
    "[tokenpilot-config:%s] %s"
    % (
        stage,
        json.dumps(
            {
                "entries.tokenpilot.enabled": tokenpilot.get("enabled"),
                "entries.tokenpilot.config": compact(tokenpilot_cfg),
            },
            ensure_ascii=False,
        ),
    )
)
DUMP_CFG_PY
}

ensure_pinchbench_exec_approvals() {
  local approvals_path="${TOKENPILOT_EXEC_APPROVALS_PATH:-${HOME}/.openclaw/exec-approvals.json}"
  mkdir -p "$(dirname "${approvals_path}")"

  python3 - "${approvals_path}" <<'PINCHBENCH_APPROVALS_PY'
import json
import secrets
import sys
from pathlib import Path

approvals_path = Path(sys.argv[1])
home = str(Path.home())

allowlist = [
    {"id": "bin_sh", "pattern": "/bin/sh"},
    {"id": "bin_bash", "pattern": "/bin/bash"},
    {"id": "usr_bin_bash", "pattern": "/usr/bin/bash"},
    {"id": "usr_bin_env", "pattern": "/usr/bin/env"},
    {"id": "usr_bin_find", "pattern": "/usr/bin/find"},
    {"id": "usr_bin_ls", "pattern": "/usr/bin/ls"},
    {"id": "usr_bin_sort", "pattern": "/usr/bin/sort"},
    {"id": "usr_bin_pwd", "pattern": "/usr/bin/pwd"},
    {"id": "usr_bin_sed", "pattern": "/usr/bin/sed"},
    {"id": "usr_bin_grep", "pattern": "/usr/bin/grep"},
    {"id": "usr_bin_head", "pattern": "/usr/bin/head"},
    {"id": "usr_bin_tail", "pattern": "/usr/bin/tail"},
    {"id": "usr_bin_wc", "pattern": "/usr/bin/wc"},
    {"id": "usr_bin_cut", "pattern": "/usr/bin/cut"},
    {"id": "usr_bin_tr", "pattern": "/usr/bin/tr"},
    {"id": "usr_bin_uniq", "pattern": "/usr/bin/uniq"},
    {"id": "usr_bin_true", "pattern": "/usr/bin/true"},
    {"id": "usr_bin_python3", "pattern": "/usr/bin/python3"},
    {"id": "usr_bin_git", "pattern": "/usr/bin/git"},
    {"id": "usr_bin_gh", "pattern": "/usr/bin/gh"},
    {"id": "usr_local_bin_python3", "pattern": "/usr/local/bin/python3"},
    {"id": "mnt20_local_bin_gh", "pattern": "/mnt/20t/xubuqiang/.local/bin/gh"},
    {"id": "mnt20_local_share_gh_bin", "pattern": "/mnt/20t/xubuqiang/.local/share/gh-cli/gh.bin"},
    {"id": "home_local_bin_gws", "pattern": home + "/.local/bin/gws"},
    {"id": "home_local_bin_fws", "pattern": home + "/.local/bin/fws"},
    {"id": "home_nvm_bin_fws", "pattern": home + "/.nvm/versions/node/v22.16.0/bin/fws"},
]

if approvals_path.exists():
    try:
        data = json.loads(approvals_path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
else:
    data = {}

data["version"] = 1
socket_cfg = data.setdefault("socket", {})
socket_cfg["path"] = str(approvals_path.with_suffix(".sock"))
socket_cfg["token"] = socket_cfg.get("token") or secrets.token_urlsafe(24)
data["defaults"] = data.get("defaults") or {}
agents = data.setdefault("agents", {})
wildcard = agents.setdefault("*", {})
wildcard["allowlist"] = allowlist

approvals_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"Ensured PinchBench exec approvals: {approvals_path}")
PINCHBENCH_APPROVALS_PY
}

validate_openclaw_runtime_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  OPENCLAW_CONFIG_PATH="${config_path}" openclaw_cmd config validate >/dev/null
}

assert_method_runtime_config() {
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  python3 - "${config_path}" <<'ASSERT_METHOD_CFG_PY'
import json
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
obj = json.loads(config_path.read_text(encoding="utf-8"))
plugins = obj.get("plugins", {})
entries = plugins.get("entries", {})
tokenpilot = entries.get("tokenpilot", {})
slot = plugins.get("slots", {}).get("contextEngine")
enabled = tokenpilot.get("enabled")

errors = []
if enabled is not True:
    errors.append(f"plugins.entries.tokenpilot.enabled={enabled!r} (expected true)")
if slot != "layered-context":
    errors.append(f"plugins.slots.contextEngine={slot!r} (expected 'layered-context')")

if errors:
    print("Method runtime config is not active:", file=sys.stderr)
    for item in errors:
        print(f"- {item}", file=sys.stderr)
    raise SystemExit(1)
ASSERT_METHOD_CFG_PY
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
  printf 'PinchBench dataset directory not found. Set PINCHBENCH_DATASET_DIR or update the local layout.\n' >&2
  return 1
}

resolve_skill_dir() {
  resolve_dataset_dir
}

resolve_plugin_state_dir() {
  if [[ -n "${TOKENPILOT_STATE_DIR:-}" && -d "${TOKENPILOT_STATE_DIR}" ]]; then
    printf '%s\n' "${TOKENPILOT_STATE_DIR}"
    return 0
  fi
  local tokenpilot_state_dir="${HOME}/.openclaw/tokenpilot-plugin-state"
  if [[ -d "${tokenpilot_state_dir}" ]]; then
    printf '%s\n' "${tokenpilot_state_dir}"
    return 0
  fi
  printf '%s\n' "${tokenpilot_state_dir}"
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
  local cache_write_ttl="${TOKENPILOT_CACHE_WRITE_TTL:-5m}"

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
  local skip_method_runtime_patch="${PINCHBENCH_SKIP_METHOD_RUNTIME_PATCH:-false}"
  if [[ ! "${skip_method_runtime_patch}" =~ ^(true|1|yes)$ ]]; then
    ensure_plugin_runtime_config
    sanitize_plugin_runtime_config
    validate_openclaw_runtime_config
  fi
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  local force_restart="${TOKENPILOT_FORCE_GATEWAY_RESTART:-false}"
  local gateway_port="${TOKENPILOT_GATEWAY_PORT:-}"
  if [[ -z "${gateway_port}" ]]; then
    gateway_port="$(python3 - "${config_path}" <<'PY'
import json
import sys
from pathlib import Path
p = Path(sys.argv[1])
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
    local -a gateway_cmd=()
    mapfile -d '' -t gateway_cmd < <(openclaw_cmd_array gateway run --force --port "${gateway_port}")
    nohup env \
      HOME="${HOME}" \
      OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
      OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" \
      XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
      XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR="${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-}" \
      GOOGLE_WORKSPACE_CLI_TOKEN="${GOOGLE_WORKSPACE_CLI_TOKEN:-}" \
      HTTPS_PROXY="${HTTPS_PROXY:-}" \
      SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
      GH_TOKEN="${GH_TOKEN:-}" \
      GH_REPO="${GH_REPO:-}" \
      TOKENPILOT_UPSTREAM_HTTP_PROXY="${TOKENPILOT_UPSTREAM_HTTP_PROXY:-}" \
      TOKENPILOT_UPSTREAM_HTTPS_PROXY="${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-}" \
      TOKENPILOT_UPSTREAM_NO_PROXY="${TOKENPILOT_UPSTREAM_NO_PROXY:-}" \
      "${gateway_cmd[@]}" >/tmp/openclaw_gateway.log 2>&1 &
    local gateway_pid=$!
    local attempts=0
    while [[ ${attempts} -lt 30 ]]; do
      if openclaw_cmd gateway health >/dev/null 2>&1; then
        if [[ ! "${skip_method_runtime_patch}" =~ ^(true|1|yes)$ ]]; then
          assert_method_runtime_config
        fi
        echo "OpenClaw gateway restarted (pid=${gateway_pid})"
        return 0
      fi
      attempts=$((attempts + 1))
      sleep 1
    done
    echo "ERROR: forced OpenClaw gateway restart failed. See /tmp/openclaw_gateway.log" >&2
    return 1
  fi
  if ! openclaw_cmd gateway health >/dev/null 2>&1; then
    echo "OpenClaw gateway is unreachable; starting a local gateway..."
    rm -f /tmp/openclaw_gateway.log
    local -a gateway_cmd=()
    mapfile -d '' -t gateway_cmd < <(openclaw_cmd_array gateway run --force --port "${gateway_port}")
    nohup env \
      HOME="${HOME}" \
      OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
      OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR}" \
      XDG_CACHE_HOME="${XDG_CACHE_HOME}" \
      XDG_CONFIG_HOME="${XDG_CONFIG_HOME}" \
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR="${GOOGLE_WORKSPACE_CLI_CONFIG_DIR:-}" \
      GOOGLE_WORKSPACE_CLI_TOKEN="${GOOGLE_WORKSPACE_CLI_TOKEN:-}" \
      HTTPS_PROXY="${HTTPS_PROXY:-}" \
      SSL_CERT_FILE="${SSL_CERT_FILE:-}" \
      GH_TOKEN="${GH_TOKEN:-}" \
      GH_REPO="${GH_REPO:-}" \
      TOKENPILOT_UPSTREAM_HTTP_PROXY="${TOKENPILOT_UPSTREAM_HTTP_PROXY:-}" \
      TOKENPILOT_UPSTREAM_HTTPS_PROXY="${TOKENPILOT_UPSTREAM_HTTPS_PROXY:-}" \
      TOKENPILOT_UPSTREAM_NO_PROXY="${TOKENPILOT_UPSTREAM_NO_PROXY:-}" \
      "${gateway_cmd[@]}" >/tmp/openclaw_gateway.log 2>&1 &
    local gateway_pid=$!
    local attempts=0
    while [[ ${attempts} -lt 20 ]]; do
      if openclaw_cmd gateway health >/dev/null 2>&1; then
        if [[ ! "${skip_method_runtime_patch}" =~ ^(true|1|yes)$ ]]; then
          assert_method_runtime_config
        fi
        echo "OpenClaw gateway is ready (pid=${gateway_pid})"
        return 0
      fi
      attempts=$((attempts + 1))
      sleep 1
    done
    if openclaw_cmd gateway health >/dev/null 2>&1; then
      if [[ ! "${skip_method_runtime_patch}" =~ ^(true|1|yes)$ ]]; then
        assert_method_runtime_config
      fi
      echo "OpenClaw gateway became reachable after startup race."
      return 0
    fi
    echo "ERROR: OpenClaw gateway failed to become reachable. See /tmp/openclaw_gateway.log" >&2
    return 1
  fi
  if [[ ! "${skip_method_runtime_patch}" =~ ^(true|1|yes)$ ]]; then
    assert_method_runtime_config
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
