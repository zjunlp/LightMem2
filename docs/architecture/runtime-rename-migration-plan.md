# Runtime Rename Migration Plan

## Goal

Define how to migrate the remaining `ecoclaw` runtime identifiers without
breaking:

- installed OpenClaw plugin runtimes
- benchmark scripts
- persisted state paths
- workspace package imports
- old experiment artifacts and logs

This plan is intentionally separate from brand-layer cleanup.

## Scope

This plan only covers runtime-facing names such as:

- plugin id
- context-engine id
- provider prefix
- environment-variable prefixes
- workspace package names
- persisted state / marker strings

It does not cover README or documentation-only wording.

## Current High-Risk Runtime Surface

### Plugin/runtime ids

- plugin id: `ecoclaw`
- context-engine id: `ecoclaw-context`
- provider namespace: `ecoclaw/*`

### Environment variables

- `ECOCLAW_*`

### Workspace package imports

- `@ecoclaw/kernel`
- `@ecoclaw/layer-history`
- `@ecoclaw/layer-decision`
- `@ecoclaw/runtime-core`

### Persisted paths and markers

- `~/.openclaw/ecoclaw-plugin-state`
- `stateDir/ecoclaw/...`
- `.ecoclaw-archives`
- `[ecoclaw persisted tool_result]`
- `[EcoClaw Recovery Protocol]`
- `ecoclaw-pfx-*`

## Design Rule

The migration should be:

1. dual-read
2. dual-register where possible
3. single-write only after compatibility is established
4. legacy-removal only after repeated smoke validation

Do not do a global search-and-replace rename.

## Migration Phases

### Phase 1: Add Neutral Or New Aliases

Introduce support for the new runtime naming surface without removing old
names.

Target aliases:

- plugin-facing brand alias: `tokenpilot`
- context-engine alias: `tokenpilot-context`
- provider alias: `tokenpilot/*`
- env aliases: `TOKENPILOT_*`

Rules:

- old names remain fully supported
- new names are accepted in config and scripts
- docs begin preferring new names only after they are validated

### Phase 2: Adapter-Level Compatibility

Update the OpenClaw adapter to accept both old and new names.

Expected changes:

- register both provider aliases if OpenClaw allows it
- accept both context-engine ids where possible
- read both `ECOCLAW_*` and `TOKENPILOT_*`
- prefer new values when both are present

If full dual registration is impossible at the host API level, keep old runtime
ids and only dual-read config/env values first.

### Phase 3: Workspace Package Transition

Migrate package names separately from runtime ids.

Recommended strategy:

1. add temporary bridge packages or tsconfig path aliases
2. switch internal imports gradually
3. only then rename package manifests

This should be treated as a repository build migration, not a plugin-runtime
migration.

### Phase 4: Persisted State Strategy

Persisted names and markers need a compatibility policy.

Preferred order:

1. keep reading old locations and markers
2. keep writing old locations during the transition
3. only switch writes after repeated compatibility validation
4. optionally add a one-time migrator later

Do not change persisted markers and directory basenames in the same batch as
provider/context-engine renames.

### Phase 5: Legacy Removal

Only after all earlier phases are stable:

- stop documenting old names
- stop generating old aliases in new configs
- remove legacy support gradually

## Recommended Alias Policy

### Provider prefix

If OpenClaw provider registration supports multiple ids:

- register both `ecoclaw/*` and `tokenpilot/*`

If not:

- keep runtime registration as `ecoclaw/*`
- only introduce `tokenpilot/*` later with a host-specific migration

### Context engine

Preferred:

- support both `ecoclaw-context` and `tokenpilot-context`

Fallback:

- keep `ecoclaw-context` registered
- only expose `tokenpilot-context` in docs after explicit adapter support lands

### Environment variables

Dual-read policy:

- read `TOKENPILOT_*` first
- fallback to `ECOCLAW_*`

This is the safest runtime rename step and should happen early.

### Package names

Do not rename all `@ecoclaw/*` packages in one batch.

Preferred order:

1. add bridge alias support in local paths/build config
2. migrate imports
3. rename package manifests
4. validate workspace install/build everywhere

## Validation Matrix

Each phase should end with a concrete validation pass.

### Static validation

- `pnpm -C packages/kernel typecheck`
- `pnpm -C packages/layers/history typecheck`
- `pnpm -C packages/layers/decision typecheck`
- `pnpm -C packages/runtime-core typecheck`
- `pnpm -C packages/openclaw-plugin typecheck`

### Build validation

- `pnpm -C packages/layers/history build`
- `pnpm -C packages/runtime-core build`
- `pnpm -C packages/openclaw-plugin build`

### Runtime install validation

- `pnpm -C packages/openclaw-plugin install:release`
- `openclaw config validate`

### Benchmark smoke validation

Run at minimum:

1. method + continuous + first 3 tasks
2. baseline + continuous + first 3 tasks
3. method + isolated + first 3 tasks
4. baseline + isolated + first 3 tasks

### Runtime behavior checks

Confirm:

- provider registration still works
- context-engine slot still resolves
- `input + cache` accumulates in continual mode
- transcript lock issue does not regress
- canonical rewrite / eviction trace still appears
- `memory_fault_recover` registration still works

## What To Avoid

Do not combine these into one commit series:

1. workspace package rename
2. provider/context-engine rename
3. persisted marker rename
4. path/layout rename
5. env dual-read support

These need separate review and validation.

## Recommended Next Concrete Step

The safest runtime rename work to start with is:

1. add dual-read support for `TOKENPILOT_*` alongside `ECOCLAW_*`
2. keep all runtime ids unchanged
3. validate benchmark smoke

After that, evaluate whether provider/context-engine dual registration is even
possible in the host runtime.

## Summary

The rename is now blocked not by architecture, but by compatibility risk.

The project is ready for a staged runtime rename, but only if it proceeds in
this order:

1. env alias support
2. adapter compatibility
3. package import migration
4. persisted state strategy
5. legacy removal
