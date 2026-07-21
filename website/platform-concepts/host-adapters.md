# Host Adapters

A host adapter is the **integration layer** between an agent host (OpenClaw, Codex, Claude Code) and the LightMem2 core runtime. It translates host-specific events, APIs, and configuration into the standardized format that plugins expect.

## Why Adapters Exist

Agent hosts differ in:

- **Event models**: how they signal session start, message received, tool called, session end
- **Configuration**: where and how settings are stored (JSON, TOML, env vars)
- **Context APIs**: how the prompt/context is assembled and sent to the model
- **Hook systems**: how external code can intercept or modify behavior

The adapter abstracts these differences so plugins only deal with one consistent interface.

## Adapter Responsibilities

```text
┌────────────────────────────────────────────┐
│                Host Adapter                 │
├────────────────────────────────────────────┤
│  1. Event translation                      │
│     Host-specific events → standard events  │
├────────────────────────────────────────────┤
│  2. Configuration integration              │
│     Reads host config, merges with plugin   │
│     config, writes back when needed         │
├────────────────────────────────────────────┤
│  3. Context interception                    │
│     Hooks into the host's context pipeline  │
│     so plugins can read/modify context      │
├────────────────────────────────────────────┤
│  4. Proxy / Gateway                         │
│     When the host doesn't support native    │
│     hooks, the adapter runs a local proxy   │
├────────────────────────────────────────────┤
│  5. CLI surface                             │
│     Exposes host-specific commands through  │
│     the shared lightmem2 CLI                │
└────────────────────────────────────────────┘
```

## Current Adapters

| Host | Adapter Location | Integration Style |
| :-- | :-- | :-- |
| OpenClaw | `components/adapters/openclaw/` | Native plugin slot + restart |
| Codex | `components/adapters/codex/` | Local proxy + hooks |
| Claude Code | `components/adapters/claude-code/` | Local gateway + MCP |

## Integration Patterns

### Native Plugin Slot (OpenClaw)

The host itself provides a plugin mechanism. The adapter registers as a plugin and receives events directly.

### Proxy/Gateway (Codex, Claude Code)

When the host doesn't have native plugin support, the adapter runs as a **local proxy** that sits between the host and the model API. It intercepts requests, applies plugin transformations, and forwards the modified context.

The proxy pattern enables:
- Full context visibility without host modifications
- Consistent behavior across hosts with different internals
- Graceful degradation if the proxy is stopped

## Adapter Lifecycle

1. **Install**: Write config files, register hooks, set up proxy autostart
2. **Start**: Proxy/gateway starts, hooks activate
3. **Run**: Events flow through adapter → core → plugins → adapter → host
4. **Stop**: Gateway shuts down, hooks deactivate
5. **Uninstall**: Config files restored from `.tokenpilot.bak` backups

## Next

- [Host Compatibility](/hosts/compatibility) — which features work on which host
- [Adding a New Host](/host-adapter-development/adding-new-host) — build your own adapter
- [Adapter Architecture](/host-adapter-development/adapter-architecture) — deep dive
