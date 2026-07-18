# Data and Permissions

LightMem2 runs entirely on your machine. Understanding what data is stored, where, and what leaves your machine is important.

## What Data Is Stored Locally

| Data | Location | Purpose |
| :-- | :-- | :-- |
| Configuration files | `~/.openclaw/`, `~/.codex/`, `~/.claude/` | Plugin and host settings |
| Session metrics | In-memory (current session only) | Token counts, cache stats, cost |
| Backup files | `*.tokenpilot.bak` alongside originals | Recovery on uninstall |
| CLI state | `~/.lightmem2/` (if created) | Default host, pinned session |

## What Is NOT Stored

- **Message content**. LightMem2 processes messages in flight but does not persist them.
- **API keys**. Never read, stored, or forwarded.
- **Personal paths or server addresses**. Only config file paths explicitly set via env vars are used.

## What Leaves Your Machine

**Nothing by default.** LightMem2's core runtime and plugins run locally. No telemetry, no analytics, no cloud service.

The only network traffic is what your agent host already sends to the model API (e.g., Anthropic, OpenAI). LightMem2 may modify the context sent in those requests (that's its job), but it does not add new external calls.

## Plugin Data Access

::: warning Under development
The formal permission model for plugins is being defined. The current model is based on what TokenPilot needs.
:::

Each plugin declares its data access requirements. TokenPilot needs to:

| Access | Why |
| :-- | :-- |
| **Read** message history | To compute cache efficiency and apply reduction |
| **Read** tool outputs | To trim oversized results |
| **Read** session metadata | To track session lifecycle |
| **Write** modified context | To apply stable-prefix rewriting |
| **Write** config state | To persist mode changes |

Future plugins will declare similar access requirements in their manifest, and the runtime will enforce them.

## Cleaning Up

To remove all LightMem2 data:

```bash
# Remove configuration files
rm ~/.codex/tokenpilot.json
rm ~/.claude/tokenpilot.json

# Remove CLI state
rm -rf ~/.lightmem2/

# Restore backups (or just remove .tokenpilot.bak files)
find ~/ -name "*.tokenpilot.bak" -delete
```

Follow the [Uninstall and Rollback](/user-guide/uninstall-and-rollback) guide for a complete cleanup.

## Privacy Summary

| Concern | Answer |
| :-- | :-- |
| Does LightMem2 send data externally? | No |
| Does LightMem2 store conversations? | No |
| Does LightMem2 read API keys? | No |
| Can I verify this? | Yes — all code is open source |
| Where are config files? | `~/.openclaw/`, `~/.codex/`, `~/.claude/` |

## Next

- [Uninstall and Rollback](/user-guide/uninstall-and-rollback) — complete cleanup guide
- [Security](/project/security) — security policy
