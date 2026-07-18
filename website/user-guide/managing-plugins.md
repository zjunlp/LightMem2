# Managing Plugins

Plugins are the core unit of functionality in LightMem2. This page covers how to list, inspect, and manage installed plugins.

## List Installed Plugins

```bash
lightmem2 status
```

Shows all installed plugins and their state.

## Check Plugin Details

```bash
lightmem2 status --details
```

Shows per-plugin configuration, mode, and runtime state.

## Plugin States

| State | Meaning |
| :-- | :-- |
| **Enabled** | Plugin is loaded and active |
| **Disabled** | Plugin is installed but not running |
| **Error** | Plugin failed to load — check logs |

## Switching the Default Host

```bash
lightmem2 use openclaw
lightmem2 use codex
lightmem2 use claude-code
```

This sets the default host for hostless commands like `lightmem2 report`.

## Pinning a Session

```bash
lightmem2 use codex session <session-id>
```

Subsequent `lightmem2 report` and `lightmem2 visual` commands will target this session.

## Checking Current Context

```bash
lightmem2 context
```

Shows:
- Current default host
- Pinned session ID
- Config target

## Next

- [Enabling and Disabling Plugins](/user-guide/enabling-disabling)
- [Plugin Configuration](/user-guide/plugin-configuration)
- [CLI Reference](/user-guide/cli-reference)
