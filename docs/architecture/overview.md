# Architecture Overview

## 3-Layer Architecture

```
transcript (raw event source, bottom layer)
    ↓
raw semantic turn (按 user-message boundary切成 turn)
    ↓
canonical (transcript-derived durable rewritten history)
```

- **Transcript**: Raw event source, bottom layer
- **Raw semantic turn**: A group of messages bounded by user-message boundaries
- **Canonical**: Durable rewritten history derived from transcript

## Key Distinctions

- `turn` ≠ `transcript message` (turn is a group, transcript is message-level)
- `seenMessageIds`: transcript ingestion ledger - records which transcript messages have been absorbed into canonical, never deleted on eviction
- `canonical.messages`: current durable history view - can be modified by eviction

## memory_fault_recover vs eviction/reduction

Two different mechanisms:
- **Recovery**: Should NOT go through reduction again, but can be evicted with whole task
- **Eviction/Reduction**: Task-level eviction replaces whole task blocks with stubs

## eviction semantics

- eviction modifies `canonical.messages` but must NOT remove IDs from `seenMessageIds` ledger
- `transcriptMessageStableId()` uses transcript top-level `id` or fallback hash (role, toolCallId, toolName, timestamp, normalizedContent)

## Current Module Structure

- `packages/layers/decision/` - Policy decisions
- `packages/layers/execution/` - Execution layer (reduction, compaction, eviction)
- `packages/openclaw-plugin/` - Plugin implementation

## PICHAY Reference (from old design)

PICHAY was an earlier design with some concepts still relevant:

1. **Tool Definition Stubs**: Replace large JSON Schema with small stubs when tool unused
2. **Retrieval Handles/Tombstones**: Text markers for evicted content `[Paged out: Read /path (X bytes, Y lines). Re-read if needed.]`
3. **Pressure-aware hint injection**: Inject warning when context fills to 60K-100K tokens
4. **Fault-driven pinning**: On fault (re-read same hash), pin the file for session
