# OpenClaw

OpenClaw is the primary host for LightMem2, with the deepest integration via a native plugin slot.

::: info Test Environment
**OS**: macOS 14 / Linux (Ubuntu 22.04) &nbsp;|&nbsp; **Node**: v20+ &nbsp;|&nbsp; **Last verified**: 2026-07-16
:::

## Installation

```bash
pnpm component:install:tokenpilot:openclaw
```

This command:
- Updates `~/.openclaw/openclaw.json`
- Enables the TokenPilot plugin
- Switches `plugins.slots.contextEngine` to `layered-context`
- Sets the default `normal` mode
- Attempts to restart the OpenClaw gateway

### Custom Paths

```bash
export LIGHTMEM2_OPENCLAW_HOME="/path/to/openclaw-home"
export OPENCLAW_CONFIG_PATH="/path/to/openclaw.json"
pnpm component:install:tokenpilot:openclaw
```

## Expected Output

After install, your `~/.openclaw/openclaw.json` will include a TokenPilot section:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "layered-context"
    },
    "entries": {
      "tokenpilot": {
        "enabled": true,
        "mode": "normal"
      }
    }
  }
}
```

## Verification

Inside an OpenClaw session:

```text
/lightmem2 status
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `context engine slot layered-context`
- `stabilizer enabled`
- `reduction enabled`

For a fuller check:

```text
/lightmem2 doctor
/lightmem2 report
/lightmem2 visual
```

## In-Session Commands

OpenClaw supports in-session slash commands:

```text
/lightmem2 status          # View current status
/lightmem2 report          # Session token/cost report
/lightmem2 doctor          # Integration self-check
/lightmem2 visual          # Open visual inspector
/lightmem2 mode normal     # Switch mode
/lightmem2 stabilizer target developer
/lightmem2 reduction mode balanced
/lightmem2 eviction on
/lightmem2 help            # List all commands
```

## Standalone CLI

Commands also work outside OpenClaw:

```bash
lightmem2 openclaw status
lightmem2 openclaw report
lightmem2 openclaw doctor
lightmem2 openclaw visual
lightmem2 openclaw mode normal
lightmem2 openclaw session <session-id> report
```

## Model Selection

Use models with the `lightmem2/` prefix:

```text
lightmem2/gpt-5.4-mini
```

This routes through TokenPilot's context management pipeline.

## Useful Controls

- `mode aggressive` — maximum savings
- `eviction on|off` — lifecycle-aware context eviction
- `settings details on` — expanded status output
- `stabilizer ...` and `reduction ...` — fine-tune stabilization and reduction

## Failure Recovery

If the install fails or you need to roll back:

```bash
# Restore original config
cp ~/.openclaw/openclaw.json.tokenpilot.bak ~/.openclaw/openclaw.json

# Restart OpenClaw
# (use your normal restart method)
```

## Troubleshooting

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#openclaw) for OpenClaw-specific issues.
