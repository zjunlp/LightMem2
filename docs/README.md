# Documentation

This directory tracks the current TokenPilot architecture, migration notes, and
runtime operating guidance.

Benchmark execution still lives in a separate harness today. The long-term
target is to consolidate that material under the top-level `experiments/`
directory in this repo.

## Architecture

- [Overview](architecture/overview.md) - 3-layer architecture, key distinctions
- [Canonical Design](architecture/canonical-design.md) - Transcript/canonical/eviction design
- [Plugin Semantic Grouping](architecture/plugin-semantic-grouping.md) - Current semantic buckets for plugin modules
- [Plugin Semantic Regroup Plan](architecture/plugin-semantic-regroup-plan.md) - Future semantic facades and regroup strategy
- [Plugin Script Inventory](architecture/plugin-script-inventory.md) - Status of plugin-side helper scripts
- [Runtime ID Inventory](architecture/ecoclaw-runtime-id-inventory.md) - Current `ecoclaw` naming surface and migration risk classes
- [Experiments Consolidation Plan](architecture/experiments-consolidation-plan.md) - How benchmark assets should merge into `experiments/`
- [Runtime-Neutral Contracts Plan](architecture/runtime-neutral-contracts-plan.md) - Contract split between `kernel`, `layers`, `runtime-core`, and host adapters
- [OpenClaw Plugin Extraction Inventory](architecture/openclaw-plugin-extraction-inventory.md) - Current boundary between adapter-only code, extracted shared logic, and mixed request-preprocessing surfaces
- [Runtime Rename Migration Plan](architecture/runtime-rename-migration-plan.md) - Staged compatibility plan for renaming plugin ids, provider prefixes, env vars, package names, and persisted markers
- [PinchBench Experiments README](../experiments/pinchbench/README.md) - Narrowed first-pass experiments merge target

## Plans

- [Eviction Implementation Plan](plans/eviction-plan.md) - Task-level eviction implementation
- [Reduction Plan](plans/reduction-plan.md) - Reduction layer refactor plan

## Experiments

- [Estimator Mode Comparison](experiments/estimator-mode.md) - Sliding window vs completed summary modes
- [Observations Source](../exp/) - Raw observation files from experiments
- [Experiments Placeholder](../experiments/README.md) - Planned home for future benchmark/evaluation assets

## Bug Reports

- [Bug Reports Index](bug-reports/index.md) - All documented bugs with severity, root cause, resolution

## Run Guide

- [Run Guide](run-guide.md) - Plugin development workflow, runtime sync, verification, pre-run checklist, common issues

## Scripts

- [Smoke Test Gateway](scripts/smoke_isolated_gateway.sh) - Isolated gateway smoke test

## Deleted/Archived

Old documentation from `EcoClaw_read_before_exe/`:
- `bug.txt` - consolidated into `bug-reports/index.md`
- `notice.txt` - integrated into `run-guide.md` (operational notes) and `bug-reports/index.md`
- `plan.txt` - older phase plan, removed after later architecture refactors
- `progresss.txt` - older status log, removed after later continual/eviction refactors
- `reduction_plan.txt` - moved to `plans/reduction-plan.md`
- `SupervisorAgent.txt` - archived, reference only (not current architecture)
- `task_plan.txt` - moved to `plans/eviction-plan.md`
- `PICHAY.txt` - old design reference, removed from the active docs index
- `notice_background.txt` - archived (background context, not current design)

