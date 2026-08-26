# Release Checklist — pi-model-dynamic-router

A reusable checklist for cutting a new release. Copy the relevant sections
and fill in the version-specific details. **Replace every `<VERSION>` and
`<prev> → <VERSION>` placeholder before committing.**

## Pre-Release Validation

### Code Quality
- [ ] TypeScript compiles clean (`npx tsc --noEmit`)
- [ ] All tests pass (`npm run test:coverage` → note the pass/skip count)
- [ ] Coverage stays above the CI floor (see `vitest.config.ts` thresholds)
- [ ] Build succeeds (`npm run build`)
- [ ] No linting errors (`npx eslint src/`)

### Functionality Verified (re-run against current code)
- [ ] `/router scan` completes without timeout
- [ ] Expected models appear in the expected groups (spot-check strategic/tactical)
- [ ] Exclude rules apply to the live TUI table, not just the dynamic config
- [ ] Fallback cascade reaches a healthy model when the first candidate fails

### New Features Complete
- [ ] Each new feature has at least one regression test that fails without it
- [ ] New config keys are documented in README.md and SKILL.md
- [ ] No removed/renamed files are still referenced anywhere in docs

### Documentation
- [ ] `CHANGELOG.md` has an entry under the new version (or `[Unreleased]`)
- [ ] `README.md` architecture table + feature sections reflect current code
- [ ] `PI.md` / `SKILL.md` feature lists don't list removed features as active
- [ ] Cross-references between docs resolve (no broken links to deleted files)
- [ ] No stale version references (headers, "Last Updated", examples)

## Release Steps

### 1. Version Bump
```bash
# Minor bump for new features, patch for fixes.
npm version minor  # e.g. <prev> → <VERSION>
# or manual: edit package.json "version" field + git commit
```

### 2. Commit All Changes
```bash
git add -A
git commit -m "release: v<VERSION> — <short summary>"
```

### 3. Tag & Push
```bash
git tag v<VERSION>
git push origin main --tags
```

### 4. Publish to npm
```bash
npm publish
# OR: npm publish --dry-run first to verify package contents
```

### 5. Verify Install
```bash
# In a clean test directory
pi install npm:@anierbeck/pi-model-dynamic-router@<VERSION>
# Verify /router scan works
```

### 6. GitHub Release
- Create release on GitHub from tag `v<VERSION>`
- Copy the CHANGELOG.md entry as release notes
- Attach no binaries (pure JS bundle)

## Post-Release

### Sanity check
- [ ] `npm view @anierbeck/pi-model-dynamic-router version` returns the new version
- [ ] Fresh `pi install` picks up the new version
- [ ] No user reports of missing models or broken routing

### Update downstream references
- Update `~/.pi/agent/router-config.user.json.example` if config shape changed
- Re-check `PI.md` / `SKILL.md` for any `/router` command changes
