#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_EVAL_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${CLAW_EVAL_REPO_ROOT}/../../.." && pwd)"

ROOT_DIR="${PROJECT_ROOT}"
BENCH_PY="${CLAW_EVAL_REPO_ROOT}/scripts/benchmark.py"
TASKS_DIR="${CLAW_EVAL_REPO_ROOT}/dataset/tasks"
SOURCE_DIR="${CLAW_EVAL_REPO_ROOT}/vendor"

export TOKENPILOT_OPENCLAW_HOME="${TOKENPILOT_OPENCLAW_HOME:-/mnt/20t/xubuqiang}"
export CLAW_EVAL_SOURCE_ROOT="${CLAW_EVAL_SOURCE_ROOT:-${SOURCE_DIR}}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/uv-cache}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/uv-cache}"
export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"
export CLAW_EVAL_AGENT_TIMEOUT_SECONDS="${CLAW_EVAL_AGENT_TIMEOUT_SECONDS:-0}"

MODEL="${CLAW_EVAL_MODEL:-ecoclaw/gpt-5.4-mini}"
JUDGE_MODEL="${CLAW_EVAL_JUDGE_MODEL:-${MODEL}}"
LOG_FILE="${CLAW_EVAL_LOG_FILE:-${ROOT_DIR}/claw_eval_continuous_baseline_smoke_communication.log}"
PID_FILE="${CLAW_EVAL_PID_FILE:-${ROOT_DIR}/claw_eval_continuous_baseline_smoke_communication.pid}"
EXTRA_ARGS="${CLAW_EVAL_EXTRA_ARGS:-}"
SUITE="${CLAW_EVAL_SUITE:-T001zh_email_triage,T002_email_triage,T005zh_email_reply_draft,T006_email_reply_draft,T009zh_contact_lookup,T010_contact_lookup,T025zh_ambiguous_contact_email,T026_ambiguous_contact_email}"

mkdir -p "$(dirname "${LOG_FILE}")"

run_foreground() {
  cd "${ROOT_DIR}"
  uv run --directory "${SOURCE_DIR}" --extra mock python -u "${BENCH_PY}" \
    --tasks-dir "${TASKS_DIR}" \
    --suite "${SUITE}" \
    --session-mode continuous \
    --parallel 1 \
    --model "${MODEL}" \
    --judge "${JUDGE_MODEL}" \
    --apply-plugin-plan \
    --execute-tasks \
    ${EXTRA_ARGS}
}

if [[ "${1:-}" == "--foreground" ]]; then
  run_foreground
  exit 0
fi

nohup bash "$0" --foreground > "${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "started claw-eval continuous baseline communication smoke"
echo "pid=$(cat "${PID_FILE}")"
echo "log=${LOG_FILE}"
