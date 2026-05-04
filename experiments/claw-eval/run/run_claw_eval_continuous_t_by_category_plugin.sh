#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_EVAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${CLAW_EVAL_REPO_ROOT}/../../.." && pwd)"

if [[ -f "${CLAW_EVAL_REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${CLAW_EVAL_REPO_ROOT}/.env"
  set +a
elif [[ -f "${CLAW_EVAL_REPO_ROOT}/../pinchbench/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${CLAW_EVAL_REPO_ROOT}/../pinchbench/.env"
  set +a
fi


ROOT_DIR="${PROJECT_ROOT}"
REPO_DIR="${CLAW_EVAL_REPO_ROOT}/../.."
BENCH_PY="${CLAW_EVAL_REPO_ROOT}/scripts/benchmark.py"
TASKS_DIR="${CLAW_EVAL_REPO_ROOT}/dataset/tasks"
SOURCE_DIR="${CLAW_EVAL_REPO_ROOT}/vendor"

export TOKENPILOT_OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-/mnt/20t/xubuqiang}"
export CLAW_EVAL_SOURCE_ROOT="${CLAW_EVAL_SOURCE_ROOT:-${SOURCE_DIR}}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/uv-cache}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export CLAW_EVAL_AGENT_TIMEOUT_SECONDS="${CLAW_EVAL_AGENT_TIMEOUT_SECONDS:-0}"

# TokenPilot continuous plugin policy: reduction + eviction + estimator all enabled.
export TOKENPILOT_ENABLE_REDUCTION="${TOKENPILOT_ENABLE_REDUCTION:-true}"
export TOKENPILOT_ENABLE_EVICTION="${TOKENPILOT_ENABLE_EVICTION:-true}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED="${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED:-true}"

# Match the PinchBench continuous FIFO configuration.
BATCH_TURNS="${CLAW_EVAL_BATCH_TURNS:-3}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS="${TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS:-${BATCH_TURNS}}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE="${TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE:-decoupled}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY:-fifo}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE:-1}"
export TOKENPILOT_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-false}"

# Estimator provider defaults. API key must be supplied via environment.
export TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL="${TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL:-https://www.dmxapi.cn/v1}"
export TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL="${TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL:-qwen3.5-35b-a3b}"
if [[ "${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED}" == "true" && -z "${TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY:-}" ]]; then
  echo "Missing TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY in environment." >&2
  exit 2
fi

MODEL="${CLAW_EVAL_MODEL:-tokenpilot/gpt-5.4-mini}"
JUDGE_MODEL="${CLAW_EVAL_JUDGE_MODEL:-${MODEL}}"
LOG_FILE="${CLAW_EVAL_LOG_FILE:-${ROOT_DIR}/claw_eval_continuous_t_by_category_plugin.log}"
PID_FILE="${CLAW_EVAL_PID_FILE:-${ROOT_DIR}/claw_eval_continuous_t_by_category_plugin.pid}"
EXTRA_ARGS="${CLAW_EVAL_EXTRA_ARGS:-}"
CPUSET="${CPUSET:-}"
NICE_LEVEL="${NICE_LEVEL:-}"

CATEGORY_ROWS=$(python3 - <<'PY'
from pathlib import Path
from collections import OrderedDict
import yaml
root = Path('/mnt/20t/xubuqiang/EcoClaw/TokenPilot/experiments/claw-eval/dataset/tasks')
by_cat = OrderedDict()
for task_yaml in sorted(root.glob('*/task.yaml')):
    task_id = task_yaml.parent.name
    if not task_id.startswith('T'):
        continue
    data = yaml.safe_load(task_yaml.read_text(encoding='utf-8')) or {}
    cat = str(data.get('category') or 'uncategorized')
    by_cat.setdefault(cat, []).append(task_id)
for cat, ids in by_cat.items():
    print(f"{cat}\t{','.join(ids)}")
PY
)

mkdir -p "$(dirname "${LOG_FILE}")"

run_foreground() {
  cd "${ROOT_DIR}"
  while IFS=$'\t' read -r category suite; do
    [[ -z "${category}" ]] && continue
    echo "[category] ${category} count=$(python3 - <<PY
suite = '''${suite}'''.strip()
print(0 if not suite else len([x for x in suite.split(',') if x]))
PY
)"
    uv run --directory "${SOURCE_DIR}" --extra mock python -u "${BENCH_PY}" \
      --tasks-dir "${TASKS_DIR}" \
      --suite "${suite}" \
      --session-mode continuous \
      --parallel 1 \
      --model "${MODEL}" \
      --judge "${JUDGE_MODEL}" \
      --apply-plugin-plan \
      --execute-tasks \
      ${EXTRA_ARGS}
  done <<< "${CATEGORY_ROWS}"
}

if [[ "${1:-}" == "--foreground" ]]; then
  run_foreground
  exit 0
fi

launcher=()
if [[ -n "${CPUSET}" ]]; then
  launcher+=(taskset -c "${CPUSET}")
fi
if [[ -n "${NICE_LEVEL}" ]]; then
  launcher+=(nice -n "${NICE_LEVEL}")
fi
launcher+=(bash "$0" --foreground)
nohup "${launcher[@]}" > "${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "started claw-eval continuous T* by-category plugin run"
echo "pid=$(cat "${PID_FILE}")"
echo "log=${LOG_FILE}"
echo "cpuset=${CPUSET:-all} nice=${NICE_LEVEL:-default}"
