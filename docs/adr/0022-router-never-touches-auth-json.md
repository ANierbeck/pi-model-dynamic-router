# ADR-0022: The router never reads or writes Pi's auth.json

- Status: accepted (2026-10-04)
- Supersedes: the router-side auth.json key resolution (markers `__auth_json__` /
  `__oauth__`, the CLI-OAuth → auth.json sync, and the generic `!...` command
  executor added for it one commit earlier); retires the multi-key rotation
  machinery (`activeKeyIndex`).
- Related: ADR-0021 (Pi's registry is the single source of truth for the cloud
  model inventory), AGENTS.md §6.

## Context

The owner's 2026-10-04 Vibe-plan key moved to macOS keychain, referenced from
`~/.pi/agent/auth.json` as `"key": "!security find-generic-password ..."` (pi's
secret-manager syntax, docs/providers.md). The router 401'd on that value, and
one commit (PR #3) taught the router to execute `!...` commands itself —
fixing the symptom of a much deeper problem the owner then named: the router
has no business accessing Pi's credential store at all; that access is
itself the mistake.

The answer is history: pre-ADR-0021, the router scanned provider catalogs
itself and needed raw keys from every source (env, auth.json, pass store,
CLI OAuth files) to do it — including a multi-key rotation for free-tier
daily caps. ADR-0021 removed the registration those scans fed; the key
machinery stayed behind as dead weight with a boundary violation attached:

- `discoverKeys()` read pi's auth.json and stored `__auth_json__:<key>`
  markers in `router-config.json` (persisted references to pi's credentials).
- `cli-auth-sync` **wrote** refreshed CLI OAuth tokens into pi's auth.json —
  the router mutating pi's credential store.
- `resolveKeyRef()` duplicated pi's own `!command` / env / marker resolution
  (pi: `resolve-config-value.js`, including a result cache) instead of
  asking pi.
- Post-ADR-0021 the only consumers were router-internal paths with inert
  results: catalog scans for providers Pi doesn't know (cache-only entries
  that are never registered), on-demand free-model registration, and the
  local-llm free-cloud fallback.

Inference never went through this machinery (stream-proxy already asks
`modelRegistry.getApiKeyForProvider`, which resolves auth.json — including
`!...` commands — through pi's own `auth-storage` / `resolve-config-value`).

## Decision

1. **The router never reads or writes `~/.pi/agent/auth.json` (or any Pi
   credential store).** Pi owns credential resolution end-to-end. The router
   obtains API keys exclusively through Pi's public interface,
   `modelRegistry.getApiKeyForProvider(provider)` (async), which resolves
   auth.json (with `!command` values), models.json, env and CLI OAuth per
   Pi's own priority (docs/models.md) — one source, one cache, one log path.
2. **Removed router machinery:**
   - `loadAuthFile` / `loadAuth` / `saveAuth` / `authPath` (discovery.ts);
   - the `__auth_json__:` / `__oauth__:` marker resolution and their
     discovery;
   - the CLI-OAuth → auth.json sync (the write path) and CLI auth file
     discovery (`__cli_oauth__:` markers);
   - pass-store discovery (`pass ls` tree walk) and the `!pass show` /
     generic `!...` command executors — if a key lives in a pass store or a
     command, the user references it from **pi's** auth.json and pi resolves
     it;
   - provider catalog scans for direct-API cloud providers (scan-runner) —
     post-ADR-0021 their results were inert cache entries and they were the
     last reason the router needed raw key values;
   - multi-key rotation (`activeKeyIndex`) — with a single key per provider
     resolved by pi, rotation has nothing to rotate.
3. **Surviving key-related behavior:** env-var discovery as display metadata
   is retained only where a consumer exists; free-model registration and the
   local-llm free-cloud fallback ask pi's `getApiKeyForProvider` through an
   injected async resolver (dependency-injected, so the modules stay testable
   without pi). A provider whose key pi cannot resolve is skipped — same
   eligibility rule as before, now with pi as the judge.
4. **The local Ollama registration is untouched** (ADR-0021 exception; no
   cloud credentials involved).

## Consequences

- Migration for users with `__auth_json__:` markers in their
  `router-config*.json`: **none required** — those markers pointed at pi's
  own auth.json, which pi reads directly. Keys that lived only in a pass
  store or CLI auth file must now be referenced from pi's auth.json (e.g.
  `"key": "!pass show ..."`), where pi executes them itself.
- One credential resolution semantics (pi's) instead of two diverging ones.
  This also closes the latent key-priority divergence noted in PR #3: the
  router no longer has its own env-vs-auth.json ordering at all.
- PR #3's `!...` executor becomes dead code with this ADR — it fixed the
  live 401 correctly under the then-current architecture, and this ADR
  removes the architecture that needed it. Both changes are kept in history;
  no revert.
- The router's own config may still reference env vars for display/eligibility,
  but never stores or resolves Pi credentials.
