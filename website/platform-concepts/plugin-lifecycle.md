# Plugin Lifecycle

::: warning Under development
The formal plugin lifecycle is being defined by the core team. This page describes the current working model as implemented for TokenPilot.
:::

Every plugin on the LightMem2 platform follows a lifecycle managed by the core runtime. Understanding this lifecycle helps you reason about when your plugin code runs and what state is available.

## Lifecycle States

```text
                    ┌──────────┐
                    │   None   │  Plugin not present on disk
                    └────┬─────┘
                         │ install
                    ┌────▼─────┐
                    │ Installed│  Plugin downloaded/config written
                    └────┬─────┘
                         │ enable
                    ┌────▼─────┐
                    │  Enabled  │  Plugin loaded, hooks registered
                    └────┬─────┘
                    ┌────┴─────┐
                    │           │
               ┌────▼─────┐     │
               │  Running  │     │  Active during a session
               └────┬─────┘     │
                    │           │
                    └────┬─────┘
                         │ disable / uninstall
                    ┌────▼─────┐
                    │ Disabled  │  Plugin unloaded
                    └──────────┘
```

## Lifecycle Hooks

Each transition calls a plugin hook. Plugins implement the hooks they need:

| Hook | Called When | Typical Use |
| :-- | :-- | :-- |
| `onInstall` | Plugin is first installed | Set up config, register with host |
| `onEnable` | Plugin is enabled | Initialize state, start listeners |
| `onSessionStart` | A new agent session begins | Reset per-session state |
| `onMessage` | A message is about to be sent to the model | Modify context, apply policies |
| `onToolResult` | A tool returns a result | Trim output, extract signals |
| `onSessionEnd` | A session ends | Persist state, finalize metrics |
| `onDisable` | Plugin is disabled | Stop listeners, release resources |
| `onUninstall` | Plugin is removed | Clean up config, restore backups |

::: info TokenPilot implementation
TokenPilot's current implementation hooks into the host's event system via the adapter. The hook names above describe the logical lifecycle; the actual implementation uses host-specific mechanisms (OpenClaw plugin slots, Codex hooks, Claude Code MCP + SessionStart).
:::

## Plugin Conflict and Ordering

::: warning Under development
Rules for plugin execution order, conflict detection, and dependency resolution will be defined by the core team before additional plugins are released.
:::

Currently, with only TokenPilot as the single official plugin, execution order is not a concern. When multiple plugins are active:

- Each plugin declares its **execution phase** (e.g., `pre-context`, `context-transform`, `post-response`)
- Plugins in the same phase run in **declared priority order**
- The runtime detects **conflicting data access** and warns or errors at install time

## Next

- [Configuration Model](/platform-concepts/configuration-model) — how plugin config works
- [Build Your First Plugin](/plugin-development/build-your-first-plugin) — implement lifecycle hooks
- [Runtime API](/plugin-development/runtime-api) — the plugin programming interface
