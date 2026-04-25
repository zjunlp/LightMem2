# Plugin Script Inventory

## Purpose

This document records the current status of scripts under:

```text
packages/openclaw-plugin/scripts/
```

The goal is to separate:

- active development helpers
- release helpers
- acceptance helpers

from the benchmark-side experiment harness in `EcoClaw-Bench`.

## Active Release Helpers

These are still part of the package install/release path and should remain
discoverable:

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/pack_release.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/install_release.sh`

Package script bindings:

- `npm run pack:release`
- `npm run install:release`

## Acceptance Helpers

These scripts are still wired into `package.json` and are useful for targeted
plugin-side validation. They are not the main benchmark harness, and they are
not part of the published plugin payload.

- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/e2e.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/cache_acceptance.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/acceptance_report.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/semantic_e2e.sh`
- `/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/scripts/summary_e2e.sh`

Current package script bindings:

- `npm run acceptance:e2e`
- `npm run acceptance:cache`
- `npm run acceptance:report`
- `npm run acceptance:semantic`
- `npm run acceptance:summary`

## Current Assessment

These scripts are not dead code in the narrow sense, because:

- they are still referenced by `package.json`
- some are still referenced by the package README

But they should be treated as:

- plugin-side development tooling
- not as the canonical project evaluation path

The canonical benchmark/evaluation flow now belongs in `EcoClaw-Bench`, and in
the future should move into the main repo under `experiments/`.

The published plugin package should stay narrow:

- runtime files in `dist/`
- `openclaw.plugin.json`
- plugin README

Acceptance helpers and fixtures should remain local development tooling.

## Cleanup Guidance

Near-term guidance:

1. keep release helpers intact
2. keep acceptance helpers available
3. stop expanding these scripts with benchmark-specific logic
4. move benchmark documentation and benchmark runtime setup out of this package

Later cleanup options:

1. rename acceptance scripts to align with the future `TokenPilot` brand
2. trim semantic/summary E2E if those runtime paths are no longer part of the
   supported surface
3. move any remaining benchmark-like flows into the future top-level
   `experiments/` tree
