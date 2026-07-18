# Build and Test

Commands for building, typechecking, and testing LightMem2.

## Build

```bash
# Build everything
pnpm build

# Build the CLI specifically
pnpm lightmem2:build
pnpm lightmem2:install

# Build specific adapter
npm --prefix components/tokenpilot/adapters/openclaw run build
npm --prefix components/tokenpilot/adapters/codex run build
npm --prefix components/tokenpilot/adapters/claude-code run build
```

## Typecheck

```bash
# Typecheck all packages
pnpm typecheck

# Typecheck specific package
npm --prefix components/tokenpilot/packages/runtime-core run typecheck
```

## Test

```bash
# Run all tests
pnpm lightmem2:test

# Run tests for specific package
npm --prefix components/tokenpilot/products/cli test
```

## CI

GitHub Actions workflows are in `.github/workflows/`. The CI runs:
- Typecheck
- Build
- Tests

## Documentation

```bash
pnpm docs:dev      # Dev server with hot reload
pnpm docs:build    # Production build
pnpm docs:preview  # Preview production build
```

## Next

- [Local Development](/development/local-development)
- [Contributing](/development/contributing)
