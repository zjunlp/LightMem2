# Contributing to LightMem2

LightMem2 is still moving quickly. The most useful contributions are usually:

- host adapter fixes for real agent workflows
- install and onboarding improvements
- visual / report / doctor usability improvements
- benchmark reproduction fixes
- tests that lock down real regressions

## Quick Start

```bash
git clone https://github.com/zjunlp/LightMem2.git
cd LightMem2
corepack enable
pnpm install
pnpm build
pnpm typecheck
```

If you are changing the standalone CLI path, also run:

```bash
pnpm lightmem2:build
pnpm lightmem2:typecheck
pnpm lightmem2:test
```

## Before Opening a PR

- keep changes scoped to one problem when possible
- add or update tests for behavior changes
- prefer real host-path verification over mock-only fixes
- avoid breaking the default first-run install path

## Reporting Issues

When reporting a bug, include:

- host: `OpenClaw`, `Codex`, or `Claude Code`
- install path: default or custom config path
- exact commands you ran
- relevant config snippets
- doctor / status output
- logs or screenshots if the issue is visual or runtime-specific

## Community

- Use GitHub Issues for actionable bugs and feature requests.
- Use Discord for setup help, debugging, and discussion.
