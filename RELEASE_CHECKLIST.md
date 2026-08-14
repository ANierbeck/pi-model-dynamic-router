# Release Checklist — pi-model-dynamic-router v1.3.0

## Pre-Release Validation

### ✅ Code Quality
- [x] TypeScript compiles clean (`npx tsc --noEmit`)
- [x] All tests pass (`npx vitest run` → 367 passed)
- [x] Build succeeds (`npm run build`)
- [x] No linting errors (`npx eslint src/`)

### ✅ Functionality Verified
- [x] `/router scan` works without 45s timeout (gemma4:12b selected, not 35B)
- [x] GLM-5-2 appears in strategic/complex/tactical/operational groups
- [x] `mistral-medium-2604` no longer shows 1860 (cross-family fixed)
- [x] `ministral-3b/8b` show correct builtin score (933), not inflated
- [x] No Fable models in any group (exclude rule works)
- [x] No paid OpenRouter models (only `:free` tier)
- [x] Dynamic config + TUI table consistent (single `lookupGdp` source)
- [x] Exclude rules apply to live TUI table, not just dynamic config

### ✅ New Features Complete
- [x] LLM-assisted model matching with batched prompt + plausibility filter
- [x] Provider-agnostic local LLM caller (Ollama + LM Studio + OpenRouter fallback)
- [x] Cross-family hallucination guard (`isPlausibleMatch`)
- [x] Size-tier matching rules in prompt (generic, not hardcoded)
- [x] Layered config (defaults → global user → project-local)
- [x] Personalized exclude rules (providers, model globs, paid_models_from)
- [x] Self-healing GDPval lookup from cache
- [x] TAB-completion for `/router` commands

### ✅ Tests Coverage
- [x] `metrics-selfheal.test.ts` — self-healing + model-map precedence
- [x] `model-matcher-plausibility.test.ts` — cross-family + size-tier guards
- [x] `routing-exclude.test.ts` — exclude in live table
- [x] `glm-live-debug.test.ts` — GLM-5-2 end-to-end
- [x] `refactor-golden-master.test.ts` — pins behaviour
- [x] `config-loader.test.ts` — layered config deep-merge
- [x] `exclude.test.ts` — exclude rule logic
- [x] `local-llm.test.ts` — provider ranking + fallback
- [x] `model-matcher-llm.test.ts` — batched matching + parse

### ✅ Documentation
- [x] `docs/architecture.md` — module overview, matching pipeline
- [x] `docs/config-override.md` — layered config + exclude rules
- [x] `docs/router-config.example.json` — example config
- [x] `CHANGELOG.md` — complete Added/Changed/Fixed
- [x] `README.md` — updated architecture table + new sections

## Release Steps

### 1. Version Bump
```bash
# Minor bump for new features (config, exclude, LLM matching)
npm version minor  # 1.2.1 → 1.3.0
# or manual: edit package.json version + git commit
```

### 2. Commit All Changes
```bash
git add -A
git commit -m "release: v1.3.0 — LLM matching, layered config, exclude rules, GLM support"
```

### 3. Tag & Push
```bash
git tag v1.3.0
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
pi install npm:@anierbeck/pi-model-dynamic-router@1.3.0
# Verify /router scan works
```

### 6. GitHub Release
- Create release on GitHub from tag `v1.3.0`
- Copy CHANGELOG.md entry as release notes
- Attach no binaries (pure JS bundle)

## Post-Release

### Update User Config Template
```bash
# Ensure ~/.pi/agent/router-config.user.json.example is current
cat > ~/.pi/agent/router-config.user.json.example << 'EOF'
{
  "exclude": {
    "providers": [],
    "models": ["*fable*"],
    "paid_models_from": ["openrouter"]
  }
}
EOF
```

### Update PI.md (if exists)
- Check if `PI.md` needs skill updates for new `/router` commands

## Current Status: READY FOR RELEASE

All validation checks pass. Ready to bump version and publish.