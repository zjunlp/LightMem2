# Quick Start

A minimal path from clone to a verified running session. You will have LightMem2 installed with TokenPilot active in under 5 minutes.

## 1. Clone and Build

```bash
git clone https://github.com/zjunlp/LightMem2.git
cd LightMem2
corepack enable
pnpm install
pnpm build
pnpm lightmem2:build
pnpm lightmem2:install
```

The last command installs the `lightmem2` CLI entrypoint at `~/.local/bin/lightmem2`. Make sure `~/.local/bin` is on your `PATH`.

## 2. Pick Your Host

Choose your agent host and run the matching install command:

::: code-group
```bash [OpenClaw]
pnpm component:install:tokenpilot:openclaw
```

```bash [Codex]
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run install:codex
```

```bash [Claude Code]
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
```
:::

Each install command:
- Updates the host's configuration files
- Enables the TokenPilot plugin
- Sets the default `normal` runtime mode
- Registers required hooks or MCP servers
- Creates backups of modified files as `.tokenpilot.bak`

## 3. Start a Session

Open or restart your host, then start a new session.

::: code-group
```text [OpenClaw]
Use a lightmem2/<model> model like lightmem2/gpt-5.4-mini
Run: /lightmem2 status
```

```text [Codex]
Start Codex normally, approve TokenPilot hooks if prompted
Open a new session so SessionStart can start the proxy
```

```text [Claude Code]
Start Claude Code normally
Open a new session so SessionStart can start the gateway
```
:::

## 4. Verify It Works

Run the doctor command to confirm everything is healthy:

::: code-group
```bash [OpenClaw]
/lightmem2 doctor
# Or outside OpenClaw:
lightmem2 openclaw doctor
```

```bash [Codex]
lightmem2 codex doctor
```

```bash [Claude Code]
lightmem2 claude-code doctor
```
:::

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

## 5. See Your Savings

After a few turns, check your report:

::: code-group
```bash [OpenClaw]
/lightmem2 report
```

```bash [Codex]
lightmem2 codex report
```

```bash [Claude Code]
lightmem2 claude-code report
```
:::

If you see token and cost metrics instead of "No TokenPilot session stats yet", TokenPilot is actively managing your context.

## 6. Visual Inspector

Open the built-in visual inspector to see your session in real time:

```bash
lightmem2 visual
```

This opens a browser view showing stable-prefix, reduction, and eviction snapshots.

## What's Next

- [Install Your First Plugin](/getting-started/install-first-plugin) — detailed install walkthrough
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — choose conservative, normal, or aggressive
- [CLI Reference](/user-guide/cli-reference) — all commands and flags
