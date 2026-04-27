# TokenPilot Migration Plan

This document defines how to migrate the current codebase from its legacy
project brand into the `TokenPilot` brand without breaking the existing
runtime, benchmark pipeline, or historical experiment assets.

The migration should be staged. Do not attempt a global legacy-name ->
`TokenPilot` replacement in one pass.

## Goal

The target end state is:

- repository brand: `TokenPilot`
- benchmark/evaluation assets colocated under the main repository
- runtime semantics preserved during the rename
- old experiment scripts and environment variables kept compatible during the transition

The most important constraint is continuity:

- existing benchmark scripts must keep running
- existing OpenClaw plugin installs must not silently break
- old result paths and old logs must remain interpretable

## Rename Boundary Rule

Treat renaming as two separate layers:

1. brand layer
2. runtime/internal identifier layer

Brand-layer changes are expected to happen more than once. Runtime/internal
identifier changes should be rare.

This means:

- README titles, repository names, documentation headings, figure labels, and
  benchmark writeups may change again later
- persisted/runtime ids such as `ECOCLAW_*`, legacy state-path basenames,
  protocol markers, and archive path basenames should stay stable until there
  is a dedicated compatibility migration

If a later rename is needed, repeat the brand-layer process first. Do not start
with runtime/global replacement.

## Migration Strategy

The migration should happen in four phases.

### Phase 1: Brand Layer

This phase only changes outward-facing branding.

Scope:

- repository name
- README title and description
- docs titles and project references
- badges, taglines, and figure labels
- benchmark documentation references

What should **not** change yet:

- plugin id
- context engine id
- provider prefix
- environment variable prefixes
- runtime config keys
- result directory layout

Reason:

This phase is low risk and immediately aligns the project identity without disrupting the execution path.

### Phase 2: User Entry Layer

This phase introduces `TokenPilot` naming at user-facing entrypoints while preserving compatibility aliases.

Scope:

- shell script names
- install guide naming
- public benchmark entrypoints
- docs examples

Rules:

- add new `tokenpilot-*` names first
- keep old legacy aliases during the transition
- do not remove old scripts until the new names have been validated in real runs

Example:

- add `run_tokenpilot_*.sh`
- keep old runtime wrapper aliases working until the new entrypoints are validated

### Phase 3: Runtime/Internal Rename

This phase changes code-level and runtime identifiers.

Scope:

- plugin id: `tokenpilot`
- context engine: `layered-context`
- provider prefix: `tokenpilot/*`
- env vars: `ECOCLAW_*`
- default result labels
- log prefixes

This is the most dangerous phase.

It should only begin after Phase 1 and Phase 2 are stable.

Rules:

- add compatibility fallback before removing old names
- prefer dual-read / single-write transitions
- only remove old names after smoke validation passes

Example:

- support `TOKENPILOT_*` with fallback to `ECOCLAW_*`
- prefer neutral runtime ids such as `layered-context` over new brand-bound ids

### Phase 4: Repository Consolidation

This phase moves benchmark assets into the main repository.

Target direction:

- main repository: `TokenPilot`
- benchmark assets under:
  - `experiments/dataset/...`
  - `experiments/scripts/...`
  - `experiments/results/...`
  - `experiments/save/...`

Current recommendation:

- do not move the current benchmark harness immediately
- first stabilize the brand rename in the main repository
- then migrate benchmark assets once path assumptions are documented

## What Must Stay Stable During Migration

The following runtime invariants must remain valid throughout the transition:

1. OpenClaw config validates successfully
2. plugin install path resolves correctly
3. context engine slot points to a registered engine
4. provider routing still reaches the intended upstream
5. benchmark continual mode still accumulates context across tasks
6. benchmark `new_session` tasks still evaluate correctly
7. judge runs do not mutate global runtime state in a way that triggers reload loops

## Rename Pitfalls Already Observed

The following pitfalls have already appeared during the current transition and
should be treated as reusable check items if the project is renamed again.

1. brand strings and runtime ids are not the same thing
   - changing display names is low risk
   - changing plugin id / provider prefix / context engine id is not

2. benchmark-side paths and main-repo paths drift easily
   - docs can accidentally hardcode the current sibling repository layout
   - future docs should describe the benchmark harness generically unless the
     path itself is the point

3. runtime config can become inconsistent if only one side of a rename changes
   - example: disabling a plugin entry while leaving a slot pointed at its
     context engine
   - always re-run `openclaw config validate`

4. historical result labels should not be rewritten in place
   - old run names and result directories remain part of the experiment record
   - prefer documenting equivalence instead of rewriting history

5. benchmark entrypoints need explicit compatibility policy
   - old script names may remain temporarily
   - new docs should still point to the new brand

## Quick Check Matrix

Each migration phase should end with a concrete verification pass.

### A. Config Check

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/openclaw.json openclaw config validate
```

Expected:

- `Config valid`

### B. Plugin Build Check

```bash
pnpm -C packages/openclaw-plugin typecheck
pnpm -C packages/openclaw-plugin build
```

Expected:

- typecheck succeeds
- build succeeds

### C. Runtime Install Check

Confirm:

- extension exists under `~/.openclaw/extensions/...`
- configured context engine matches the installed plugin
- the configured provider prefix resolves to the correct upstream

Recommended commands:

```bash
jq '.plugins.entries,.plugins.slots,.models.providers' ~/.openclaw/openclaw.json
```

### D. Baseline Continual Smoke

Run a baseline continual smoke on:

- `task_20_eli5_pdf_summary`
- `task_21_openclaw_comprehension`
- `task_22_second_brain`

Expected:

- session mode is `continuous`
- provider is the intended baseline provider
- `input_tokens + cache_read_tokens` grows across tasks
- `task_22` still handles explicit `new_session`

### E. TokenPilot Runtime Smoke

Run the same 3-task continual smoke with:

- plugin enabled
- estimator enabled
- eviction disabled

Expected:

- continual accumulation still holds
- `task_22` grading still succeeds
- no gateway reload loop during judge runs

### F. Full Benchmark Check

Before removing any compatibility name:

1. run one continual baseline full
2. run one continual reduction full
3. run one continual eviction full

Expected:

- all three complete normally
- result JSONs are written
- provider and session semantics match expectations

## Migration Order Recommendation

Use the following order.

1. rename the main repository brand to `TokenPilot`
2. update main repository README and docs titles
3. add migration docs and compatibility policy
4. add future `experiments/` placeholder in the main repository
5. add new user-facing aliases where needed
6. validate baseline + runtime smokes
7. only then start runtime/internal identifier migration
8. only after that begin merging the benchmark harness into `experiments/`

## Compatibility Policy

During the transition:

- old paths may remain readable
- old script names may remain executable
- old env vars may remain accepted as fallbacks

But new docs should point to the new `TokenPilot` naming.

Recommended rule:

- write new docs with `TokenPilot`
- keep runtime compatible with legacy runtime identifiers until the benchmark pipeline is fully revalidated

## Definition of Done

The rename should only be considered complete when all of the following are true:

- repository branding is consistently `TokenPilot`
- the main runtime passes config validation
- continual baseline and method runs behave correctly
- benchmark assets have a documented home under the main repository
- no critical script still requires legacy branding to function
- compatibility aliases are either intentionally retained or explicitly removed

## Immediate Next Step

The next practical step is:

1. update the main repository README and top-level docs to the `TokenPilot` brand
2. keep runtime/internal names unchanged for now
3. defer benchmark consolidation into `experiments/` until after the rename smoke checks pass
