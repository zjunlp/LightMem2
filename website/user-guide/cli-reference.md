# CLI Reference

The `lightmem2` CLI is the unified command interface across all hosts. This page documents every command.

## Global Commands

Commands that work without specifying a host (uses the default host set by `lightmem2 use`).

```bash
lightmem2 report              # Latest session report across hosts
lightmem2 visual              # Open visual inspector (shared, switchable)
lightmem2 use <host>          # Set default host
lightmem2 use <host> session <id>  # Pin default session
lightmem2 context             # Show default host, pinned session, config
lightmem2 --help              # Top-level help
```

## OpenClaw Commands

### In-Session (`/lightmem2`)

```text
/lightmem2 status             # Current plugin and runtime status
/lightmem2 report             # Session token, cache, and cost report
/lightmem2 doctor             # Full integration self-check
/lightmem2 visual             # Open visual inspector
/lightmem2 mode <mode>        # Switch: conservative | normal | aggressive
/lightmem2 stabilizer target <developer|user>
/lightmem2 reduction mode <light|balanced>
/lightmem2 eviction <on|off>
/lightmem2 settings details <on|off>
/lightmem2 help               # List all commands
```

### Standalone CLI

```bash
lightmem2 openclaw status
lightmem2 openclaw report
lightmem2 openclaw doctor
lightmem2 openclaw visual
lightmem2 openclaw mode <mode>
lightmem2 openclaw session <id> report
lightmem2 openclaw stabilizer <on|off>
lightmem2 openclaw stabilizer target <developer|user>
lightmem2 openclaw reduction <on|off>
lightmem2 openclaw reduction mode <light|balanced>
lightmem2 openclaw reduction pass toolPayloadTrim <off>
lightmem2 openclaw eviction <on|off>
lightmem2 openclaw help
```

## Codex Commands

```bash
lightmem2 codex status
lightmem2 codex report
lightmem2 codex doctor
lightmem2 codex visual
lightmem2 codex session <id> report
lightmem2 codex mode <conservative|normal|aggressive>
lightmem2 codex stabilizer <on|off>
lightmem2 codex stabilizer target <developer|user>
lightmem2 codex reduction <on|off>
lightmem2 codex reduction mode <light|balanced>
lightmem2 codex reduction pass toolPayloadTrim <off>
lightmem2 codex reduction status
lightmem2 codex help
```

Manual proxy control:

```bash
tokenpilot-codex status
tokenpilot-codex start
```

## Claude Code Commands

```bash
lightmem2 claude-code status
lightmem2 claude-code report
lightmem2 claude-code doctor
lightmem2 claude-code visual
lightmem2 claude-code session <id> report
lightmem2 claude-code mode <conservative|normal|aggressive>
lightmem2 claude-code stabilizer <on|off>
lightmem2 claude-code stabilizer target <developer|user>
lightmem2 claude-code reduction <on|off>
lightmem2 claude-code reduction mode <light|balanced>
lightmem2 claude-code reduction pass toolPayloadTrim <off>
lightmem2 claude-code reduction status
lightmem2 claude-code help
```

## Command Reference

### `status`

Shows plugin state, mode, and subsystem status.

```bash
lightmem2 <host> status
```

**Example output:**
```text
plugin entry:  enabled
config:        enabled
mode:          normal
stabilizer:    enabled
reduction:     enabled
eviction:      enabled
```

### `doctor`

Full integration self-check. Tests config, proxy health, hook registration.

```bash
lightmem2 <host> doctor
```

**Example output:**
```text
plugin entry enabled:   yes
config enabled:          yes
mode:                    normal
stabilizer enabled:      yes
reduction enabled:       yes
proxy healthy:           yes
config file readable:    yes
backup files present:    yes
```

### `report`

Session token, cache, and cost summary.

```bash
lightmem2 <host> report
lightmem2 <host> session <id> report
```

**Example output:**
```text
Session: abc123   Turns: 12   Mode: normal
Input tokens:     45,230    Cache read: 38,100 (84.2%)
Cache miss:       7,130     Output:     3,420
Est. cost:        $0.12
```

### `visual`

Opens the browser-based visual inspector.

```bash
lightmem2 visual
lightmem2 <host> visual
```

### `mode`

Switches runtime mode preset.

```bash
lightmem2 <host> mode conservative
lightmem2 <host> mode normal
lightmem2 <host> mode aggressive
```

### `stabilizer`

Controls stable-prefix rewriting.

```bash
lightmem2 <host> stabilizer <on|off>
lightmem2 <host> stabilizer target <developer|user>
```

### `reduction`

Controls context reduction.

```bash
lightmem2 <host> reduction <on|off>
lightmem2 <host> reduction mode <light|balanced>
lightmem2 <host> reduction pass toolPayloadTrim <on|off>
lightmem2 <host> reduction status
```

### `eviction`

Controls lifecycle-aware context eviction.

```bash
lightmem2 <host> eviction <on|off>
```

## Next

- [Visual Inspector](/user-guide/visual-inspector) — using the browser dashboard
- [Logs and Diagnostics](/user-guide/logs-and-diagnostics) — finding and reading logs
