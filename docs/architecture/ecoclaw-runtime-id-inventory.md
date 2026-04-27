# Legacy `ecoclaw` Runtime Naming Inventory

## Purpose

This document records the remaining legacy `ecoclaw` naming surface after the
adapter split into:

- `packages/kernel`
- `packages/layers/*`
- `packages/runtime-core`
- `packages/openclaw-plugin`

The goal is not to rename everything immediately. The goal is to separate:

1. high-risk runtime identifiers
2. low-risk internal names
3. documentation and log wording

## Current Structure Context

The codebase is no longer one large plugin package. The naming surface now
spans four layers:

1. `kernel`
2. `layers`
3. `runtime-core`
4. `openclaw-plugin`

That split matters because some `ecoclaw` names are now:

- adapter-only runtime ids
- shared workspace package names
- persisted path / artifact markers
- purely historical or display-only wording

## Class A: High-Risk Runtime IDs

These identifiers are part of the live runtime contract. They should not be
changed during a simple brand refresh.

### Plugin identity

- [openclaw.plugin.json](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/openclaw.plugin.json)
  - active id is now `tokenpilot`
- [package.json](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/package.json)
  - active package name is now `tokenpilot`
- [index.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/index.ts)
  - runtime registration now uses `id: "tokenpilot"`

### Context-engine identity

- [context-engine.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/context-engine.ts)
  - `id: "layered-context"`
- [index.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/index.ts)
  - `api.registerContextEngine("layered-context", ...)`

### Provider namespace

- [proxy-provider.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/proxy-provider.ts)
  - provider `id: "tokenpilot"`
  - registration of `tokenpilot/*`
- [upstream.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/upstream.ts)
  - mirrored model keys under `tokenpilot/<model>`
- [README.md](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/README.md)
  - documented runtime model prefix `tokenpilot/<model>`

### Environment-variable prefixes

- [config.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/config.ts)
  - `ECOCLAW_TASK_STATE_ESTIMATOR_*`
- [upstream.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/upstream.ts)
  - `ECOCLAW_UPSTREAM_*`
- [archive-paths.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/runtime-core/src/archive-recovery/archive-paths.ts)
  - `ECOCLAW_STATE_DIR`
- [common.sh](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/experiments/pinchbench/scripts/common.sh)
  - runtime setup still depends on many `ECOCLAW_*`

### State directory and artifact layout

- [config.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/config.ts)
  - default state dir `~/.openclaw/ecoclaw-plugin-state`
- [archive-paths.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/runtime-core/src/archive-recovery/archive-paths.ts)
  - `.ecoclaw-archives`
  - `stateDir/ecoclaw/tool-result-archives/...`
- [canonical-eviction.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/page-out/canonical-eviction.ts)
  - `stateDir/ecoclaw/canonical-eviction/...`
- [trace/io.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/trace/io.ts)
  - `stateDir/ecoclaw/forwarded-inputs/...`
  - `stateDir/ecoclaw/reduction-pass-trace.jsonl`
- [proxy-runtime.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/proxy-runtime.ts)
  - `stateDir/ecoclaw/proxy-requests.jsonl`
  - `stateDir/ecoclaw/proxy-responses.jsonl`
- [turn-bindings.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/session/turn-bindings.ts)
  - `stateDir/ecoclaw/controls/recent-turn-bindings.json`

### Prompt / payload / persisted markers

These are protocol markers, persisted content markers, or stable cache-key
formats. Renaming them carelessly would break compatibility or invalidate
persisted state.

- [recovery-protocol.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/page-in/recovery-protocol.ts)
  - `[Recovery Protocol]`
  - `__ecoclaw_reduction_applied`
  - `__ecoclaw_replay_raw`
- [reduction-context.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/request-preprocessing/reduction-context.ts)
  - `[persisted tool result]`
- [tool-result-persist.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/runtime-core/src/archive-recovery/tool-result-persist.ts)
  - preview / persist markers containing `ecoclaw`
- [stable-prefix.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/request-preprocessing/stable-prefix.ts)
  - `runtime-pfx-*`
- [upstream.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/upstream.ts)
  - `__UPSTREAM_CURL_STATUS__`

### Workspace package names

This migration has already landed. The active package namespace is now:

- [packages/kernel/package.json](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/kernel/package.json)
  - `@tokenpilot/kernel`
- [packages/layers/history/package.json](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/layers/history/package.json)
  - `@tokenpilot/history`
- [packages/layers/decision/package.json](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/layers/decision/package.json)
  - `@tokenpilot/decision`
- [packages/runtime-core/package.json](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/runtime-core/package.json)
  - `@tokenpilot/runtime-core`

So workspace package names are no longer part of the live legacy `ecoclaw`
runtime surface.

## Class B: Internal Low-Risk Names

These are internal names that can be changed without a runtime compatibility
migration, as long as normal build and smoke validation still pass.

### Internal code symbols already neutralized

- `PluginRuntimeConfig`
- `createPluginContextEngine`
- `RUNTIME_EVENTS_METADATA_KEY`
- `RUNTIME_EVENT_TYPES`
- `__runtime_optimizer_embedded_proxy_runtime__`

These are examples of the right direction: remove brand coupling without
touching live runtime ids.

### Remaining low-risk log wording

- [runtime-register.ts](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/packages/openclaw-plugin/src/context-stack/integration/runtime-register.ts)
  - policy monitor log labels
- [common.sh](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/experiments/pinchbench/scripts/common.sh)
  - config/setup status wording

These can be normalized to `plugin-runtime` or other neutral labels without
changing runtime contracts.

## Class C: Brand/Documentation Surface

These references are mostly wording, explanation, or host-product naming. They
can continue to change as the project branding changes.

### Project and migration docs

- [README.md](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/README.md)
- [docs/run-guide.md](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/docs/run-guide.md)
- [docs/tokenpilot-migration-plan.md](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/docs/tokenpilot-migration-plan.md)
- [docs/bug-reports/index.md](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/docs/bug-reports/index.md)
- [docs/architecture/openclaw-plugin-extraction-inventory.md](/mnt/20t/xubuqiang/EcoClaw/TokenPilot/docs/architecture/openclaw-plugin-extraction-inventory.md)

### Host-product references

References to `OpenClaw` are not necessarily bad. Many of them are accurate
host-runtime references, not project-brand references. Examples:

- plugin runtime host badges in the main README
- `OpenClaw` runtime setup in run guides
- benchmark tasks that explicitly mention OpenClaw artifacts

These should only be changed when the wording is about our method or product,
not when it accurately refers to the host runtime.

## What To Avoid In The Next Rename Pass

Do not mix these into one batch:

1. brand wording cleanup
2. low-risk internal symbol cleanup
3. runtime-id migration

Only the first two belong in the next pass.

## Recommended Rename Order

### Phase 1

- keep cleaning docs / README / display wording
- neutralize low-risk logs and internal helper names

### Phase 2

- define alias and fallback strategy for runtime ids
- decide how to migrate persisted paths and markers

### Phase 3

- migrate plugin id, provider prefix, context-engine id, env prefixes, and
  package names
- revalidate with:
  - `openclaw config validate`
  - plugin build / typecheck
  - benchmark method smoke
  - benchmark baseline smoke

## Summary

At this point the ugly part of the old name is concentrated in runtime
contracts, workspace package names, persisted state paths, and compatibility
markers.

That means the project is in a good position for:

1. one more low-risk branding pass now
2. a separate runtime-id migration later

Those should remain separate.
