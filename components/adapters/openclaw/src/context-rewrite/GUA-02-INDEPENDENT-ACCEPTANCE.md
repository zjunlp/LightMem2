# GUA-02 Independent Cross-Host Acceptance

## Environment

- Owner: 观祥
- Date: 2026-08-11
- Base commit: `a35b50b3b4abaad36927983dfea2d83eff2fb0fe`
- OS: Windows x64 with Git Bash
- Node: `v24.18.0`
- pnpm: `10.32.1`

## Scope

This acceptance independently verifies that the OpenClaw, Claude Code,
and Codex context rewrite backends produce the same logical task and
item target sets.

The validation covers:

- completed task
- unresolved task
- tool call/result closure
- active/current user turn

## Validation

The focused test invokes all three backend implementations instead of
copying static expected target arrays.

```bash
corepack pnpm --filter @lightmem2/openclaw-adapter exec node --import tsx --test src/context-rewrite/cross-host-backends.test.ts
```

Result:

```text
tests 1
pass 1
fail 0
```

Additional validation:

```text
OpenClaw adapter typecheck: PASS
Claude Code adapter typecheck: PASS
Codex adapter typecheck: PASS
Package boundaries: PASS (16 packages, 59 internal edges)
```

## Conclusion

- OpenClaw target task/item sets: PASS
- Claude Code target task/item sets: PASS
- Codex target task/item sets: PASS
- Cross-host target alignment: PASS
- Static three-host target fixture used: NO
- Raw user data or credentials included: NO

This is backend-level golden-fixture acceptance. External provider smoke
is outside the scope of GUA-02.
