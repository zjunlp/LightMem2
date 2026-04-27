#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PINCHBENCH_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=common.sh
source "${SCRIPT_DIR}/common.sh"

MODEL=""
JUDGE=""
SUITE=""
RUNS=""
TIMEOUT_MULTIPLIER=""
PARALLEL=""
SESSION_MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="${2:-}"; shift 2 ;;
    --judge) JUDGE="${2:-}"; shift 2 ;;
    --suite) SUITE="${2:-}"; shift 2 ;;
    --runs) RUNS="${2:-}"; shift 2 ;;
    --timeout-multiplier) TIMEOUT_MULTIPLIER="${2:-}"; shift 2 ;;
    --parallel) PARALLEL="${2:-}"; shift 2 ;;
    --session-mode) SESSION_MODE="${2:-}"; shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

import_runtime_envs
MODEL_LIKE="${MODEL:-${TOKENPILOT_MODEL:-${ECOCLAW_MODEL:-tokenpilot/gpt-5.4-mini}}}"
JUDGE_LIKE="${JUDGE:-${TOKENPILOT_JUDGE:-${ECOCLAW_JUDGE:-tokenpilot/gpt-5.4-mini}}}"
apply_model_runtime_env "${MODEL_LIKE}"
require_method_runtime_env
apply_ecoclaw_env
export ECOCLAW_FORCE_GATEWAY_RESTART="${TOKENPILOT_FORCE_GATEWAY_RESTART:-${ECOCLAW_FORCE_GATEWAY_RESTART:-true}}"
recover_stale_openclaw_config_backup
ensure_ecoclaw_plugin_config
sanitize_ecoclaw_plugin_config
validate_openclaw_runtime_config
ensure_openclaw_gateway_running
sanitize_ecoclaw_plugin_config
validate_openclaw_runtime_config

if [[ -z "${PINCHBENCH_DATASET_DIR:-}" && -d "${PINCHBENCH_ROOT}/dataset" ]]; then
  export PINCHBENCH_DATASET_DIR="${PINCHBENCH_ROOT}/dataset"
fi

RESOLVED_MODEL="$(resolve_model_alias "${MODEL_LIKE}")"
RESOLVED_JUDGE="$(resolve_model_alias "${JUDGE_LIKE}")"
RESOLVED_SUITE="${SUITE:-${TOKENPILOT_SUITE:-${ECOCLAW_SUITE:-automated-only}}}"
RESOLVED_RUNS="${RUNS:-${TOKENPILOT_RUNS:-${ECOCLAW_RUNS:-3}}}"
RESOLVED_TIMEOUT="${TIMEOUT_MULTIPLIER:-${TOKENPILOT_TIMEOUT_MULTIPLIER:-${ECOCLAW_TIMEOUT_MULTIPLIER:-1.0}}}"
RESOLVED_PARALLEL="${PARALLEL:-${TOKENPILOT_PARALLEL:-${ECOCLAW_PARALLEL:-1}}}"
RESOLVED_SESSION_MODE="${SESSION_MODE:-${TOKENPILOT_SESSION_MODE:-${ECOCLAW_SESSION_MODE:-isolated}}}"

OUTPUT_DIR="${PINCHBENCH_ROOT}/save/${RESOLVED_SESSION_MODE}/method/raw"
LOG_DIR="${PINCHBENCH_ROOT}/save/logs"
REPORT_DIR="${PINCHBENCH_ROOT}/save/reports"
RUN_TAG="$(date +%Y%m%d_%H%M%S)"
RUN_LOG_PREFIX="${LOG_DIR}/pinchbench_method_${RUN_TAG}"
RUN_LOG_FILE="${RUN_LOG_PREFIX}_generate.log"
EVAL_LOG_FILE="${RUN_LOG_PREFIX}_eval.log"
EVAL_JSONL_FILE="${RUN_LOG_PREFIX}_eval.jsonl"
RUN_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mkdir -p "${OUTPUT_DIR}" "${LOG_DIR}" "${REPORT_DIR}"
export PINCHBENCH_EVAL_LOG_FILE="${EVAL_LOG_FILE}"
export PINCHBENCH_EVAL_JSONL_FILE="${EVAL_JSONL_FILE}"

PLUGIN_TRACE_FILE="${HOME}/.openclaw/ecoclaw-plugin-state/task-state/trace.jsonl"
GATEWAY_LOG_FILE="/tmp/openclaw_gateway.log"
TRACE_TAIL_PID=""
GATEWAY_TAIL_PID=""

cleanup_live_debug_tails() {
  if [[ -n "${TRACE_TAIL_PID}" ]]; then
    kill "${TRACE_TAIL_PID}" >/dev/null 2>&1 || true
    wait "${TRACE_TAIL_PID}" >/dev/null 2>&1 || true
    TRACE_TAIL_PID=""
  fi
  if [[ -n "${GATEWAY_TAIL_PID}" ]]; then
    kill "${GATEWAY_TAIL_PID}" >/dev/null 2>&1 || true
    wait "${GATEWAY_TAIL_PID}" >/dev/null 2>&1 || true
    GATEWAY_TAIL_PID=""
  fi
}

run_method_exit_cleanup() {
  cleanup_live_debug_tails
}

start_live_debug_tails() {
  mkdir -p "$(dirname "${PLUGIN_TRACE_FILE}")"
  : > "${PLUGIN_TRACE_FILE}"
  (
    stdbuf -oL tail -n 0 -F "${PLUGIN_TRACE_FILE}" 2>/dev/null \
      | python3 -u -c '
import json, sys
interesting = {
    "task_state_estimator_applied",
    "registry_driven_eviction_evaluated",
    "canonical_eviction_closure_checked",
    "canonical_eviction_applied",
    "canonical_state_sync",
    "canonical_state_rewrite",
}
for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    if obj.get("stage") not in interesting:
        continue
    print("[plugin-trace] " + json.dumps(obj, ensure_ascii=False), flush=True)
' || true
  ) &
  TRACE_TAIL_PID=$!

  touch "${GATEWAY_LOG_FILE}"
  (
    stdbuf -oL tail -n 0 -F "${GATEWAY_LOG_FILE}" 2>/dev/null \
      | python3 -u -c '
import sys
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if "ecoclaw" not in line.lower() and "plugin-runtime" not in line.lower():
        continue
    print("[gateway-log] " + line, flush=True)
' || true
  ) &
  GATEWAY_TAIL_PID=$!
}

BENCH_ARGS=(
  --model "${RESOLVED_MODEL}"
  --judge "${RESOLVED_JUDGE}"
  --suite "${RESOLVED_SUITE}"
  --runs "${RESOLVED_RUNS}"
  --parallel "${RESOLVED_PARALLEL}"
  --session-mode "${RESOLVED_SESSION_MODE}"
  --timeout-multiplier "${RESOLVED_TIMEOUT}"
  --output-dir "${OUTPUT_DIR}"
)

DATASET_DIR="$(resolve_dataset_dir)"
cd "${DATASET_DIR}"
start_live_debug_tails
trap 'run_method_exit_cleanup' EXIT
uv run scripts/benchmark.py "${BENCH_ARGS[@]}" 2>&1 | tee "${RUN_LOG_FILE}"
cleanup_live_debug_tails

echo "Run log saved to: ${RUN_LOG_FILE}"
if [[ -f "${EVAL_LOG_FILE}" ]]; then
  echo "Eval log saved to: ${EVAL_LOG_FILE}"
fi
if [[ -f "${EVAL_JSONL_FILE}" ]]; then
  echo "Eval jsonl saved to: ${EVAL_JSONL_FILE}"
fi

RESULT_JSON="$(latest_json_in_dir "${OUTPUT_DIR}" || true)"
if [[ -n "${RESULT_JSON}" ]]; then
  COST_REPORT_FILE="${REPORT_DIR}/method_${RUN_TAG}_cost.json"
  REDUCTION_TRACE_FILE="${HOME}/.openclaw/ecoclaw-plugin-state/ecoclaw/reduction-pass-trace.jsonl"
  REDUCTION_REPORT_FILE="${REPORT_DIR}/method_${RUN_TAG}_reduction_passes.json"
  generate_cost_report_and_print_summary "${RESULT_JSON}" "${COST_REPORT_FILE}"
  generate_reduction_pass_report_and_print_summary "${REDUCTION_TRACE_FILE}" "${REDUCTION_REPORT_FILE}" "${RUN_START_ISO}"
else
  echo "Cost report skipped: no result JSON found in ${OUTPUT_DIR}" >&2
fi
