# Uninstall and Rollback

How to stop TokenPilot, restore backups, and clean up all traces of LightMem2.

## Quick Rollback (Keep Installed, Just Stop)

To stop TokenPilot without removing it:

```bash
# Disable the plugin
lightmem2 openclaw plugin tokenpilot disable
# Or stop the proxy
tokenpilot-codex stop
```

TokenPilot is still installed but won't process any context.

## Full Uninstall Per Host

### OpenClaw

```bash
# 1. Disable the plugin
# (in session)
/lightmem2 plugin tokenpilot disable

# 2. Restore original config
cp ~/.openclaw/openclaw.json.tokenpilot.bak ~/.openclaw/openclaw.json

# 3. Restart OpenClaw
```

### Codex

```bash
# 1. Stop the proxy
tokenpilot-codex stop

# 2. Restore original configs
cp ~/.codex/config.toml.tokenpilot.bak ~/.codex/config.toml
cp ~/.codex/hooks.json.tokenpilot.bak ~/.codex/hooks.json

# 3. Remove TokenPilot config
rm ~/.codex/tokenpilot.json

# 4. Remove the CLI binary (optional)
rm ~/.local/bin/lightmem2
rm ~/.local/bin/tokenpilot-codex
```

### Claude Code

```bash
# 1. Stop the gateway (close session or kill process)

# 2. Restore original configs
cp ~/.claude/settings.json.tokenpilot.bak ~/.claude/settings.json
cp ~/.claude/.claude.json.tokenpilot.bak ~/.claude/.claude.json

# 3. Remove TokenPilot config
rm ~/.claude/tokenpilot.json

# 4. Remove the CLI binary (optional)
rm ~/.local/bin/lightmem2
```

## Clean Up All Traces

To remove every LightMem2/TokPilot file from your machine:

```bash
# Remove configuration files
rm -f ~/.codex/tokenpilot.json
rm -f ~/.claude/tokenpilot.json

# Remove CLI state directory
rm -rf ~/.lightmem2/

# Remove CLI binaries
rm -f ~/.local/bin/lightmem2
rm -f ~/.local/bin/tokenpilot-codex

# Find and remove all backup files
find ~/ -name "*.tokenpilot.bak" -delete 2>/dev/null

# Remove the cloned repository
rm -rf ~/LightMem2
```

## What Gets Left Behind

The uninstall **does not** remove:
- Your agent host itself (OpenClaw, Codex, Claude Code)
- Your model API keys or host configuration (beyond TokenPilot's changes)
- Session data stored by your host

## Verify Uninstall

After uninstalling:

1. Restart your host
2. Start a new session
3. Confirm that `/lightmem2` commands are not available (OpenClaw)
4. Confirm that `lightmem2` CLI is no longer on your PATH

## Reinstall Later

To reinstall, follow [Install LightMem2](/getting-started/install-lightmem2) and [Install Your First Plugin](/getting-started/install-first-plugin) again.

## Next

- [Install LightMem2](/getting-started/install-lightmem2) — fresh install
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — problems before uninstalling
