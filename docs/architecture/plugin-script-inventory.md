# Plugin Script Inventory

## Purpose

This document records the current status of scripts under:

```text
packages/openclaw-plugin/scripts/
```

The goal is to separate:

- active release helpers
- removed legacy helpers

from benchmark/evaluation concerns that should stay outside the plugin package.

## Active Release Helpers

These are still part of the package install/release path and should remain
discoverable:

- `/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/scripts/pack_release.sh`
- `/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/scripts/install_release.sh`

Package script bindings:

- `npm run pack:release`
- `npm run install:release`

## Removed Legacy Acceptance Helpers

The following legacy plugin-local acceptance helpers have been removed:

- `scripts/e2e.sh`
- `scripts/cache_acceptance.sh`
- `scripts/acceptance_report.sh`
- `scripts/semantic_e2e.sh`
- `scripts/summary_e2e.sh`
- `fixtures/responses-cache-bridge-session.jsonl`

Reason:

- they were no longer part of the published plugin payload
- they were no longer exposed as package scripts
- the canonical benchmark/evaluation flow belongs outside this package

The canonical benchmark/evaluation flow now belongs outside this package, and
in the future should move into the main repo under `experiments/`.

## Cleanup Guidance

Near-term guidance:

1. keep release helpers intact
2. keep benchmark documentation and benchmark runtime setup out of this package

Later cleanup options:

1. rename release helpers if the package-facing command surface changes again
2. move any remaining benchmark-like flows into the top-level `experiments/`
   tree once the benchmark harness is consolidated
