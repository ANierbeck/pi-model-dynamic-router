# Agent Rules — pi-model-dynamic-router

> These are **hard rules** for any AI agent working in this repo. Pi loads
> `AGENTS.md` (and `CLAUDE.md`) automatically at session start, so these apply
> to every session, every agent, every fork. Violating them is a process
> failure, not a style preference.

## 1. Release & Publish — REQUIRES EXPLICIT USER APPROVAL

**The user decides when software is released. Not the agent.**

- **Never** create a git tag, a GitHub Release, or run `npm publish` (directly
  *or* via a workflow trigger such as `gh release create`) without the user's
  **explicit, release-specific** approval. The approval must name the concrete
  release (e.g. "release 1.5.1"). General agreement like "weiter so", "yes do
  it", "ok", "like last time", or a clean CI is **NOT** approval.
- The normal flow **stops after** "commit + PR + verify CI green + merge"
  (see §8 — `main` takes no direct pushes). The next
  step (tag / release / publish) is **always a question to the user**, never an
  action. Ask with the concrete version number, not a generic "shall I tag?".
- A published npm version **cannot be deleted**. Treating a silent
  auto-publish as recoverable is wrong — the damage is permanent. This is why
  the rule exists. (Incident 2026-08-28: v1.5.0 was published to npm without
  approval; the rule already existed in memory but was ignored. Hence this
  file.)
- If unsure whether something counts as a release action: **ask first, do not
  act.** Tagging, `gh release create`, `npm publish`, and triggering a publish
  workflow are all release actions.
- **Release builds ship with a quiet log level: "warn" or "error"** (owner
  rule 2026-10-02). Before a release is proposed, verify that the shipped
  `router-config.json` sets `log_level` to `"warn"` or `"error"` — this is
  the effective default for everyone installing the package. The gate is
  automated: the `config-release-log-level` case in
  `test/consolidated-config-pins.test.ts` fails the suite on a regression. Local dev verbosity is unaffected (the user-level
  `router-config.user.json` overrides it, and `ROUTER_LOG_LEVEL` overrides
  both).
- **Code review must be clean before a release is even *proposed*** to the
  user. Use the `requesting-code-review` skill from the **pi-superpowers**
  extension — it is NOT in this repo's own `skills/` directory (that only has
  `content-based-router` and `router-login`); it ships with the pi-superpowers
  extension and your session's skill listing gives its exact file location.
  Read that skill's `code-reviewer.md` template and fill in all of its
  placeholders, not just the SHAs: `{WHAT_WAS_IMPLEMENTED}`,
  `{PLAN_OR_REQUIREMENTS}`, `{DESCRIPTION}`, `{BASE_SHA}`, `{HEAD_SHA}`.
  `{BASE_SHA}` is the last release tag (`git describe --tags --abbrev=0`), or
  `origin/main` if no tags exist yet; `{HEAD_SHA}` is `HEAD`. Dispatch the
  filled-in prompt with the `subagent` tool using the builtin `reviewer` agent
  (fresh context) — the skill's own `pi -p "..."` instruction is a fallback
  for sessions without a subagent dispatch tool, which does not apply here.
  No Critical or Important findings may remain open. A clean review is NOT
  itself approval to release — it's a prerequisite, not a substitute for the
  user's go-ahead.

## 2. Single source of truth for rules

- Rules that govern agent behavior belong **here** (versioned, reviewable,
  loaded every session) — not only in agent memory (which is per-context and
  can be missed). The release rule above is the canonical source. Memory
  entries may reinforce it but do not replace it.
- If a rule needs to change, change this file in a commit — don't quietly
  update only memory.

## 3. Documentation language

- **All documentation and comments must be in English** — code comments,
  JSDoc, Markdown (README, TODO, CHANGELOG, this file), commit messages, type
  definitions. Rationale: international project. (Existing German prose was
  translated to English in v1.4.0-era cleanup; new German comments are a
  regression.)
- Exception: short project shorthand tokens (`Ü1`, `A2`, `F3`, etc.) stay as-is
  — they're names, not prose. User-facing chat in German is fine (that's the
  user's language, not project documentation).

## 4. Tests & verification before push (TDD — owner decision 2026-10-04)

- **Red-first is mandatory.** Every regression test for a new feature or
  bugfix must be observed **RED against the unfixed implementation** before
  the implementation lands, and the report names the red evidence. A test
  that has never failed is untested itself — green-at-birth is exactly how
  the calculate-score contract pin went stale silently (suite hygiene round,
  PR #16). Exceptions (docs-only, pure config) are stated explicitly in the
  report, never implied.
- `npx tsc --noEmit` must pass before committing non-test-only changes.
- `npx vitest run` must be green (current count: 1344 passing / 3 skipped).
  Don't lower the `coverage.thresholds` in `vitest.config.ts` to unblock a
  red run — fix the actual regression.
- New features/fixes get a regression test that actually exercises the fix
  (non-vacuous — see the "Ü1 invariant test" incident where a test passed
  vacuously and had to be rewritten, roborev job 308). Red-first makes the
  non-vacuous requirement verifiable: if you cannot drive the test red, it
  does not exercise the fix.

## 5. Commit conventions

- Conventional-Commits-style prefixes: `fix:`, `feat:`, `test:`, `docs:`,
  `refactor:`, `chore:`, `release prep:`.
- Batch related fixes into one commit where they belong; don't split a single
  logical change across many tiny commits.
- Commit message body explains *why* (the bug, the symptom, the evidence),
  not just *what*.

## 6. Don't touch Pi's models.json / don't overwrite existing registrations

- `pi.registerProvider` REPLACES the provider's `models` array wholesale (it
  does not merge). Never register a provider with a partial model list when it
  might already be registered with more models — check
  `getRegisteredProviderIds` first (the Ü1 invariant). This bit us in v1.5.0
  development (roborev job 302) and is now enforced in
  `registerFreeModelOnDemand`.
- **The router never registers models Pi does not know** (ADR-0021, owner
  decision 2026-10-02). Pi's registry (builtin catalog + models.json) is the
  single source of truth for the cloud model inventory; the router only
  enriches and uses what Pi already resolves. Registering scan-discovered
  models was the root cause of the Mistral 422 "store" errors (29 invented
  Mistral registrations, OCR/audio models registered as chat models). The
  only registrations left: local Ollama (no Pi discovery mechanism; LM
  Studio was never registered), explicitly-configured `free_models` on
  demand, and the router's own virtual group providers.

## 7. Boyscout Rule — leave the code better than you found it

- If we find code smells, bugs, or other defects while changing or reviewing
  code, we **fix them too** — even when fixing them was not the original
  review/coding task. Finding a defect and merely reporting it is not enough;
  findings left in a report rot.
- This deliberately goes beyond the §1 review gate ("no Critical or Important
  findings may remain open"): Minor and cosmetic findings (smells, dead code,
  misleading names or comments) are also fixed, not filed away.
- Every fix meets the same bars as any change: §4 (tsc + suite green,
  regression test for bug fixes) and §5 (commit conventions). Small, local
  cleanups may ride along in the task's commit when they belong to it;
  anything standalone gets its own `fix:`/`refactor:` commit whose body names
  the defect and where it was found.
- The only escape is an explicit blocker: the fix would require a
  release/publish decision (§1) or an owner decision. Then the finding is
  surfaced to the user with a concrete plan — it never silently disappears.
  Size alone is never a blocker; a fix too large for the current commit gets
  its own dedicated commit on the same branch.

## 8. Protected `main` & secret scanning

- `main` is protected by the GitHub ruleset "Protect main" (owner decision
  2026-10-03): no direct pushes, no force pushes, no deletion. Every change
  lands through a pull request whose required checks `test` and
  `secret-scan` are green. There is **no bypass, not even for admins** —
  agents act with the owner's token, so an admin bypass would be a bypass
  for every agent.
- Flow: feature branch → `git push -u origin <branch>` → `gh pr create` →
  required checks green → **verify external reviews (below)** → `gh pr merge`.
  Batch related commits into one PR (§5) instead of opening one PR per commit.
- **Read and verify every review posted on the PR before merging** (owner
  decision 2026-10-04). Required checks are not the whole gate: automated
  external reviewers — Sourcery, and any other app review — must be read
  and resolved BEFORE `gh pr merge`, even when their check is advisory
  (non-required). Fetch them via `gh api --paginate` on ALL THREE endpoints:
  `repos/<owner>/<repo>/pulls/<n>/reviews` (review summaries),
  `repos/<owner>/<repo>/pulls/<n>/comments` (inline review comments), and
  `repos/<owner>/<repo>/issues/<n>/comments` (general PR conversation
  comments — bots and humans can post findings there too). Every finding is either
  fixed in the PR (with §4 bars) or explicitly justified as not-a-defect
  in the report to the owner — a PR is never merged while a review
  comment sits unread. Incident 2026-10-04: PRs #3 and #4 were merged with
  unread Sourcery findings; both happened to be already addressed, but
  that was luck, not process.
- **This repository is public: every push is a publication** — on any
  branch, before any review or merge. The versioned pre-push hook
  (`.githooks/pre-push`, wired by `npm install` via `core.hooksPath`) is
  the only layer that runs *before* publication. It scans every commit
  being pushed, not just the final tree, because both 2026-10-03 leaks (a
  webhook URL and a live provider API key) had been removed from the tree
  by later commits while staying in the published history.
- **Never bypass the hook** (`--no-verify`), and never edit or disable the
  hook, the CI job or the ruleset to get a push through. A finding means
  the content of the offending local commit must be fixed (e.g.
  `git rebase -i`) before pushing.
- Forbidden references (home paths, tailnet hosts, webhook URLs, the
  owner's other projects) are maintained in ONE list,
  `scripts/forbidden-patterns.ts`, shared by the tree guard and the range
  scan. Generic credentials are gitleaks' job; a gitleaks false positive
  goes into `.gitleaksignore` with a comment, and only after confirming
  that the match is not a credential.
- History rewrites (`git filter-repo` + force push) require the owner's
  explicit instruction. The ruleset is disabled for exactly that operation
  and re-enabled immediately afterwards.

## 9. No hardcoded models — derive everything from what Pi uses

- **Owner rule 2026-10-06 (ADR-0025):** shipped source and shipped default
  configuration must not name a concrete model (ref, id, slug or family) in
  any position where it can **admit** a candidate, **select** a model
  (classifier, escalation, fallback), **rank** it (cost sentinels, quality
  order) or **exclude** it. This includes the flow that decides which model
  to use — the classifier is the most consequential selection in the router.
- Candidate pools, classifier/fallback choices, free-model sets and cost
  ordering are **derived** from Pi's registry (inventory, credentials via
  `hasConfiguredAuth`, list prices, capability flags), scan data, probes and
  learned state (ADR-0008) — never assumed.
- Allowed (ADR-0025 §2): (A) provider adapters that describe *how* to read a
  provider, (B) name-keyed annotation tables that only score/identify models
  Pi already supplied and can never admit one, (C) the user layer
  (`router-config.user.json`), where the user's own choices belong.
- The gate is `test/no-hardcoded-models.test.ts` with a **ratcheting
  baseline** (`scripts/hardcoded-model-baseline.json`): the baseline only
  shrinks. Never add an entry to make a PR green — derive instead. Tests may
  use model literals freely.
- Incident that motivated the rule (2026-10-06): a shipped `free_models` list
  was admitted on config presence alone, so users without that provider's key
  got dead candidates in every cheap group and in the classifier chain.

