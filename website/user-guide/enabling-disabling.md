# Enabling and Disabling Plugins

Plugins can be enabled and disabled at runtime without uninstalling them.

## Enable a Plugin

```bash
# Per host
lightmem2 openclaw plugin tokenpilot enable
lightmem2 codex plugin tokenpilot enable
lightmem2 claude-code plugin tokenpilot enable
```

The plugin starts processing on the next turn.

## Disable a Plugin

```bash
lightmem2 openclaw plugin tokenpilot disable
lightmem2 codex plugin tokenpilot disable
lightmem2 claude-code plugin tokenpilot disable
```

The plugin stops processing immediately. Current session state is preserved.

## Master Toggle (TokenPilot)

TokenPilot also supports a quick global toggle:

```bash
lightmem2 stabilizer off      # Disable stable prefix only
lightmem2 reduction off       # Disable reduction only
lightmem2 eviction off        # Disable eviction only
```

To disable TokenPilot entirely, turn off all three subsystems.

## When to Disable

- **Debugging unexpected model behavior**: Rule out plugin interference
- **Short sessions**: Plugin overhead may not justify the savings
- **Testing**: Compare with/without TokenPilot

## Check Current State

```bash
lightmem2 status
```

Shows which plugins are enabled and their current mode.

## Next

- [Plugin Configuration](/user-guide/plugin-configuration) — per-plugin settings
- [Sessions](/user-guide/sessions) — session management
