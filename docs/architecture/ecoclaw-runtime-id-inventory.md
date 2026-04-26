# `ecoclaw` Runtime ID Inventory

This document records the remaining live `ecoclaw` naming surface after the
first TokenPilot brand-layer cleanup.

The goal is not to rename everything immediately. The goal is to classify what
still exists, why it exists, and what migration risk each class carries.

## Classification

### Class A: Runtime/Internal IDs That Must Stay Stable For Now

These identifiers are part of the live runtime contract. Changing them would
require config migration, compatibility fallback, and smoke validation.

#### Plugin identity

- [openclaw.plugin.json](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/openclaw.plugin.json)
  - `id = "ecoclaw"`
- [package.json](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/package.json)
  - `name = "ecoclaw"`
- [index.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/index.ts)
  - runtime registration still uses `id: "ecoclaw"`

#### Context engine identity

- [context-engine.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/context-engine.ts)
  - `id: "ecoclaw-context"`
- [index.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/index.ts)
  - `api.registerContextEngine("ecoclaw-context", ...)`

#### Provider namespace

- [proxy/provider.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/provider.ts)
  - provider `id: "ecoclaw"`
  - registration of `ecoclaw/*`
- [proxy/upstream.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/upstream.ts)
  - mirrored model keys under `ecoclaw/<model>`
- [README.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/README.md)
  - documented runtime model prefix `ecoclaw/<model>`

#### Environment variable prefix

- [config.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/config.ts)
  - `ECOCLAW_TASK_STATE_ESTIMATOR_*`
- [proxy/upstream.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/upstream.ts)
  - `ECOCLAW_UPSTREAM_*`
- [execution/archive-recovery/archive-paths.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/execution/archive-recovery/archive-paths.ts)
  - `ECOCLAW_STATE_DIR`
- [docs/scripts/smoke_isolated_gateway.sh](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/docs/scripts/smoke_isolated_gateway.sh)
  - benchmark/runtime smoke script still depends on `ECOCLAW_*`

#### State directory and artifact layout

- [config.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/config.ts)
  - default state dir `~/.openclaw/ecoclaw-plugin-state`
- [canonical/state.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/canonical/state.ts)
  - `stateDir/ecoclaw/canonical-state/...`
- [tool-results/persist.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/tool-results/persist.ts)
  - `stateDir/ecoclaw/artifacts/...`
- [trace/io.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/trace/io.ts)
  - `stateDir/ecoclaw/forwarded-inputs/...`
  - `stateDir/ecoclaw/reduction-pass-trace.jsonl`
- [proxy/runtime.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/runtime.ts)
  - `stateDir/ecoclaw/proxy-requests.jsonl`
  - `stateDir/ecoclaw/proxy-responses.jsonl`
- [session/turn-bindings.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/session/turn-bindings.ts)
  - `stateDir/ecoclaw/controls/recent-turn-bindings.json`

#### Prompt / payload protocol markers

These are not just names. They are protocol markers in payloads and recovery
paths, so changing them carelessly would break compatibility.

- [recovery/protocol.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/protocol.ts)
  - `[EcoClaw Recovery Protocol]`
  - `__ecoclaw_reduction_applied`
  - `__ecoclaw_replay_raw`
- [proxy/reduction-context.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/reduction-context.ts)
  - `[ecoclaw persisted tool_result]`
- [tool-results/persist.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/tool-results/persist.ts)
  - preview/persist markers containing `ecoclaw`

#### Package/workspace names

- [packages/kernel/package.json](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/kernel/package.json)
  - `@ecoclaw/kernel`
- [packages/layers/history/package.json](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/layers/history/package.json)
  - `@ecoclaw/layer-history`
- [packages/layers/decision/package.json](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/layers/decision/package.json)
  - `@ecoclaw/layer-decision`

These package names are also runtime-adjacent because imports across the
workspace depend on them.

## Class B: Code-Level Names That Can Eventually Gain TokenPilot Aliases

These names are mostly internal symbols. They can be migrated with a normal
refactor after the runtime ID layer has a compatibility plan.

#### Types and factories

- [config.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/config.ts)
  - `PluginRuntimeConfig`
- [context-engine.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/context-engine.ts)
  - `createPluginContextEngine`

#### Event names and metadata keys

- [packages/kernel/src/events.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/kernel/src/events.ts)
  - `RUNTIME_EVENTS_METADATA_KEY`
  - `RUNTIME_EVENT_TYPES`

#### Test fixtures and helper names

- [reduction-proxy.test.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/reduction-proxy.test.ts)
  - `bench-ecoclaw-*`
  - `ecoclaw-pfx-*`

These do not need to be renamed now, but they do not need permanent
preservation either.

#### Internal singleton keys

- [runtime/register.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/runtime/register.ts)
  - internal embedded-proxy singleton key already moved to the neutral
    `__runtime_optimizer_embedded_proxy_runtime__`

## Class C: Logging, Comments, and Historical References

These are the lowest-risk `ecoclaw` references. They are not config keys or
protocol markers, but many still provide useful continuity while the runtime ID
remains unchanged.

#### Logger prefixes

- [runtime/register.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/runtime/register.ts)
  - `[plugin-runtime] ...`
- [proxy/runtime.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/runtime.ts)
  - `[plugin-runtime] ...`
- [proxy/upstream.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/proxy/upstream.ts)
  - `[plugin-runtime] ...`
- [recovery/tool.ts](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/packages/openclaw-plugin/src/recovery/tool.ts)
  - `[plugin-runtime] ...`

These have already been moved off the brand-specific `[ecoclaw]` prefix without
changing config semantics.

#### Historical docs and bug reports

- [docs/bug-reports/index.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/docs/bug-reports/index.md)
- [docs/tokenpilot-migration-plan.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/docs/tokenpilot-migration-plan.md)
- [docs/run-guide.md](/mnt/20t/xubuqiang/EcoClaw/EcoClaw/docs/run-guide.md)

Many of these references are preserved intentionally because they describe old
run names, old paths, or current machine layout.

## What Not To Rename During Brand-Layer Migration

Do **not** rename these as part of a simple brand refresh:

1. plugin id
2. context engine id
3. provider prefix
4. environment variable prefix
5. state directory basename
6. payload/recovery protocol markers
7. workspace package names

Those belong to a dedicated compatibility migration.

## Recommended Next Step For Runtime Rename

When the project is ready to rename runtime identifiers:

1. add `TokenPilot` aliases first
2. keep `ecoclaw` as fallback during transition
3. revalidate:
   - `openclaw config validate`
   - plugin build/typecheck
   - continual baseline smoke
   - continual method smoke
4. only then consider removing old identifiers
