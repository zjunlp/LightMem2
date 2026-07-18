# Plugins

Plugins are **reusable agent capabilities** that run on the LightMem2 platform. Each plugin provides one well-scoped capability — context management, memory, or future features — and works across all supported hosts.

## Plugin Model

A plugin is a self-contained package with:

| Component | Description |
| :-- | :-- |
| **Manifest** | Metadata: ID, version, compatible hosts, permissions needed |
| **Configuration schema** | Declares what settings the plugin accepts, with types and defaults |
| **Lifecycle hooks** | Functions called by the runtime at specific points (install, enable, disable, etc.) |
| **Runtime logic** | The actual behavior: intercepting messages, transforming context, managing state |

## Current Plugins

| Plugin | Capability | Status |
| :-- | :-- | :-- |
| [TokenPilot](/plugin-catalog/tokenpilot/overview) | Cache-aware context management | Stable |
| Memory Plugin | Long-term memory | <span class="badge-experimental">experimental</span> |

## Plugin Specification

::: warning Under development
The formal plugin specification (unique IDs, versioning, compatibility ranges, dependency rules, and security declarations) is being defined by the core team. The sections below describe the current working model based on the TokenPilot implementation.
:::

### Plugin Identity

- Each plugin has a **unique ID** (e.g., `tokenpilot`)
- Plugins declare a **version** following semver
- Plugins declare **compatible LightMem2 core versions**

### Host Compatibility

A plugin declares which hosts it supports. TokenPilot currently supports:

- OpenClaw
- Codex
- Claude Code

A plugin may support a subset of hosts. The runtime checks compatibility at load time.

### Data Access

Plugins declare what data they need to read and write. This is used for:

- Permission prompts during install
- Conflict detection between plugins
- Privacy and security review

TokenPilot, for example, reads:
- Message history and tool outputs
- Session metadata
- Configuration files

And writes:
- Modified context (stable-prefix rewriting)
- Session metrics and reports
- Configuration state

## What Makes a Good Plugin

- **Single responsibility**. One plugin, one capability. Compose, don't overload.
- **Host-independent**. Core logic should not import host-specific APIs.
- **Declarative config**. Expose settings through a typed schema, not ad-hoc env vars.
- **Observable**. Export metrics so users can see what the plugin is doing.

## Next

- [Plugin Lifecycle](/platform-concepts/plugin-lifecycle) — the state machine
- [TokenPilot Overview](/plugin-catalog/tokenpilot/overview) — see a real plugin
- [Build Your First Plugin](/plugin-development/build-your-first-plugin) — start developing
