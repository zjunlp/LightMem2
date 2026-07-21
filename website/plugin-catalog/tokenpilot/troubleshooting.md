# TokenPilot Troubleshooting

Common problems, symptoms, and fixes for TokenPilot.

## Quick Diagnostic

Always start with:

```bash
lightmem2 doctor
lightmem2 status
```

These two commands answer most questions about whether TokenPilot is running correctly.

## Install Problems

### "Command not found: lightmem2"

**Cause**: `~/.local/bin` is not on your `PATH`.

**Fix**:
```bash
export PATH="$HOME/.local/bin:$PATH"
# Add to ~/.bashrc or ~/.zshrc to make permanent
```

### "pnpm: command not found" or pnpm errors

**Cause**: pnpm not installed or corepack not enabled.

**Fix**:
```bash
corepack enable
pnpm install
```

### Install script fails with no clear error

**Diagnosis**:
```bash
# Check if the adapter exists
ls components/adapters/<host>/

# Run the build step manually
npm --prefix components/adapters/<host> run build

# Check for custom path issues
echo $LIGHTMEM2_OPENCLAW_HOME
echo $OPENCLAW_CONFIG_PATH
```

## Runtime Problems

### "No TokenPilot session stats yet"

**Cause**: The session hasn't accumulated enough turns for statistics.

**Fix**: Run a few more turns, then check again. This is normal for brand-new sessions.

### "proxy healthy: no" (Codex / Claude Code)

**Cause**: The local proxy or gateway isn't running.

**Fix**:
```bash
# Codex
tokenpilot-codex status
tokenpilot-codex start

# Claude Code — open a new session so SessionStart fires
# Or restart Claude Code
```

**Still failing?** Check if another process is using the proxy port:

```bash
# Check port usage (default ports may vary)
lsof -i :<port>
```

### Doctor reports "plugin entry enabled: false"

**Cause**: The plugin wasn't registered correctly during install.

**Fix**: Re-run the install command for your host:

```bash
# OpenClaw
pnpm component:install:tokenpilot:openclaw

# Codex
npm --prefix components/adapters/codex run install:codex

# Claude Code
npm --prefix components/adapters/claude-code run install:claude-code
```

### Mode change not taking effect

**Cause**: Mode changes apply on the next turn, not retroactively.

**Fix**: Send another message in your session and check again.

### Unexpected model behavior or missing context

1. Check current mode:
   ```bash
   lightmem2 status
   ```
2. If in aggressive mode, try normal:
   ```bash
   lightmem2 mode normal
   ```
3. If reduction or eviction is the issue:
   ```bash
   lightmem2 reduction mode light
   lightmem2 eviction off
   ```

## Host-Specific Problems

### OpenClaw

| Symptom | Possible Cause | Fix |
| :-- | :-- | :-- |
| `/lightmem2` commands not recognized | Plugin not loaded | Restart OpenClaw gateway |
| Model not found (`lightmem2/...`) | Wrong model prefix | Use `lightmem2/gpt-5.4-mini` or similar |
| Config changes lost on restart | OpenClaw overwrote config | Re-run `pnpm component:install:tokenpilot:openclaw` |

### Codex

| Symptom | Possible Cause | Fix |
| :-- | :-- | :-- |
| Hooks prompt asking for trust | First install | Approve the hooks |
| Proxy starts but doctor says unhealthy | Timing issue | Wait 5 seconds and retry |
| CLI works but Codex session doesn't use TokenPilot | Hooks not trusted | Trust hooks in Codex UI |

### Claude Code

| Symptom | Possible Cause | Fix |
| :-- | :-- | :-- |
| Gateway not auto-starting | SessionStart hook not registered | Re-run install |
| MCP server not found | MCP registration failed | Check `~/.claude/.claude.json` |

## Still Having Problems?

### Collect Diagnostic Information

```bash
lightmem2 doctor > doctor-output.txt 2>&1
lightmem2 status > status-output.txt 2>&1
lightmem2 report > report-output.txt 2>&1
```

### Check Logs

```bash
# Codex proxy logs
tokenpilot-codex status

# Check host-specific logs
ls ~/.codex/logs/
ls ~/.claude/logs/
```

### Report a Bug

1. Include the output of `lightmem2 doctor`, `lightmem2 status`, and `lightmem2 report`
2. Describe what you expected and what happened
3. Note your host, OS, and any custom config paths
4. File an issue on [GitHub](https://github.com/zjunlp/LightMem2/issues)
