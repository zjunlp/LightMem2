# Eviction Implementation Plan - 2026-04-17

## Goal
- Not copying "Step/Task dual state machine" directly
- Adapt to current EcoClaw architecture: OpenClaw request -> plugin/proxy -> decision metadata -> execution action
- Compaction and eviction share prefix representation layer, but decision/execution independent
- Use decision layer properly, stop writing fake policy in plugin

## Architecture

### 1. Shared Prefix Layer: history-lifecycle
- Location: `packages/layers/execution/src/composer/history-lifecycle/`
- Responsibilities:
  - Build `HistoryBlock[]` from `RuntimeTurnContext.segments`
  - Extract rule signals
  - Calculate base scores (locality/recency/chars/regeneration cost)
- Serves both compaction and eviction

### 2. Decision Layer
- compaction analyzer: outputs `policy.decisions.compaction`
- eviction analyzer: outputs `policy.decisions.eviction`
- Rule-based decision first, not heavy async model arbitration

### 3. Execution Layer
- compaction composer: reads `policy.decisions.compaction`
- eviction composer: reads `policy.decisions.eviction`
- Both reuse `atomic/archive-recovery`

## HistoryBlock

```typescript
interface HistoryBlock {
  block_id: string
  block_type: 'tool_result' | 'write_result' | 'assistant_reply' | 'system_context' | 'summary_seed' | 'pointer_stub'
  segment_ids: string[]
  text: string
  char_count: number
  approx_tokens: number
  created_at: number
  tool_name?: string
  data_key?: string
  consumed_hint?: boolean
  importance?: number
  locality_score?: number
  lifecycle_state: 'ACTIVE' | 'COMPACTABLE' | 'COMPACTED' | 'EVICTABLE' | 'EVICTED_CACHED' | 'EVICTED_DROPPED'
}
```

## Decision Layer Connection

1. plugin/proxy constructs `RuntimeTurnContext` before execution
2. Call decision analyzers:
   - `analyzeCompaction(...)`
   - `analyzeEviction(...)`
3. Write to:
   - `turnCtx.metadata.policy.decisions.compaction`
   - `turnCtx.metadata.policy.decisions.eviction`
4. Execution composer reads decisions and executes

## Phases

### Phase 1 - HistoryBlock
- Define `HistoryBlock` / `LifecycleState`
- Generate blocks from `segments`

### Phase 2 - Decision Layer Upgrade
- Extend compaction analyzer: block-aware output
- Extend eviction analyzer: real instruction generation

### Phase 3 - Execution Composer
- Compaction composer reads `policy.decisions.compaction`
- Eviction composer reads `policy.decisions.eviction`
- Both reuse `archive-recovery`

### Phase 4 - Decision Ledger
- Record compaction/eviction evidence
- Consider small model async boundary detector later

## Not Doing Now
- Step/Task dual state machine
- Full async ModelDetector/Arbitrator framework
- Full reduction migration to policy runtime module
- Session-level summary_fork main flow

## Completion Criteria
- compaction decision truly from decision analyzer, not plugin fake policy
- eviction generates non-empty instructions and real pointer/cache behavior in execution
- compaction + eviction share same `HistoryBlock` and `archive-recovery` infrastructure
- Full chain observable via decision metadata + execution report
