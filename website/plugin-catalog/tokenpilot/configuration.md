# TokenPilot Configuration

TokenPilot settings control how aggressively it manages context. All settings have sensible defaults — you can start without changing anything.

## Core Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `enabled` | `true`, `false` | `true` | Master on/off switch |
| `mode` | `conservative`, `normal`, `aggressive` | `normal` | Preset that controls all sub-policies |
| `logLevel` | `debug`, `info`, `warn`, `error` | `info` | How much detail in logs |

## Mode Presets

Each mode is a preset that configures stabilizer, reduction, and eviction behavior:

| Mode | Stabilizer | Reduction | Eviction | Best For |
| :-- | :-- | :-- | :-- | :-- |
| `conservative` | On (developer target) | Light | Off | Safety-critical sessions |
| `normal` | On (developer target) | Balanced | On | General use |
| `aggressive` | On (user target) | Strong | On (earlier threshold) | Maximum savings |

See [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) for detailed behavior.

## Stabilizer Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `stabilizer.enabled` | `true`, `false` | `true` | Enable stable-prefix rewriting |
| `stabilizer.target` | `developer`, `user` | `developer` | Which message role gets the dynamic content |

## Reduction Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `reduction.enabled` | `true`, `false` | `true` | Enable context reduction |
| `reduction.mode` | `light`, `balanced` | `balanced` | How aggressively to trim |
| `reduction.pass.toolPayloadTrim` | `true`, `false` | `true` | Enable tool output trimming |

## Eviction Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `eviction.enabled` | `true`, `false` | `true` (normal mode) | Enable context eviction |
| `eviction.threshold` | Token count | Mode-dependent | When to start evicting |

## Changing Settings

### Via CLI

```bash
# Change mode (applies the preset)
lightmem2 mode aggressive

# Toggle individual features
lightmem2 stabilizer off
lightmem2 reduction mode light
lightmem2 eviction on
```

### Via Config File

Edit the plugin config file directly (format depends on host):

```json
{
  "enabled": true,
  "mode": "normal",
  "stabilizer": {
    "enabled": true,
    "target": "developer"
  },
  "reduction": {
    "enabled": true,
    "mode": "balanced"
  },
  "eviction": {
    "enabled": true
  }
}
```

Changes take effect on the next turn (no restart needed).

## Next

- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — understand each mode in detail
- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — how stabilization works
- [CLI Reference](/user-guide/cli-reference) — all commands
