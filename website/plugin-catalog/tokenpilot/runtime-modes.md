# Runtime Modes

TokenPilot provides three runtime modes: **conservative**, **normal**, and **aggressive**. Each is a preset that configures the stabilizer, reduction, and eviction subsystems. Switch modes at any time without restarting.

## Mode Comparison

| Behavior | Conservative | Normal | Aggressive |
| :-- | :-- | :-- | :-- |
| **Stable Prefix** | On | On | On |
| **Stabilizer target** | Developer | Developer | User |
| **Reduction** | Light | Balanced | Strong |
| **Eviction** | Off | On | On (lower threshold) |
| **Risk of signal loss** | Very low | Low | Moderate |
| **Token savings** | Moderate | High | Maximum |

## Conservative Mode

For **safety-critical sessions** where you cannot afford to lose any context.

```bash
lightmem2 mode conservative
```

- Stabilizer rewrites context into cache-stable form but keeps it developer-visible
- Reduction applies light trimming only — removes truly redundant output
- Eviction is disabled — full history is always available

**Best for**: debugging, sensitive workflows, first-time use to build confidence.

## Normal Mode

The **default and recommended mode** for most sessions.

```bash
lightmem2 mode normal
```

- Stabilizer rewrites context and attaches dynamic content at the developer level
- Reduction applies balanced trimming — removes noise while keeping signal
- Eviction is enabled with standard thresholds

**Best for**: everyday agent work, long sessions, shared sessions.

## Aggressive Mode

For **maximum savings** when you're willing to trade some context completeness.

```bash
lightmem2 mode aggressive
```

- Stabilizer rewrites context and attaches dynamic content at the user level (further from the model)
- Reduction applies strong trimming — may discard borderline-useful output
- Eviction is enabled with lower thresholds — older context is dropped sooner

**Best for**: very long sessions, cost-sensitive environments, when you've verified quality in normal mode first.

## Switching Modes Mid-Session

You can change modes at any time — no restart needed:

```bash
# Per-host
lightmem2 openclaw mode aggressive
lightmem2 codex mode conservative
lightmem2 claude-code mode normal

# Or inside OpenClaw session
/lightmem2 mode aggressive
```

The new mode takes effect on the next turn.

## How to Choose

1. **Start with normal**. It's the safe default for most users.
2. **If you notice any missing context**, switch to conservative.
3. **If normal works well and you want more savings**, try aggressive.
4. **Check your report** after a few turns to see the impact:

```bash
lightmem2 report
```

Compare token counts and cost across modes to find the right balance for your sessions.

## Next

- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — how stabilization works
- [Context Reduction](/plugin-catalog/tokenpilot/context-reduction) — the trimming pipeline
- [Context Eviction](/plugin-catalog/tokenpilot/context-eviction) — lifecycle-aware pruning
