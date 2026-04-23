# Task-State / Eviction Decoupling Experiment

## Question

Should the estimator directly predict all three lifecycle states:

- `active`
- `completed`
- `evictable`

Or should we decouple the problem into two stages:

1. estimator predicts only task state progression:
   - `active`
   - `completed`
2. a separate eviction policy decides when `completed -> evictable`

This document records why the decoupled design is worth testing.

## Current Design

Current estimator responsibility is relatively heavy:

- read session delta / task summaries
- identify task boundaries
- decide whether a task is still active
- decide whether a task is completed
- decide whether a completed task is now safe to evict

That means the estimator is simultaneously solving:

- state recognition
- lifecycle transition
- future-access prediction

For a small model, this may be too much in one shot.

## Concern

`active -> completed` and `completed -> evictable` are not the same kind of decision.

### `active -> completed`

This is mostly a local semantic judgment:

- Did the current task finish?
- Has the requested deliverable already been produced?
- Is the agent still working on the same intent?

This is a relatively direct classification problem.

### `completed -> evictable`

This is a different problem:

- Will this task likely be needed again?
- Has the conversation intent already shifted away?
- Is it safe to remove this task from the hot context now?

This is closer to:

- a prediction problem
- or a cache replacement policy problem

So forcing one small model to solve both at once may be unnecessary coupling.

## Why Decoupling May Help

### 1. Lower estimator burden

If the estimator only predicts:

- `active`
- `completed`

then its job becomes much simpler:

- identify task spans
- decide whether a task is still ongoing or already done

This should be easier and more stable for a smaller model.

### 2. More controllable eviction policy

Once a task is marked `completed`, the system can decide eviction separately using simpler or more explicit policies.

Possible `completed -> evictable` policies:

- FIFO / age-based
- fixed lookahead turns
- LLM-as-a-judge
- semantic similarity threshold against recent active intent
- reuse prediction based on recent references

This gives us a cleaner design space:

- task completion recognition
- eviction timing

instead of mixing both into one model output.

### 3. Better fit to our intended architecture

This separation matches the intuition we discussed before:

- `compaction` is closer to an immediate post-completion action
- `eviction` is more asynchronous and policy-driven

That means:

- completion detection belongs near task-state estimation
- eviction belongs near history/cache policy

This is architecturally cleaner.

## Proposed Alternative Design

### Estimator output

Estimator only predicts:

- `active`
- `completed`

No direct `evictable` output.

### Separate eviction layer

Another module promotes:

- `completed -> evictable`

based on a configurable policy.

For the first implementation, we intentionally keep the scope narrow:

1. `fifo`
   - evict oldest completed tasks first

Other policy families such as:

- `lookahead_turns`
- `llm_judge`
- `similarity_threshold`
- `hybrid`

are deferred until the coupled vs decoupled split is validated.

## Hypothesis

We expect decoupling to improve:

- task-state stability
- cache locality
- eviction timing consistency
- small-model robustness

Especially for `batchTurns=1` or very fine-grained estimator updates, this may avoid overloading the estimator with future-access prediction.

## Expected Tradeoff

### Benefits

- simpler estimator prompt and output space
- clearer failure analysis
- easier ablations
- easier to plug in non-LLM eviction policies

### Costs

- one more policy layer
- possible lag between `completed` and `evictable`
- need to define promotion rules carefully

## Suggested Experiment Matrix

### A. Coupled

Estimator outputs:

- `active`
- `completed`
- `evictable`

This is the current design.

### B. Decoupled + FIFO

Estimator outputs:

- `active`
- `completed`

Eviction:

- FIFO over completed tasks

## What To Measure

- benchmark score
- total tokens
- input tokens

## Current Result (2026-04-23)

We now have a first working implementation of:

1. `coupled`
2. `decoupled + fifo`

under the same 10-task continual benchmark setting with:

- `batchTurns = 1`
- task-level canonical eviction enabled
- replacement mode = `drop`

### Compared runs

- `10161`: baseline, no eviction
- `10162`: coupled
- `10163`: decoupled + fifo

### Observed outcome

#### `10162 coupled`

- total tokens: `328,464`
- input tokens: `42,598`
- cache read tokens: `282,624`
- requests: `27`

#### `10163 decoupled + fifo`

- total tokens: `293,785`
- input tokens: `39,417`
- cache read tokens: `251,392`
- requests: `27`

Approximate task-level score sum from `per_task`:

- `10163`: about `9.01 / 10`

### Interpretation

Initial evidence supports the decoupled design:

1. estimator responsibility is cleaner
   - estimator outputs only task progression
   - no direct `evictable` prediction

2. FIFO promotion works as intended
   - keep the newest completed task hot
   - promote older completed tasks to `evictable`
   - trace confirms repeated `eviction_promotion_applied`

3. token usage improved without increasing request count
   - `10163` reduced total tokens by about `10.6%` relative to `10162`
   - request count stayed the same

4. task-level eviction remained active and interpretable
   - promoted tasks were actually consumed by canonical eviction
   - trace shows `canonical_eviction_applied` after FIFO promotion

### Practical conclusion for now

For the current codebase and benchmark setting, `decoupled + fifo` looks more promising than `coupled`:

- simpler estimator prompt
- cleaner ownership boundary
- lower total token usage
- no obvious regression in final task quality

This does not yet prove FIFO is the best long-term policy.
It does show that **decoupling completion detection from eviction timing is a worthwhile direction**.

## Current Recommendation

Use this as the working experimental baseline for the decoupled line:

- `lifecycleMode = "decoupled"`
- `evictionPromotionPolicy = "fifo"`
- `evictionPromotionHotTailSize = 1`

Future work can compare:

1. `hotTailSize = 1` vs `2`
2. `fifo` vs later policies such as `lookahead_turns`
3. different estimator batch sizes under the same decoupled policy

## First Implementation Scope

To keep the change controlled, the first code implementation should support only:

1. `coupled`
   - estimator may emit `evictable`

2. `decoupled + fifo`
   - estimator may emit only:
     - `active`
     - `completed`
   - a separate FIFO promotion layer derives `evictableTaskIds`

Current intended FIFO semantics for the first implementation:

- keep the most recently completed `N` tasks as `completed`
- promote older completed tasks to `evictable` in FIFO order

where:

- `N = evictionPromotionHotTailSize`
- default `N = 1`

This gives decoupled mode a simple and deterministic configurable hot completed tail.

This keeps the first ablation simple and reduces implementation ambiguity.

## Proposed Config Shape

Recommended configuration split:

```json
{
  "taskStateEstimator": {
    "enabled": true,
    "lifecycleMode": "coupled",
    "evictionPromotionPolicy": "fifo"
  }
}
```

Semantics:

- `lifecycleMode = "coupled"`
  - estimator owns `active/completed/evictable`
- `lifecycleMode = "decoupled"`
  - estimator owns only `active/completed`
  - `evictionPromotionPolicy` owns `completed -> evictable`

For the first iteration:

- `coupled`
- `decoupled + fifo`

only.

## Minimal Code Plan

### 1. Estimator prompt/schema

When `lifecycleMode = "decoupled"`:

- estimator prompt must forbid `evictable`
- backend should still defensively coerce accidental `evictable -> completed`

### 2. Policy merge step

After estimator patch is built:

- `coupled`
  - apply patch directly
- `decoupled`
  - apply estimator patch without direct `evictable`
  - run FIFO promotion over completed tasks
  - produce final `evictableTaskIds`

### 3. Execution unchanged

Canonical eviction still reads:

- `registry.evictableTaskIds`

So task-level eviction execution does not need a separate redesign.

## Why FIFO First

FIFO is intentionally simple:

- deterministic
- cheap
- easy to debug
- isolates the effect of decoupling itself

If decoupling already improves stability under FIFO, later policies can be added on top of a cleaner foundation.
- cache read tokens
- number of evicted tasks
- duplicate / unstable task-state transitions
- whether `batchTurns=1` remains pathological

## Current Position

This is worth treating as an explicit experiment, not just an implementation tweak.

Reason:

- it changes the role of the estimator
- it changes where prediction happens
- it may explain why very fine-grained estimator updates currently behave poorly

So this should be tracked as a design ablation:

- coupled lifecycle prediction
- vs decoupled completion + eviction policy
