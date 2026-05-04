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
OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-/mnt/20t/xubuqiang}"
OPENCLAW_CONFIG="${OPENCLAW_HOME}/.openclaw/openclaw.json"

export TOKENPILOT_OPENCLAW_HOME="${OPENCLAW_HOME}"
export CLAW_EVAL_SOURCE_ROOT="${CLAW_EVAL_SOURCE_ROOT:-${SOURCE_DIR}}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/uv-cache}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export CLAW_EVAL_AGENT_TIMEOUT_SECONDS="${CLAW_EVAL_AGENT_TIMEOUT_SECONDS:-0}"

MODEL="${CLAW_EVAL_MODEL:-tokenpilot/gpt-5.4-mini}"
JUDGE_MODEL="${CLAW_EVAL_JUDGE_MODEL:-${MODEL}}"
LOG_FILE="${CLAW_EVAL_LOG_FILE:-${ROOT_DIR}/claw_eval_plugin_smoke_sequential.log}"
PID_FILE="${CLAW_EVAL_PID_FILE:-${ROOT_DIR}/claw_eval_plugin_smoke_sequential.pid}"
EXTRA_ARGS="${CLAW_EVAL_EXTRA_ARGS:-}"

SMOKE1_SUITE="${CLAW_EVAL_SMOKE1_SUITE:-T001zh_email_triage,T002_email_triage,T005zh_email_reply_draft,T006_email_reply_draft}"
SMOKE2_SUITE="${CLAW_EVAL_SMOKE2_SUITE:-T001zh_email_triage,T002_email_triage,T005zh_email_reply_draft,T006_email_reply_draft}"

wait_for_openclaw_json() {
  python3 - <<'PY' "${OPENCLAW_CONFIG}"
import json, pathlib, sys, time
p = pathlib.Path(sys.argv[1])
last_err = None
for _ in range(60):
    try:
        json.loads(p.read_text(encoding='utf-8'))
        print(f"[preflight] openclaw json ok: {p}")
        sys.exit(0)
    except Exception as exc:
        last_err = exc
        time.sleep(1)
print(f"[preflight] openclaw json invalid after retries: {last_err}", file=sys.stderr)
sys.exit(1)
PY
}

ensure_quiet() {
  if pgrep -af '/TokenPilot/experiments/claw-eval/scripts/benchmark.py' >/dev/null 2>&1; then
    echo "[preflight] another claw-eval benchmark.py is still running" >&2
    pgrep -af '/TokenPilot/experiments/claw-eval/scripts/benchmark.py' >&2 || true
    exit 3
  fi
}

run_one() {
  local label="$1"
  local suite="$2"
  shift 2
  echo "[smoke] starting ${label} at $(date '+%F %T')"
  ensure_quiet
  wait_for_openclaw_json
  (
    export TOKENPILOT_ENABLE_REDUCTION="${TOKENPILOT_ENABLE_REDUCTION:-true}"
    export TOKENPILOT_ENABLE_EVICTION="$1"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED="$2"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL="${TOKENPILOT_TASK_STATE_ESTIMATOR_BASE_URL:-https://www.dmxapi.cn/v1}"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL="${TOKENPILOT_TASK_STATE_ESTIMATOR_MODEL:-qwen3.5-35b-a3b}"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS="$3"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE="${TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE:-decoupled}"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY:-fifo}"
    export TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE="${TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE:-1}"
    if [[ "${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED}" == "true" && -z "${TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY:-}" ]]; then
      echo "[smoke] ${label} missing TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY" >&2
      exit 2
    fi
    echo "[smoke] ${label} config reduction=${TOKENPILOT_ENABLE_REDUCTION} eviction=${TOKENPILOT_ENABLE_EVICTION} estimator=${TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED} batch=${TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS}"
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
  )
  echo "[smoke] finished ${label} at $(date '+%F %T')"
}

run_foreground() {
  cd "${ROOT_DIR}"
  run_one 'smoke1_reduction_estimator_no_eviction' "${SMOKE1_SUITE}" false true 1
  sleep 3
  run_one 'smoke2_reduction_no_estimator_no_eviction' "${SMOKE2_SUITE}" false false 1
}

if [[ "${1:-}" == "--foreground" ]]; then
  run_foreground
  exit 0
fi

# Run in foreground by default so the caller can manage backgrounding explicitly.
run_foreground
