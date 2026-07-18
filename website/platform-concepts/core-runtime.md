# Core Runtime

The LightMem2 core runtime is the **host-independent execution engine** that loads, manages, and runs plugins. It sits between the agent host and the plugins, providing a consistent environment regardless of which host the user is running.

## Responsibilities

| Responsibility | Description |
| :-- | :-- |
| **Plugin loading** | Discovers, validates, and loads plugins from configured directories |
| **Lifecycle management** | Calls plugin hooks at the right time: install, enable, session start, session end, disable, uninstall |
| **Configuration** | Merges host config, plugin config, and user overrides into a resolved configuration |
| **Event routing** | Dispatches host events (messages, tool calls, session state changes) to plugins |
| **Resource isolation** | Ensures plugins cannot interfere with each other or the host |

## How It Fits Together

```text
┌──────────────────────────────────────────┐
│              Agent Host                   │
│   (OpenClaw / Codex / Claude Code)        │
└────────────────┬─────────────────────────┘
                 │ Host events & messages
┌────────────────▼─────────────────────────┐
│          Host Adapter                     │
│   Translates host-specific events         │
└────────────────┬─────────────────────────┘
                 │ Standardized events
┌────────────────▼─────────────────────────┐
│          Core Runtime                     │
│   Plugin lifecycle · Config · Routing     │
└────┬──────────────┬──────────────┬───────┘
     │              │              │
┌────▼───┐   ┌──────▼──────┐   ┌──▼────────┐
│Plugin A│   │  Plugin B   │   │ Plugin C   │
└────────┘   └─────────────┘   └───────────┘
```

The core runtime never talks to the host directly — it always goes through the host adapter. This is what enables a plugin written once to run on any supported host.

## Key Design Decisions

- **No network dependency**. The runtime runs entirely locally inside the host process or as a sidecar proxy.
- **Plugin isolation**. Plugins don't import each other; communication happens through well-defined events.
- **Configuration cascade**. Defaults → host config → plugin config → user overrides, with later layers taking precedence.

## Current Implementation

The core runtime is implemented across these workspace packages:

| Package | Purpose |
| :-- | :-- |
| `kernel` | Shared types, interfaces, events, and runtime contracts |
| `runtime-core` | Host-agnostic runtime engine and shared execution logic |
| `host-adapter` | Shared host-adapter contracts and path-resolution interfaces |
| `layers/history` | Canonical state, raw semantic turns, task registry |
| `layers/decision` | Policy analysis, reduction/eviction decisions, estimator |
| `layers/memory` <span class="badge-experimental">experimental</span> | Distillation and retrieval (in progress) |

## Next

- [Plugins](/platform-concepts/plugins) — how plugins are structured
- [Plugin Lifecycle](/platform-concepts/plugin-lifecycle) — the plugin state machine
- [Host Adapters](/platform-concepts/host-adapters) — how hosts connect
