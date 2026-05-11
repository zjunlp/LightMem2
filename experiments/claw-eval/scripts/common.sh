#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_EVAL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${CLAW_EVAL_ROOT}/../.." && pwd)"
CLAW_EVAL_BENCH_PY="${CLAW_EVAL_ROOT}/scripts/benchmark.py"
CLAW_EVAL_TASKS_DIR="${CLAW_EVAL_ROOT}/dataset/tasks"
CLAW_EVAL_SOURCE_DIR="${CLAW_EVAL_ROOT}/vendor"
CLAW_EVAL_PLUGIN_ROOT="${CLAW_EVAL_ROOT}/plugins"

# Reuse the pinchbench runtime/env/config stack and keep claw-eval-specific
# naming as a compatibility shim for older run scripts.
# shellcheck source=/mnt/20t/xubuqiang/EcoClaw/TokenPilot/experiments/pinchbench/scripts/common.sh
source "${PROJECT_ROOT}/experiments/pinchbench/scripts/common.sh"

ce_import_dotenv() {
  import_dotenv "$@"
}

ce_import_runtime_envs() {
  import_runtime_envs
}

ce_normalize_runtime_env() {
  normalize_openclaw_runtime_env
  export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${TOKENPILOT_OPENCLAW_HOME:-${HOME}}/.openclaw/openclaw.json}"
  export TOKENPILOT_OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-${HOME}}"
  export HOME="${HOME:-${TOKENPILOT_OPENCLAW_HOME}}"
  export CLAW_EVAL_SOURCE_ROOT="${CLAW_EVAL_SOURCE_ROOT:-${CLAW_EVAL_SOURCE_DIR}}"
  export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
  export CLAW_EVAL_AGENT_TIMEOUT_SECONDS="${CLAW_EVAL_AGENT_TIMEOUT_SECONDS:-0}"
}

ce_apply_baseline_profile() {
  export TOKENPILOT_RUNTIME_ENABLED="${TOKENPILOT_RUNTIME_ENABLED:-false}"
  export TOKENPILOT_ENABLE_REDUCTION="${TOKENPILOT_ENABLE_REDUCTION:-false}"
  export TOKENPILOT_ENABLE_EVICTION="${TOKENPILOT_ENABLE_EVICTION:-false}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-false}"
  export TOKENPILOT_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-false}"
}

ce_apply_method_profile() {
  local profile="${1:-plugin}"
  case "${profile}" in
    plugin)
      export TOKENPILOT_RUNTIME_ENABLED="${TOKENPILOT_RUNTIME_ENABLED:-true}"
      export TOKENPILOT_ENABLE_REDUCTION="${TOKENPILOT_ENABLE_REDUCTION:-true}"
      export TOKENPILOT_ENABLE_EVICTION="${TOKENPILOT_ENABLE_EVICTION:-true}"
      export TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-true}"
      ;;
    reduction)
      export TOKENPILOT_RUNTIME_ENABLED="${TOKENPILOT_RUNTIME_ENABLED:-true}"
      export TOKENPILOT_ENABLE_REDUCTION="${TOKENPILOT_ENABLE_REDUCTION:-true}"
      export TOKENPILOT_ENABLE_EVICTION="${TOKENPILOT_ENABLE_EVICTION:-false}"
      export TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-false}"
      ;;
    custom)
      ;;
    *)
      echo "Unknown claw-eval method profile: ${profile}" >&2
      return 1
      ;;
  esac

  export TOKENPILOT_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-false}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL="${TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL:-https://www.dmxapi.cn/v1}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL="${TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL:-qwen3.5-35b-a3b}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS="${TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS:-${CLAW_EVAL_BATCH_TURNS:-3}}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_INPUT_MODE="${TOKENPILOT_TASK_STATE_ESTIMATOR_INPUT_MODE:-completed_summary_plus_active_turns}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE="${TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE:-decoupled}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY:-fifo}"
  export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE:-1}"
}

ce_require_estimator_env_if_enabled() {
  local estimator_enabled="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-false}"
  if [[ "${estimator_enabled}" == "true" && -z "${TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY:-}" ]]; then
    echo "Missing TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY in environment." >&2
    return 1
  fi
}

ce_prepare_tmp_openclaw_home() {
  local label="${1:-run}"
  local source_home="${SOURCE_OPENCLAW_HOME:-${TOKENPILOT_OPENCLAW_HOME:-${HOME}}}"
  local source_state_dir="${SOURCE_OPENCLAW_STATE_DIR:-${source_home}/.openclaw}"
  if [[ ! -d "${source_state_dir}" ]]; then
    echo "Missing source OpenClaw state dir: ${source_state_dir}" >&2
    return 1
  fi

  local run_stamp tmp_home tmp_state
  run_stamp="$(date +%Y%m%d_%H%M%S)_$$"
  tmp_home="/tmp/claw-eval-openclaw-${label}-${run_stamp}"
  tmp_state="${tmp_home}/.openclaw"

  mkdir -p "${tmp_home}"
  cp -a "${source_state_dir}" "${tmp_state}"
  rm -rf "${tmp_state}/agents" 2>/dev/null || true

  export TOKENPILOT_OPENCLAW_HOME="${tmp_home}"
  export OPENCLAW_CONFIG_PATH="${tmp_state}/openclaw.json"
  export HOME="${tmp_home}"
  export XDG_CONFIG_HOME="${tmp_home}/.config"
  mkdir -p "${XDG_CONFIG_HOME}"

  echo "[tmp-openclaw] source=${source_state_dir}"
  echo "[tmp-openclaw] home=${tmp_home}"
  echo "[tmp-openclaw] config=${OPENCLAW_CONFIG_PATH}"
}

ce_strip_foreground_arg() {
  local out=()
  for arg in "$@"; do
    [[ "${arg}" == "--foreground" ]] && continue
    out+=("${arg}")
  done
  printf '%s\n' "${out[@]}"
}

ce_ensure_openai_responses_provider() {
  local provider_id="${1:?provider id is required}"
  local base_url="${2:?base url is required}"
  local api_key="${3:?api key is required}"
  local config_path="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
  if [[ ! -f "${config_path}" ]]; then
    echo "Missing OpenClaw config: ${config_path}" >&2
    return 1
  fi
  python3 - <<'PY' "${config_path}" "${provider_id}" "${base_url}" "${api_key}"
import json
import pathlib
import sys

cfg_path = pathlib.Path(sys.argv[1])
provider_id = sys.argv[2]
base_url = sys.argv[3]
api_key = sys.argv[4]
doc = json.loads(cfg_path.read_text(encoding="utf-8"))
doc.setdefault("models", {}).setdefault("providers", {})
providers = doc["models"]["providers"]
providers[provider_id] = {
    "baseUrl": base_url,
    "apiKey": api_key,
    "api": "openai-responses",
    "models": [
        {
            "id": "gpt-5.4-mini",
            "name": "gpt-5.4-mini",
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 8192,
        },
        {
            "id": "gpt-5.4",
            "name": "gpt-5.4",
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": 128000,
            "maxTokens": 8192,
        },
    ],
}
cfg_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"updated {cfg_path}")
PY
}

ce_install_release_plugin() {
  (
    cd "${PROJECT_ROOT}"
    TOKENPILOT_OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-${HOME}}" \
    OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH}" \
    pnpm plugin:install:release
  )
}

ce_scope_to_suite() {
  local scope="${1:?scope is required}"
  local explicit_suite="${2:-}"
  local category="${3:-}"

  case "${scope}" in
    all)
      printf 'all\n'
      ;;
    general)
      printf 'general\n'
      ;;
    suite)
      if [[ -z "${explicit_suite}" ]]; then
        echo "--scope suite requires --suite" >&2
        return 1
      fi
      printf '%s\n' "${explicit_suite}"
      ;;
    category)
      if [[ -z "${category}" ]]; then
        echo "--scope category requires --category" >&2
        return 1
      fi
      printf '%s\n' "${category}"
      ;;
    t-general)
      python3 - <<'PY' "${CLAW_EVAL_TASKS_DIR}"
from pathlib import Path
import yaml
root = Path(__import__('sys').argv[1])
ids = []
for task_yaml in sorted(root.glob('*/task.yaml')):
    task_id = task_yaml.parent.name
    if not task_id.startswith('T'):
        continue
    data = yaml.safe_load(task_yaml.read_text(encoding='utf-8')) or {}
    split = str(data.get('split') or 'general')
    if split == 'general':
        ids.append(task_id)
print(','.join(ids))
PY
      ;;
    *)
      echo "Unsupported claw-eval scope: ${scope}" >&2
      return 1
      ;;
  esac
}

ce_general_category_rows() {
  python3 - <<'PY' "${CLAW_EVAL_TASKS_DIR}"
from collections import OrderedDict
from pathlib import Path
import yaml
root = Path(__import__('sys').argv[1])
by_cat = OrderedDict()
for task_yaml in sorted(root.glob('*/task.yaml')):
    task_id = task_yaml.parent.name
    if not task_id.startswith('T'):
        continue
    data = yaml.safe_load(task_yaml.read_text(encoding='utf-8')) or {}
    split = str(data.get('split') or 'general')
    if split != 'general':
        continue
    cat = str(data.get('category') or 'uncategorized')
    by_cat.setdefault(cat, []).append(task_id)
for cat, ids in by_cat.items():
    print(f"{cat}\t{','.join(ids)}")
PY
}

ce_run_benchmark() {
  local suite="${1:?suite is required}"
  local session_mode="${2:?session mode is required}"
  local model="${3:?model is required}"
  local judge="${4:?judge is required}"
  local output_dir="${5:-}"
  local phase="${6:-full}"
  local parallel="${7:-1}"
  local max_tasks="${8:-0}"
  shift 8

  local resolved_model resolved_judge
  apply_model_runtime_env "${model}"
  require_method_runtime_env
  apply_runtime_env
  resolved_model="$(resolve_model_alias "${model}")"
  resolved_judge="$(resolve_model_alias "${judge}")"

  local -a cmd=(
    uv run --directory "${CLAW_EVAL_SOURCE_DIR}" --extra mock python -u "${CLAW_EVAL_BENCH_PY}"
    --tasks-dir "${CLAW_EVAL_TASKS_DIR}"
    --suite "${suite}"
    --phase "${phase}"
    --session-mode "${session_mode}"
    --parallel "${parallel}"
    --model "${resolved_model}"
    --judge "${resolved_judge}"
    --plugin-root "${CLAW_EVAL_PLUGIN_ROOT}"
    --openclaw-config-path "${OPENCLAW_CONFIG_PATH}"
    --apply-plugin-plan
    --execute-tasks
  )

  if [[ -n "${output_dir}" ]]; then
    cmd+=(--output-dir "${output_dir}")
  fi
  if [[ "${max_tasks}" != "0" ]]; then
    cmd+=(--max-tasks "${max_tasks}")
  fi
  if [[ "$#" -gt 0 ]]; then
    cmd+=("$@")
  fi

  "${cmd[@]}"
}
