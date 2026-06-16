# Experiments

This directory contains the benchmark adapters and reproduction entrypoints for
the current LightMem2 runtime path.

If you want to reproduce the reported runtime behavior rather than just install
the plugin, start here.

## What lives here

The public experiment surface is organized by benchmark:

- [`pinchbench/`](./tokenpilot/pinchbench/README.md)
  - LightMem2 runtime baseline/method runners for PinchBench
  - isolated and continuous session modes
- [`claw-eval/`](./tokenpilot/claw-eval/README.md)
  - LightMem2 OpenClaw runtime adapter for Claw-Eval
  - isolated and continuous execution paths

Each benchmark subtree owns its own:

- dataset assets
- benchmark-specific scripts
- environment notes
- benchmark README

## Before you reproduce anything

Complete the root-level runtime setup first:

1. follow the installation instructions in the repository [README.md](../README.md)
2. make sure `openclaw` is already runnable in your shell
3. confirm that the current TokenPilot runtime component is installed and usable
4. verify that a `tokenpilot/<model>` route can answer in a real session

The benchmark directories assume the runtime path is already working.

## Recommended workflow

1. Choose the benchmark you want to reproduce.
2. Open the benchmark-specific README.
3. Prepare any benchmark-only assets that are intentionally not committed.
4. Run the official baseline or method runner from that subtree.

The canonical public entrypoints are:

- `experiments/tokenpilot/pinchbench/scripts/run_baseline.sh`
- `experiments/tokenpilot/pinchbench/scripts/run_method.sh`
- `experiments/tokenpilot/claw-eval/scripts/run_baseline.sh`
- `experiments/tokenpilot/claw-eval/scripts/run_method.sh`

## Benchmark index

### PinchBench

See:

- [experiments/tokenpilot/pinchbench/README.md](./tokenpilot/pinchbench/README.md)

What it currently covers:

- `PinchBench`
- `isolated` mode
- `continuous` mode
- baseline runs
- method runs through the TokenPilot component

Minimal examples:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/pinchbench/scripts/run_baseline.sh \
  --suite automated-only \
  --session-mode isolated \
  --model gpt-5.4-mini
```

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/pinchbench/scripts/run_method.sh \
  --suite automated-only \
  --session-mode continuous \
  --model tokenpilot/gpt-5.4-mini
```

### Claw-Eval

See:

- [experiments/tokenpilot/claw-eval/README.md](./tokenpilot/claw-eval/README.md)

What it currently covers:

- `claw-eval` task execution through the repo-internal LightMem2 OpenClaw runtime adapter
- isolated and continuous paths
- vendored upstream runtime glue

Minimal examples:

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_baseline.sh \
  --scope suite \
  --suite T001zh_email_triage \
  --session-mode isolated \
  --model gpt-5.4-mini
```

```bash
cd /path/to/LightMem2
bash experiments/tokenpilot/claw-eval/scripts/run_method.sh \
  --scope suite \
  --suite T001zh_email_triage \
  --session-mode isolated \
  --profile reduction \
  --model tokenpilot/gpt-5.4-mini
```

## Notes

- The root README gives the public project overview.
- This directory is the top-level entry for experiment reproduction.
- Exact benchmark commands, asset requirements, and pitfalls are documented in
  each benchmark subtree, not duplicated here in full.
