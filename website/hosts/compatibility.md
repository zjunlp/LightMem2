# Host Compatibility

LightMem2 supports three agent hosts. Each host has a different integration style, but the plugin behavior is consistent across all of them.

## Supported Hosts

| Host | Integration | Adapter Location |
| :-- | :-- | :-- |
| [OpenClaw](./openclaw) | Native plugin slot | `components/tokenpilot/adapters/openclaw/` |
| [Codex CLI](./codex) | Local proxy + hooks | `components/tokenpilot/adapters/codex/` |
| [Claude Code](./claude-code) | Local gateway + MCP | `components/tokenpilot/adapters/claude-code/` |

## Feature Matrix

| Feature | OpenClaw | Codex | Claude Code |
| :-- | :-- | :-- | :-- |
| Stable Prefix | ✅ | ✅ | ✅ |
| Context Reduction | ✅ | ✅ | ✅ |
| Context Eviction | ✅ | ✅ | ✅ |
| Visual Inspector | ✅ | ✅ | ✅ |
| Session Reports | ✅ | ✅ | ✅ |
| In-session Commands | ✅ (`/lightmem2`) | — (standalone CLI) | — (standalone CLI) |
| Standalone CLI | ✅ | ✅ | ✅ |
| MCP Recovery Server | — | ✅ | ✅ |
| Auto-start Proxy | ✅ (gateway restart) | ✅ (SessionStart hook) | ✅ (SessionStart hook) |

## Choosing a Host

- **OpenClaw**: Best integration experience — native plugin slot, in-session commands, gateway-level restart.
- **Codex CLI**: Full feature parity via standalone CLI + hooks. Proxy starts on first session.
- **Claude Code**: Full feature parity via standalone CLI + gateway + MCP. Gateway starts on first session.

Plugin behavior (stabilizer, reduction, eviction) is identical regardless of host. The only difference is how you interact with TokenPilot — in-session commands vs. standalone CLI.

## Test Environment

All host pages include the test environment and last verification date.

| Host | Last verified |
| :-- | :-- |
| OpenClaw | 2026-07-16 |
| Codex | 2026-07-16 |
| Claude Code | 2026-07-16 |
