# Install LightMem2

This page covers the LightMem2 platform installation — the shared runtime that all plugins need. After this, install your first plugin (e.g., TokenPilot).

## Prerequisites

| Requirement | Minimum | Notes |
| :-- | :-- | :-- |
| **Node.js** | ≥ 18 | v20+ recommended |
| **pnpm** | ≥ 9 | v10.32+ used in development |
| **OS** | macOS, Linux, Windows (WSL) | Windows native may work but is less tested |
| **Target Host** | OpenClaw / Codex / Claude Code | At least one must be installed |

No cloud services, API keys, or external dependencies are required.

## Step 1: Clone the Repository

```bash
git clone https://github.com/zjunlp/LightMem2.git
cd LightMem2
```

## Step 2: Enable Corepack and Install

```bash
corepack enable
pnpm install
```

This installs all workspace dependencies across the plugin packages and host adapters.

## Step 3: Build Shared Packages

```bash
pnpm build
```

This builds the shared packages (`runtime-core`, `kernel`, `layers`, `host-adapter`) that all plugins and adapters depend on.

## Step 4: Build and Install the CLI

```bash
pnpm lightmem2:build
pnpm lightmem2:install
```

The first command builds the shared `lightmem2` CLI. The second installs it to `~/.local/bin/lightmem2`.

::: warning PATH notice
Make sure `~/.local/bin` is on your `PATH`. Add this to your shell config if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```
:::

## Verify Installation

```bash
lightmem2 --help
```

You should see the top-level command listing.

```bash
lightmem2 context
```

This shows your current default host, pinned session, and config target.

## What Got Installed

| Component | Location | Purpose |
| :-- | :-- | :-- |
| `lightmem2` CLI | `~/.local/bin/lightmem2` | Standalone CLI for all hosts |
| Shared packages | `node_modules/` (workspace) | Runtime engine, types, contracts |
| Host adapter code | `components/adapters/` | Per-host integration code |

## Next

- [Install Your First Plugin](/getting-started/install-first-plugin) — install TokenPilot for your host
- [Quick Start](/getting-started/quick-start) — end-to-end walkthrough
