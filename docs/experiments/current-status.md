# Experiments - 2026-04-22

## Current Status Summary

The system has completed a major architectural refactor (Section 8-11 of observation_4_22.md):

1. **Canonical append source switched**: From `contextEngine.messages` to OpenClaw transcript
2. **Canonical/rewrite decoupling**: Split into `syncCanonicalStateFromTranscript()` and `rewriteCanonicalState()`
3. **Raw semantic turn transcript-only**: Hook events no longer承担 durable main chain responsibility
4. **Append anchor switched**: From length-based to message ID based (using `transcriptMessageStableId()`)

## Key Observations

### memory_fault_recover vs eviction/reduction Distinction

- **reduction chain**: Recovery content should NOT enter reduction again
- **eviction chain**: Recovery content can be evicted with whole task

### Drop Eviction Closure Rule

- `drop` mode is no longer allowed to evict tasks purely by task boundary
- eviction now checks **tool protocol closure** before removing a task bundle
- all `call_id`-linked protocol nodes must be closed inside the candidate task set:
  - assistant `function_call` / nested `tool_call`
  - corresponding `function_call_output` / tool result
  - `memory_fault_recover` call/result are treated exactly the same as normal tool calls
- if a candidate evictable task only contains part of a protocol chain, that task is **deferred**
- practical consequence:
  - recovery content is still protected from reduction/compaction
  - but it is no longer permanently exempt from eviction
  - eviction waits until the whole protocol chain can be removed safely

### Repeated Drop Dips Were Mostly Repeated `t1` Re-evictions

- In the global LLM-call token plots, `drop` runs showed multiple visible prompt dips
- Trace analysis showed these dips were **not** multiple different tasks being evicted in sequence
- Instead, the same early task (usually `t1-task`) was being evicted repeatedly

Root cause:

- `annotateCanonicalMessagesWithTaskAnchors()` was rebinding surviving canonical messages from scratch on every rewrite
- after earlier `user` anchors were removed by eviction, later surviving messages could be reassigned back to the earliest task anchor
- this made subsequent rewrites think those messages still belonged to `t1-task`
- result:
  - repeated `canonical_eviction_applied` entries for `t1-task`
  - repeated visible token drops in the chart
  - but not true progressive multi-task eviction

Current fix status:

- code updated so that messages with an existing valid `turnAbsId/taskIds` anchor keep that anchor
- re-annotation now only fills missing anchors instead of reassigning all surviving messages from scratch
- this fix is implemented and synced to the runtime plugin
- next validation target:
  - `canonical_state_rewrite.afterEvictionMessageCount` should stop collapsing to 0
  - `canonical_eviction_applied.appliedTaskIds` should start showing tasks beyond `t1-task`

### Tu-zi Streaming Compatibility Pitfall

- direct `responses` / `chat.completions` calls to `https://api.tu-zi.com/` work in simple curl tests
- but in our OpenClaw continual run, the transcript showed:
  - assistant `stopReason = "stop"`
  - `content = []`
  - `tool_calls = 0`
  - therefore every task graded as 0
- current working hypothesis:
  - `tu-zi` SSE `response.completed.response.output` can be empty even when earlier `response.output_item.done` carries the actual assistant text
  - our current OpenClaw/EcoClaw parsing path expects final output in `response.completed`
- operational decision for now:
  - revert benchmark upstream back to `kuaipao`
  - keep `tu-zi` as a future compatibility task, not the current experiment baseline

### Continual Bench Issues

- First 4 tasks (01-04) were failing with `session file locked (timeout 10000ms)`
- Root cause: `task_00_sanity` held `.jsonl.lock` after timeout, subsequent tasks hit lock immediately
- Fix: Added `_wait_for_continuous_session_unlock(agent_id)` with 420s default wait

### Progress Grader Log Storm

- Problem: Millions of "Found transcript via sessionFile... (attempt 1)" logs
- Fix: Reload transcript only when `completed_jobs` count changes

### Bug: task-level eviction only inserted stub, didn't replace

- `applyCanonicalEviction()` only prepended stub without replacing original task
- `bundle.firstIndex` was not added to `skipIndexes`
- Fix direction: Need to add `firstIndex` to `skipIndexes` then insert stub at that position

### Bug: canonical prune wrote toolResult.content as string

- Caused second half of continual runs to crash with malformed content

## Division of Work

### User doing
1. transcript incremental append main chain
2. `syncCanonicalState()` splitting
3. afterCall canonical maintenance
4. assemble/before-call canonical consumption

### Me doing
1. eviction apply logic on new canonical
2. task-state/registry progression verification
3. bench regression testing

## Current Minimal Main Chain

```
transcript (.jsonl)
   ↓
after call: extract new messages
   ↓
append to canonical transcript
   ↓
update raw semantic turns / registry
   ↓
execute durable eviction on canonical
   ↓
save canonical state
   ↓
before call / assemble from canonical transcript
```

## Completion Criteria

1. canonical transcript order matches transcript (no user turn reordering/duplication)
2. evictable tasks become canonical stubs
3. next assemble uses evicted canonical
4. does not depend on `contextEngine.messages` for durable append

## Deferred Modules

After eviction main chain stabilizes, will reconnect:
- compaction
- reduction

Using shared:
- transcript append source
- canonical durable rewrite baseline
- before/after call boundaries
