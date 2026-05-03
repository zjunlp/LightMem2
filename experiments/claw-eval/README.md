# Claw-Eval Adapter

This directory contains the TokenPilot/OpenClaw execution adapter for the `claw-eval` benchmark.

The current layout is designed to be mostly self-contained inside this repo:

- `scripts/`: TokenPilot adapter entrypoints and runtime glue
- `dataset/tasks/`: local task source of truth
- `dataset/general/`: flat `general` asset bundle location
- `vendor/claw_eval_src/`: vendored upstream `claw_eval` Python package
- `vendor/mock_services/`: vendored upstream mock services
- `plugins/`: vendored `claw-eval-mock-tools*` OpenClaw plugins

## What is already vendored

The adapter no longer requires the external upstream repo checkout at runtime for core execution:

- upstream `src/claw_eval` is vendored under `vendor/claw_eval_src/`
- upstream `mock_services` is vendored under `vendor/mock_services/`
- benchmark mock plugins are vendored under `plugins/`

## Remaining external requirements

A fresh clone is **not** enough by itself. You still need a working OpenClaw runtime environment.

Required environment pieces:

1. OpenClaw installed and usable from the shell
2. a valid OpenClaw home/config, typically under `~/.openclaw/`
3. provider API keys / model routes configured in `openclaw.json`
4. the flattened `general` asset bundle copied into `dataset/general/`

## General asset bundle

The large `general` bundle is intentionally not committed.

Expected location:

- `experiments/claw-eval/dataset/general/`

See:

- [dataset/general/README.md](dataset/general/README.md)

## Minimal smoke command

A minimal isolated smoke from repo-internal paths looks like this:

```bash
cd /path/to/TokenPilot-repo-root
TOKENPILOT_OPENCLAW_HOME=/path/to/openclaw-home \
XDG_CACHE_HOME=/tmp/uv-cache \
UV_CACHE_DIR=/tmp/uv-cache \
PYTHONUNBUFFERED=1 \
uv run --directory TokenPilot/experiments/claw-eval/vendor --with pyyaml \
python -u TokenPilot/experiments/claw-eval/scripts/benchmark.py \
  --tasks-dir TokenPilot/experiments/claw-eval/dataset/tasks \
  --suite T001zh_email_triage \
  --session-mode isolated \
  --parallel 1 \
  --model ecoclaw/gpt-5.4-mini \
  --judge ecoclaw/gpt-5.4-mini \
  --apply-plugin-plan \
  --execute-tasks
```

## Current state

What is in good shape:

- task loading and suite selection
- isolated execution path
- continuous baseline execution path
- upstream grader bridge
- vendored upstream runtime code
- vendored mock service plugins
- repo-internal default paths for code, mock services, plugins, and `general` assets

What is still operationally sensitive:

- OpenClaw plugin/config state in `~/.openclaw/openclaw.json`
- provider stability / request timeouts
- duplicate plugin ids from previously installed local extensions
- plugin continuous experiments with TokenPilot reduction/eviction/estimator enabled

## Known pitfalls

### 1. `dataset/general/` must be populated
If the flat `general` bundle is missing, file-backed tasks will fail.

### 2. OpenClaw config pollution
Previous runs can leave stale plugin allowlists or entries in `~/.openclaw/openclaw.json`.
This can break both `claw-eval` and `pinchbench` runs.

### 3. Duplicate plugin ids
If the same plugin exists both in the vendored `plugins/` directory and in a previously installed OpenClaw extension path, OpenClaw may warn about duplicate plugin ids.

### 4. Provider/runtime stability is separate from repo migration
A repo-internal smoke can still fail because of provider timeouts or runtime environment issues even when all local paths are correct.

## Related docs

- [docs/rollout.md](docs/rollout.md)
- [docs/supported-tasks.md](docs/supported-tasks.md)
