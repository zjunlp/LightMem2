# Local Development

How to set up LightMem2 for local development.

## Prerequisites

Same as [installation prerequisites](/getting-started/install-lightmem2#prerequisites):
- Node.js ≥ 18 (v20+ recommended)
- pnpm ≥ 9
- Git

## Setup

```bash
git clone https://github.com/zjunlp/LightMem2.git
cd LightMem2
corepack enable
pnpm install
pnpm build
```

## Development Workflow

```bash
# Build all packages
pnpm build

# Typecheck
pnpm typecheck

# Build the CLI
pnpm lightmem2:build

# Install the CLI locally
pnpm lightmem2:install

# Run tests
pnpm lightmem2:test
```

## Per-Package Commands

```bash
# Build a specific adapter
npm --prefix components/tokenpilot/adapters/openclaw run build

# Typecheck a specific package
npm --prefix components/tokenpilot/packages/runtime-core run typecheck
```

## Documentation Site

```bash
# Start dev server
pnpm docs:dev

# Build for production
pnpm docs:build

# Preview production build
pnpm docs:preview
```

## Next

- [Build and Test](/development/build-and-test)
- [Repository Structure](/development/repository-structure)
- [Contributing](/development/contributing)
