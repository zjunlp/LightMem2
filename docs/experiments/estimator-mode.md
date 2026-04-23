# Estimator Mode Comparison Experiment

## Background

Current task-state estimator uses a "sliding window" input approach:
- Only takes `lastProcessedTurnSeq` + fixed `batchTurns` of incremental turns
- Combines with existing registry as history
- Model determines: new tasks, completed tasks, evictable tasks

Problem: When estimator sees only local window, it may lack cross-turn continuity evidence, causing:
- Task granularity too fine
- Eviction targets unstable
- Completed task paging frequency abnormally high

## Two Modes to Compare

### Mode A: Sliding Window

- Input: fixed number of incremental turns from `lastProcessedTurnSeq + 1`
- Completed task history not re-expanded, only uses registry state

**Pros**: Low cost, stable input length, simple
**Cons**: Loses task continuity, splits long tasks into many subtasks

### Mode B: Completed Summary + Active Turns

- Still uses fixed `batchTurns` as update frequency
- But input has two parts:
  1. Compressed summary of completed tasks
  2. Full turn set of active/unresolved tasks

**Pros**: Task boundaries more stable, less fragmentation
**Cons**: Higher token cost

## Expected Outcomes

1. Mode A produces finer task fragmentation
2. Mode B produces coarser, more stable task boundaries
3. Mode B more suitable for eviction decisions (evicts complete tasks, not fragments)

## Implementation

Config option:
```json
{
  "taskStateEstimator": {
    "enabled": true,
    "batchTurns": 5,
    "inputMode": "sliding_window"
  }
}
```

Values: `sliding_window` or `completed_summary_plus_active_turns`

Both modes share same estimator API / registry merge / lifecycle patch logic.
