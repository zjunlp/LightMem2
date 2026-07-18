# Context Reduction

Context reduction **trims oversized tool output** before it pollutes later turns. Large tool responses can dominate the context window without adding proportional value.

## Why Reduction Matters

Agent tools produce varied output. Some tools return concise, useful data. Others return massive JSON blobs, stack traces, or log dumps where only a fraction is relevant.

Without reduction:
- Every byte of tool output stays in the conversation forever
- Future turns pay the token cost of irrelevant past output
- The model wastes attention on noise

With reduction:
- Tool output is trimmed to keep the signal
- The context window stays lean
- The model focuses on what matters

## Reduction Pipeline

TokenPilot's reduction runs a pipeline of passes on each tool result:

| Pass | What It Does | Configurable |
| :-- | :-- | :-- |
| `toolPayloadTrim` | Truncates oversized JSON/text payloads to a reasonable length | Yes |
| (additional passes) | Future passes will be added based on tool type patterns | — |

## Reduction Modes

```bash
lightmem2 reduction mode light     # Conservative trimming
lightmem2 reduction mode balanced  # Default — balanced signal vs. noise
```

| Mode | Behavior | Risk |
| :-- | :-- | :-- |
| `light` | Only removes clearly redundant data | Very low |
| `balanced` | Removes noise while keeping likely-useful data | Low |

## Controlling Reduction

```bash
# Toggle reduction
lightmem2 reduction on
lightmem2 reduction off

# Switch mode
lightmem2 reduction mode balanced

# Enable/disable specific passes
lightmem2 reduction pass toolPayloadTrim off
lightmem2 reduction pass toolPayloadTrim on

# Check current status
lightmem2 reduction status
```

## When to Disable Reduction

Consider disabling reduction if:
- You're debugging and need to see exact tool output
- A tool's output format is misidentified as noise
- You're investigating unexpected model behavior

```bash
lightmem2 reduction off
# ... debug ...
lightmem2 reduction on
```

## View Reduction Effects

The visual inspector shows what was trimmed:

```bash
lightmem2 visual
```

Switch to the reduction view to see per-turn trimming statistics.

## Next

- [Context Eviction](/plugin-catalog/tokenpilot/context-eviction) — pruning old context
- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — cache optimization
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — see all metrics
