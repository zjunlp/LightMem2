# Plugin Configuration

Each plugin exposes configuration that can be tuned for your needs.

## Viewing Configuration

```bash
lightmem2 status --details
```

Shows the resolved configuration for all plugins.

## Changing Configuration

### Via CLI

```bash
# Mode presets
lightmem2 mode conservative
lightmem2 mode normal
lightmem2 mode aggressive

# Individual settings
lightmem2 stabilizer target developer
lightmem2 reduction mode balanced
lightmem2 eviction on
```

### Via Config File

Edit the plugin config file directly:

```bash
# OpenClaw: ~/.openclaw/openclaw.json
# Codex:    ~/.codex/tokenpilot.json
# Claude:   ~/.claude/tokenpilot.json
```

Format:
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

## Configuration Precedence

1. **CLI flags** (highest priority, per-session)
2. **Environment variables** (per-machine)
3. **Plugin config file** (persistent)
4. **Platform defaults** (lowest priority)

CLI changes typically persist to the config file.

## Reset to Defaults

Delete the plugin config file and re-run the install command:

```bash
rm ~/.codex/tokenpilot.json
npm --prefix components/adapters/codex run install:codex
```

## Next

- [TokenPilot Configuration](/plugin-catalog/tokenpilot/configuration) — TokenPilot-specific settings
- [Configuration Model](/platform-concepts/configuration-model) — platform-level config
