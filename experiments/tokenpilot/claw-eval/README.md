# Claw-Eval Adapter

This directory contains the OpenClaw execution adapter for the current
LightMem2 runtime path on the `claw-eval` benchmark, using the TokenPilot
component as the active runtime method path.

The current layout is designed to be mostly self-contained inside this repo:

- `scripts/`: runtime adapter entrypoints and execution glue
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

## External data layout

Large Claw-Eval assets are stored outside Git.

Google Drive root:

- <https://drive.google.com/drive/u/0/folders/1AeMW693aMhyBKscUDbaxnrXfvE8aSBXg>

Recommended Drive layout for this benchmark:

```text
LightMem2/
└── TokenPilot/
    ├── experiment-data/
    │   └── claw-eval/
    │       ├── general/
    │       └── tasks/
    └── experiment-results/
        └── claw-eval/
```

Local mount points in this repository:

- `experiments/tokenpilot/claw-eval/dataset/general/`
- `experiments/tokenpilot/claw-eval/dataset/tasks/`

See:

- [dataset/general/README.md](dataset/general/README.md)

When you prepare a fresh machine:

1. download `general/` from Drive
2. copy its contents into `dataset/general/`
3. download `tasks/` from Drive
4. copy it back under `dataset/tasks/`

## Official runners

The recommended public runner surface is intentionally small:

- `scripts/run_baseline.sh`
- `scripts/run_method.sh`

These are the main entrypoints for reproduction.

### Baseline

Minimal isolated baseline smoke:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_baseline.sh \
  --scope suite \
  --suite T001zh_email_triage \
  --session-mode isolated \
  --model gpt-5.4-mini
```

Run all `general` tasks in isolated baseline mode:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_baseline.sh \
  --scope general \
  --session-mode isolated \
  --model gpt-5.4-mini
```

### Method

Minimal isolated method smoke:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_method.sh \
  --scope suite \
  --suite T001zh_email_triage \
  --session-mode isolated \
  --profile reduction \
  --model lightmem2/gpt-5.4-mini
```

Run all `general` categories in continuous method mode:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_method.sh \
  --scope general \
  --session-mode continuous \
  --profile plugin \
  --by-category \
  --model lightmem2/gpt-5.4-mini
```

If your primary OpenClaw config is read-only or you want run-local isolation,
add `--tmp-openclaw`:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_method.sh \
  --scope general \
  --session-mode continuous \
  --profile plugin \
  --by-category \
  --tmp-openclaw \
  --model lightmem2/gpt-5.4-mini
```

## Legacy wrappers

`run/` still contains a small set of compatibility wrappers for older internal
entrypoints. New usage should prefer `scripts/run_baseline.sh` and
`scripts/run_method.sh`.

## Current state

What is in good shape:

- task loading and suite selection
- isolated execution path
- continuous execution path
- upstream grader bridge
- vendored upstream runtime code
- vendored mock service plugins
- repo-internal default paths for code, mock services, plugins, and `general` assets
- unified baseline/method runner surface

What is still operationally sensitive:

- OpenClaw plugin/config state in `~/.openclaw/openclaw.json`
- provider stability / request timeouts
- duplicate plugin ids from previously installed local extensions
- plugin continuous experiments with the current TokenPilot component reduction/eviction/estimator enabled
- large fixture synchronization between local working copies and the shared Drive mirror

## Known pitfalls

### 1. `dataset/general/` must be populated
If the flat `general` bundle is missing, file-backed tasks will fail.

### 2. OpenClaw config pollution
Previous runs can leave stale plugin allowlists or entries in `~/.openclaw/openclaw.json`.
This can break both `claw-eval` and `pinchbench` runs.
If you want a safer run-local copy, use `--tmp-openclaw` on the official runners.

### 3. Duplicate plugin ids
If the same plugin exists both in the vendored `plugins/` directory and in a previously installed OpenClaw extension path, OpenClaw may warn about duplicate plugin ids.

### 4. Provider/runtime stability is separate from repository layout
A repo-internal smoke can still fail because of provider timeouts or runtime environment issues even when all local paths are correct.

## Related docs

- [docs/rollout.md](docs/rollout.md)
- [docs/supported-tasks.md](docs/supported-tasks.md)
