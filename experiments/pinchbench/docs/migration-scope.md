# PinchBench Consolidation Scope

This document narrows the benchmark merge scope for the first real
consolidation pass.

The goal is not to import the entire external benchmark repository. The goal is
to extract the minimum coherent PinchBench experiment surface that we actively
use.

## Scope For The First Pass

Keep only:

- dataset: `PinchBench`
- settings:
  - `isolated`
  - `continuous`
- method path:
  - current plugin-enabled method runs

Explicitly defer:

- baseline cleanup and revalidation
- `ClawEval`
- `FrontierScience`
- multi-agent / MAS variants
- old one-off ablation wrappers

## Keep / Defer / Drop Inventory

### Keep first

These are the first files and directories worth consolidating into the main
repository:

- `experiments/dataset/pinchbench/tasks/`
- `experiments/dataset/pinchbench/assets/`
- `experiments/dataset/pinchbench/scripts/benchmark.py`
- `experiments/dataset/pinchbench/scripts/lib_agent.py`
- `experiments/dataset/pinchbench/scripts/lib_grading.py`
- `experiments/dataset/pinchbench/scripts/lib_tasks.py`
- `experiments/scripts/run_method.sh`
- `experiments/scripts/common.sh`
- `experiments/scripts/calculate_llm_cost.py`
- benchmark-owned docs such as runtime-profile and run notes

Reason:

- this is the minimum surface needed to preserve the current method path
- it covers both `isolated` and `continuous`
- it avoids immediately dragging in unrelated datasets and legacy wrappers

Important:

- the dataset-side Python files are being moved before they are fully cleaned
- they may still contain historical assumptions inherited from the external
  harness, but the active migrated path has already been reduced to
  single-agent PinchBench execution
- migration first, cleanup second

### Defer

These should not move in the first executable pass:

- `experiments/dataset/pinchbench/scripts/lib_upload.py`
- `experiments/scripts/run_pinchbench_baseline.sh`
- `experiments/scripts/run_pinchbench_methods.sh`
- `experiments/scripts/run_pinchbench_methods_mas.sh`
- `experiments/scripts/run_pinchbench_agentswing.sh`
- top-level ad-hoc wrappers under `scripts/`
- saved benchmark artifacts under `save/`
- historical result trees under `results/`

Reason:

- baseline is currently known-bad and needs a separate cleanup
- multi-agent and MAS flows are not part of the narrowed scope
- the ad-hoc wrappers reflect historical experiment practice rather than the
  future harness shape

### Drop when moving

These should not be migrated into the main repo benchmark surface:

- `experiments/dataset/pinchbench/.venv/`
- `experiments/dataset/pinchbench/scripts/__pycache__/`
- `experiments/dataset/pinchbench/benchmark.log`
- benchmark repo root `log/`
- benchmark repo root `results/`
- benchmark repo root `save/`
- one-off root scripts like `run_1.sh` ... `run_7.sh`

Reason:

- they are local artifacts, caches, or historical wrappers
- importing them would make the new structure look canonical when it is not

## Target Layout Inside The Main Repo

For the narrowed PinchBench scope, the immediate target should be:

```text
experiments/
  pinchbench/
    README.md
    docs/
      runtime-profile.md
      migration-scope.md
    dataset/
      assets/
      tasks/
      scripts/
    scripts/
      run_method.sh
      common.sh
      calculate_llm_cost.py
    save/
      isolated/
      continuous/
```

## Migration Order

### Step 1

Move benchmark-owned docs/profile first.

### Step 2

Move PinchBench dataset assets, task files, and dataset-side Python helpers.

### Step 3

Move the method-path wrapper scripts for:

- `isolated`
- `continuous`

### Step 4

Only after the above is stable, revisit:

- baseline
- other datasets
- result/save history

## Validation Before Moving Executable Code

Before moving runnable PinchBench harness code, revalidate:

1. 3-task continual smoke still passes on the method path
2. isolated method smoke still passes
3. `task_22` explicit `new_session` still grades correctly
4. judge setup still avoids global runtime config mutation
5. the migrated paths no longer assume a sibling `EcoClaw-Bench` checkout
