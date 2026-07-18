# Context Eviction

Context eviction **limits how much old context is carried forward** as sessions grow. Without eviction, a session that runs for dozens of turns accumulates all of them, growing the context window indefinitely.

## Why Eviction Matters

In long-running sessions:
- Turn 50 still carries messages from Turn 1
- The cost per turn increases as the session grows
- Eventually the session hits context window limits
- The model wastes attention on stale history

Eviction provides **lifecycle-aware pruning** — it removes old context that is unlikely to be relevant to the current turn.

## How Eviction Works

TokenPilot's eviction is **turn-count and token-threshold based**, not content-based:

1. Track how many turns have been processed
2. When the turn count or token count exceeds the threshold
3. Remove the oldest turns from the context
4. Keep more recent turns intact

```text
Session after 20 turns (with eviction):
[ Turns 1-5: Evicted ] [ Turns 6-20: Present ]

Session after 20 turns (without eviction):
[ Turns 1-20: All present — large and growing ]
```

## Mode Thresholds

| Mode | Eviction | Threshold |
| :-- | :-- | :-- |
| Conservative | Off | N/A |
| Normal | On | Standard |
| Aggressive | On | Lower (evicts sooner) |

## Controlling Eviction

```bash
# Toggle eviction
lightmem2 eviction on
lightmem2 eviction off

# In OpenClaw
/lightmem2 eviction on
```

## When to Disable Eviction

- **Short sessions** (under ~15 turns): eviction may not trigger anyway
- **Debugging**: you need the full history for investigation
- **Sequential workflows**: later turns depend heavily on very early context

## View Eviction Status

The visual inspector shows what was evicted:

```bash
lightmem2 visual
```

The eviction view shows:
- Current turn count and token count
- Eviction threshold
- How many turns have been evicted
- Per-turn eviction decisions

## Next

- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — cache optimization
- [Context Reduction](/plugin-catalog/tokenpilot/context-reduction) — trimming tool output
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — see all metrics
