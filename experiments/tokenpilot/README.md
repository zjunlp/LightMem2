# TokenPilot Experiments

This directory is the experiment hub for the current TokenPilot component in
LightMem2.

Use the root [README.md](../../README.md) first if you still need to:

- install the repository
- install the component
- verify the runtime path in a real session

Use [../README.md](../README.md) for the top-level experiment entry across the
repository.

## Benchmarks

The current public experiment surface includes:

| Benchmark | Scope | Docs |
| :-- | :-- | :-- |
| `PinchBench` | runtime cost and quality evaluation in isolated and continuous session modes | [pinchbench/README.md](./pinchbench/README.md) |
| `Claw-Eval` | OpenClaw task execution evaluation in isolated and continuous session modes | [claw-eval/README.md](./claw-eval/README.md) |

## Recommended Workflow

1. Finish the installation and quick-start flow in the root [README.md](../../README.md).
2. Confirm the current TokenPilot runtime path works in a real session on the host you plan to use for the benchmark.
3. Pick the benchmark you want from the table above.
4. Follow that benchmark README for assets, environment setup, and official commands.

## Notes

- This directory is a landing page, not a duplicate of the benchmark manuals.
- Harnesses install the OpenClaw release through the root
  `pnpm plugin:install:release` command and load the user-state copy from
  `~/.openclaw/extensions/tokenpilot`. They do not depend on the removed
  monolithic component source parent.
- Large benchmark datasets and experiment outputs are stored outside Git.
- Use [experiments/README.md](../README.md) for the shared Google Drive layout
  and external storage policy.
- Exact benchmark scripts, assets, and caveats stay inside each benchmark subtree.
