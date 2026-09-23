# Harness Upgrade Playbook

---

## Pre-Upgrade Checklist

- [ ] Read upstream CHANGELOG for breaking changes
- [ ] Run current compatibility matrix: `docs/implementation/01-harness-version-compatibility.md`
- [ ] Create upgrade branch
- [ ] Run all existing tests before upgrade

## Upgrade Steps

### 1. Update peerDependencies

Update in `packages/sdk-driver/package.json`:
```json
"peerDependencies": {
  "@deepseek-ai/dsh-sdk-client": "<new-version>",
  "@deepseek-ai/dsh-sdk-protocol": "<new-version>"
}
```

Update in `packages/dsh-bridge/package.json`:
```json
"dependencies": {
  "@deepseek-ai/cordis": "<new-version>",
  "@deepseek-ai/dsh-*": "<new-versions>"
}
```

### 2. SDK Contract Tests

Run SDK-level smoke tests:
```sh
pnpm --filter @dsh-platform/sdk-driver test
```

Verify:
- [ ] Session create
- [ ] Session resume
- [ ] Prompt round-trip
- [ ] Follow stream
- [ ] Page/cursor

### 3. Bridge Composition Tests

```sh
pnpm --filter @dsh-platform/dsh-bridge typecheck
```

Verify:
- [ ] platform-identity plugin loads
- [ ] ui-platform-account plugin loads
- [ ] toolGuardDecision works

### 4. Runtime Behavior

Verify:
- [ ] `dsh web --no-open --host 127.0.0.1 --port <p> --trusted-host <authority>` starts correctly
- [ ] stdout parsing (`dsh web: http://...`) matches new format
- [ ] Web UI uses same absolute path scheme (/assets, /api)

### 5. Full Stack Test

```sh
pnpm build
pnpm typecheck
```

### 6. Rollback

If upgrade fails:
- Revert peerDependencies to previous versions
- `pnpm install --lockfile-only`
- Verify build
- Investigate API differences

## Version History

| Date | From | To | Result |
|---|---|---|---|
| - | 0.1.1-rc.2 | 0.1.2-rc.1 | Not yet attempted |

## Known Breaking Change Risks

- Web UI path scheme (absolute vs sub-path)
- Launch token model (presence/absence)
- SDK client API surface changes
- Session format version bumps
- Cordis plugin API changes