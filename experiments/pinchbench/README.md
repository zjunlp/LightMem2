# PinchBench Experiments

This directory is the future home for the PinchBench experiment harness inside
the main repository.

At the current stage, the migration scope is intentionally narrow:

- dataset: `PinchBench` only
- settings: `isolated` and `continuous`
- method path: current plugin-enabled method runs

Out of scope for the first consolidation pass:

- baseline cleanup and revalidation
- `ClawEval`
- `FrontierScience`
- multi-agent / MAS variants
- legacy wrapper scripts that were only used for old ablations

The migration is now in an intermediate state:

- dataset tasks and assets have already been copied here
- dataset-side Python harness files have already been copied here
- the active single-agent method path now runs from this subtree
- baseline remains deferred and is not part of the migrated canonical path

## Current Contents

- `docs/runtime-profile.md`
  - shared runtime profile used by the PinchBench method runs
- `docs/migration-scope.md`
  - keep/defer/drop inventory for the first merge pass
- `docs/layout-plan.md`
  - target subtree structure and directory ownership rules
- `dataset/`
  - current home for:
    - `tasks/`
    - `assets/`
    - `scripts/`
- `scripts/`
  - current home for the cleaned method-path wrapper surface
- `save/`
  - reserved for local run outputs; only directory skeletons should be committed

## Immediate Goal

The first real consolidation target is:

1. keep cleaning the migrated PinchBench wrapper surface
2. keep only:
   - PinchBench
   - isolated mode
   - continuous mode
   - method path only
3. defer baseline, MAS, and other benchmark families until this active path is
   stable
