# Reduction Plan - 2026-04-17

## Current Problem: Data Flow Breakpoints

### Problem 1: Duplicate passIds
- `policy.ts` (decision layer) calls 8 analyzers, outputs `beforeCallPassIds`, `afterCallPassIds`, `instructions`
- `openclaw-plugin/src/index.ts` manually constructs 300+ lines, overwrites with toggle-based `beforeCallPassIds`
- `execution/reduction/index.ts` reads `beforeCallPassIds`/`afterCallPassIds`, ignores `segmentIds` and `parameters`

### Problem 2: Plugin bypasses decision layer
- Proxy endpoint constructs `turnCtx` before `PolicyModule.beforeBuild()` runs
- Plugin manually fills `beforeCallPassIds` to make execution work
- Decision layer result never gets used

## Principle
Plugin should not make decisions, only read decisions and execute.

## Solution

1. `passToggles` map to `PolicyModuleConfig` reduction flags at module initialization
2. Delete manual `beforeCallPassIds` and `reductionInstructions` construction from plugin
3. Plugin only passes `reduction.enabled: true`, let decision layer decide which passes to run

## Implementation

### File 1: openclaw-plugin/src/index.ts
Delete (~300 lines):
- `passToggles` parsing (lines 998-1006)
- `addReductionInstructions` function (lines 1074-1108)
- `reductionInstructions` append logic
- Manual `beforeCallPassIds` construction (lines 1258-1263)
- `instructions: reductionInstructions` passing (line 1264)

Change: proxy endpoint `turnCtx.metadata.policy.decisions.reduction` only has `enabled: true`, no `beforeCallPassIds`

### File 2: packages/layers/execution/src/composer/reduction/index.ts
No change needed - reads `beforeCallPassIds`, plugin will fill via decision layer

### File 3: packages/layers/decision/src/policy.ts
No change needed - `beforeBuild` already correctly outputs `beforeCallPassIds`

## Risks

1. **Plugin-specific logic loss**: `enableHtmlSlimming` in `passToggles` is plugin-specific. But `analyzeToolPayloadTrim` internally detects HTML and uses html slimming, so decision layer covers this.

2. **User dynamic control**: User's ability to dynamically toggle passes via `/ecoclaw` command may be lost. Need to support per-request config override or event mechanism.

## Steps

1. Delete `addReductionInstructions` and related logic from plugin
2. Map `passToggles` to `PolicyModuleConfig` reduction flags as initialization config
3. Proxy endpoint only passes `reduction.enabled: true`
4. Run tests to confirm reduction tests still pass
