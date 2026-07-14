# PinchBench Experiment Scripts

This directory contains the active experiment-side wrappers for the PinchBench
method path inside the main repository.

## Active Surface

- `run_method.sh`
  - single-agent method entrypoint
  - supports `isolated` and `continuous`
- `run_method_by_category_continuous.sh`
  - category-isolated orchestration wrapper
  - runs one continuous session per manifest category
  - useful for measuring within-category memory/distill effects without cross-category leakage
- `run_method_by_category_distill_only.sh`
  - convenience wrapper for category-isolated continuous runs
  - keeps reduction enabled but disables all concrete reduction passes
  - enables estimator + eviction + procedural-memory distill
  - keeps `memory.topK=0` by default so the run measures distill production without retrieval/injection
- `run_method_by_category_distill_inject.sh`
  - convenience wrapper for category-isolated continuous runs
  - keeps reduction enabled but disables all concrete reduction passes
  - enables estimator + eviction + procedural-memory distill
  - enables retrieval/injection by default with `memory.topK=1`
  - injects retrieved memory as a system/developer-side hint by default
- `run_method_isolated_reduction_ablation.sh`
  - isolated-session reduction-pass ablation wrapper
  - runs one variant with all reduction passes disabled
  - runs one variant with all exposed reduction passes enabled
  - creates a dedicated OpenClaw home/state dir and dedicated gateway/proxy ports per variant
- `run_baseline.sh`
  - single-agent baseline entrypoint
  - supports `isolated` and `continuous`
- `common.sh`
  - shared runtime/config helpers for the active method path
- `calculate_llm_cost.py`
  - post-run cost report helper

## Runtime Environment

The active method path expects runtime credentials/config to come from:

1. `experiments/tokenpilot/pinchbench/.env`
2. repo-root `.env`
3. explicit shell exports

Preferred variables are:

- `TOKENPILOT_BASE_URL`
- `TOKENPILOT_API_KEY`
- `TOKENPILOT_MODEL`
- `TOKENPILOT_JUDGE`
- `TOKENPILOT_SUITE`
- `TOKENPILOT_RUNS`
- `TOKENPILOT_TIMEOUT_MULTIPLIER`
- `TOKENPILOT_PARALLEL`
- `TOKENPILOT_SESSION_MODE`
- `TOKENPILOT_FORCE_GATEWAY_RESTART`

Judge routes can be separated from method routes by provider prefix. For
`--judge kuaipao/gpt-5.4-mini`, set:

- `PINCHBENCH_JUDGE_KUAIPAO_BASE_URL`
- `PINCHBENCH_JUDGE_KUAIPAO_API_KEY`

Active runtime variables are:

- `TOKENPILOT_BASE_URL`
- `TOKENPILOT_API_KEY`

Reliability controls for isolated or parallel workers include:

- `PINCHBENCH_GATEWAY_LOG_FILE`: keep each worker's gateway log outside shared `/tmp`
- `PINCHBENCH_FWS_PORT`: assign the worker's FWS API port; its proxy uses the next port
- `PINCHBENCH_CLEANUP_ISOLATED_SERVICES=true`: release worker-owned gateway/FWS ports on exit
- `PINCHBENCH_TRANSIENT_PROVIDER_RETRY_ATTEMPTS`: retry provider-only failures, default `3`
- `PINCHBENCH_TRANSIENT_PROVIDER_RETRY_BASE_DELAY_S`: exponential retry base delay, default `2.0`
- `TOKENPILOT_UPSTREAM_DNS_OVERRIDE=host=address`: optional explicit DNS mapping for a broken upstream resolver path

If you want to use unprefixed model aliases such as `gpt-5.4-mini`, also set:

- `PINCHBENCH_MODEL_PROVIDER_PREFIX`

The migrated mainline resolves the dataset directory in this order:

1. `PINCHBENCH_DATASET_DIR`
2. `experiments/tokenpilot/pinchbench/dataset` in the current repository

Do not point the active method path back to the external bench repository unless
you are explicitly debugging legacy behavior.

If your model strings are already fully qualified (for example
`provider/model-name`), no provider prefix variable is required.

Baseline runs may additionally use:

- `TOKENPILOT_BASELINE_MODEL`
- `TOKENPILOT_BASELINE_JUDGE`
- `TOKENPILOT_BASELINE_SUITE`
- `TOKENPILOT_BASELINE_RUNS`
- `TOKENPILOT_BASELINE_TIMEOUT_MULTIPLIER`
- `TOKENPILOT_BASELINE_PARALLEL`
- `TOKENPILOT_BASELINE_SESSION_MODE`
- `BASELINE_MODEL`
- `BASELINE_JUDGE`
- `BASELINE_PROVIDER_PREFIX`

If unset, the baseline entrypoint defaults to shorthand `gpt-5.4-mini` and
reuses the same provider-prefix resolution path as the method entrypoint.

## Category-Isolated Continuous Runs

`run_method_by_category_continuous.sh` reads `dataset/tasks/manifest.yaml` and
runs each category as its own continuous-session benchmark slice. This is useful
when you want:

- category-level isolation between unrelated task families
- continuous transcript accumulation within a category
- a simple full-benchmark way to test memory distill / retrieval effects

Common envs:

- `PINCHBENCH_CATEGORY_FILTER`
  - comma-separated categories to run
  - example: `meeting_analysis,analysis`
- `PINCHBENCH_CATEGORY_OUTPUT_ROOT`
  - root directory for per-category outputs
- `PINCHBENCH_CATEGORY_RUN_TAG`
  - optional custom run tag

Example:

```bash
TOKENPILOT_MEMORY_TOP_K=1 \
TOKENPILOT_MEMORY_ENABLED=true \
TOKENPILOT_MEMORY_AUTO_DISTILL=true \
TOKENPILOT_SESSION_MODE=continuous \
experiments/tokenpilot/pinchbench/scripts/run_method_by_category_continuous.sh
```

Distill-only example:

```bash
experiments/tokenpilot/pinchbench/scripts/run_method_by_category_distill_only.sh
```

Distill + injection example:

```bash
experiments/tokenpilot/pinchbench/scripts/run_method_by_category_distill_inject.sh
```

Optional env overrides:

- `PINCHBENCH_CATEGORY_FILTER`
- `PINCHBENCH_TMP_ROOT`
- `TOKENPILOT_TASK_STATE_ESTIMATOR_API_KEY`
- `TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS`
- `TOKENPILOT_MEMORY_TOP_K`

## Deferred Surface

The following are intentionally not part of the first active consolidation pass:

- multi-agent / MAS wrappers
- agentswing wrappers
- historical ablation launchers
- compare scripts that assume baseline is already canonicalized here

## Current Rule

For now, this directory should stay focused on the plugin-enabled method path
only. Broader experiment surfaces should be migrated only after the active
PinchBench path is cleaned and revalidated inside the main repository.
