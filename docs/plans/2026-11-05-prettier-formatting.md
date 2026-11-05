# Prettier: format the code once, then keep it formatted

**Status:** in progress 2026-11-05. Owner decisions 2026-11-05: 1a (code only),
2a (the redundancy metric skips import/export scaffolding), 3 = both (CI AND
the pre-push hook). Empirical correction to step 2's assumption: the reformat
does NOT leave repeatedBlocks neutral — it normalises real duplicated test
fixtures and raises the count 43 -> 53, which the ratchet forbids. Owner
decision (same day): re-sequence — (1) this PR lands the gate tool, the metric
fix and .prettierignore WITHOUT the CI/hook enforcement (every enforcement run
would be red until the reformat exists); (2) a dedupe round extracts the
fixture families the reformat revealed (plan step 5, now known to be 4-5
families across ~40 files, not 3 classes); (3) the reformat lands last, with
the CI step, the pre-push hook wiring and their pins, and re-measured
baselines. Step 4's lint prediction (-4 findings) held exactly (919 -> 915,
measured on the reformatted tree, branch save/prettier-reformat).

AGENTS.md §11: one problem per plan. This one is only about formatting. The
lint gate (`docs/plans/2026-11-04-lint-gate.md`) is the neighbouring problem and
is deliberately out of scope; the two meet at exactly one point (see step 4).

## Problem

`prettier` 3.8.4 and a `.prettierrc` have been in the repo for months, and
`eslint-config-prettier` is the last entry of `eslint.config.js`, so no ESLint
rule fights the formatter. But the config has **never been applied**:

- no `format` / `format:check` script, no CI step, no `.prettierignore`;
- `npx prettier --check .` reports **371 files** as unformatted — 264 of the
  309 tracked `.ts`/`.js` files (186 in `test/`, 57 in `src/`, 19 in `scripts/`,
  `index.ts`, `eslint.config.js`), 90 markdown files, 10 config/data files.

The cost is not cosmetic. Every hand-written diff has to guess the style, and
reviewers spend attention on wrapping instead of behaviour. The lint gate cannot
help: `eslint-config-prettier` turns all stylistic rules off precisely because
the formatter is supposed to own them — a formatter that never runs leaves that
job to nobody.

A repo-wide `--write` is mechanically safe but not free. Measured in a probe
tree (`git archive HEAD`, `prettier --write` on `src test scripts index.ts
eslint.config.js`):

- `npx tsc --noEmit` clean, suite 2620 passed / 3 skipped — with two failures
  that both need a decision:
  1. `test/no-external-references.test.ts` fails **only in the probe** (no
     `.git`, so `git ls-files` is empty). Artifact, not a real regression.
  2. `test/redundancy-baseline.test.ts` fails: `repeatedBlocks` **45 → 60**.
     The redundancy ratchet forbids raising an entry, so the reformat cannot
     land as-is.
- The +15 is a **metric artifact, not new duplication**. `findRepeatedBlocks`
  (`scripts/redundancy-report.ts`) compares 6 *physical* lines. Prettier
  normalizes module headers, so a 6-line window of import statements now
  matches across files: `import { describe, it, expect, vi } from 'vitest';`
  (×3), `} from './helpers/extension-harness.ts';` (×3),
  `import path from 'node:path';`, `import type { AssistantMessageEvent } …`,
  plus wrapped object literals (`role: 'assistant',` ×16,
  `cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },`).
  The measured list of the 15 new blocks is in this plan's "Verified against".
- Reformatting also **lowers the lint baseline by 4 findings** (all
  `no-unsafe-member-access`): prettier removes redundant parentheses, e.g.
  `(sessionCtx?.modelRegistry)?.getApiKeyForProvider?.(…)` →
  `sessionCtx?.modelRegistry?.getApiKeyForProvider?.(…)`, which changes what the
  rule reports. The baseline must be re-measured, not assumed unchanged.

## Solution

1. **`.prettierignore` first.** Today `prettier --check .` walks everything
   that exists locally: `dist/`, `coverage/`, `archive/`, `.worktrees/`,
   `reports/`, plus data files. Ignore: build/state output (`dist/`,
   `coverage/`, `reports/`, `.stryker-tmp/`), local-only trees (`archive/`,
   `.worktrees/`), machine data (`docs/mutation-data/`), and the **historical
   documents** `docs/adr/`, `docs/plans/`, `docs/research/`, `CHANGELOG.md` —
   §12 forbids editing an ADR, and a plan is history once committed. That is
   79 of the 90 unformatted markdown files.
2. **Make the redundancy metric format-insensitive** (red-first): a window that
   consists only of `import`/`export … from` scaffolding is not a copy-pasted
   test body. A test seeds three files whose 6-line import header is identical
   (must not count) and three files with a real repeated setup (must count).
   Without this step the ratchet blocks the reformat; with it the reformat is
   neutral or lowers the count.
3. **Scripts + CI.** `npm run format` (`prettier --write .`) and
   `npm run format:check` (`prettier --check .`), plus a `format:check` step in
   the required `test` job next to `npx tsc --noEmit` and `npm run lint`
   (~2.3 s for the 264 code files, measured). No ruleset change needed.
4. **The reformat itself**, one commit: `src/`, `test/`, `scripts/`,
   `index.ts`, `eslint.config.js` — 264 files, ~7.9k changed lines, no
   behaviour. In the *same* commit: re-measure `scripts/lint-baseline.json` and
   `CEILING_FINDINGS` (expected −4) and `scripts/redundancy-baseline.json` +
   `CEILING` (after step 2), and raise the AGENTS.md §4 ratchet by the tests
   added in step 2.
5. **Follow-ups the reformat reveals** (own commits, not part of the reformat):
   the blocks that are *real* duplication — the `role: 'assistant'` message
   fixture in 16 files, the `cost: { input: 0.1, … }` model fixture, and the
   `on: vi.fn((event, handler) => …)` stub in 7 files that
   `test/helpers/extension-harness.ts` could own. Each is a `refactor:` commit
   that lowers `repeatedBlocks` again.

## Open decisions (owner) — all decided 2026-11-05

1. **Scope of round 1 — decided: (a) code only.** (a) Code only — `src/`, `test/`, `scripts/`,
   `index.ts`, `eslint.config.js` (recommended: 264 files, zero prose, the
   whole point of the formatter). (b) Code plus the six shipped docs
   (`README`, `PI`, `AGENTS`, `TODO`, `RELEASE_CHECKLIST`, `CLAUDE`): prettier's
   markdown reflow rewrites tables and lists, so the diff is large and reads as
   a content change even where it is not. (c) Everything — includes the shipped
   data files: `model-map.yaml` alone changes 308 lines, `router-config.json`
   42, `router-defaults.yaml` 20, for no readability gain in files that are
   data, not code.
2. **The `repeatedBlocks` ratchet — decided: (a) metric skips import/export.** (a) Make the metric skip import/export
   scaffolding (step 2, recommended — small, tested, and it fixes a real
   false-positive class). (b) Dedupe the 15 blocks — impossible for import
   headers, and a 16-file fixture extraction is its own round. (c) Raise the
   baseline — forbidden by the ratchet rule ("never raise an entry to make a PR
   green").
3. **Where the check runs — decided: CI AND the pre-push hook.** CI only (recommended: formatting is not a defect
   class, and the pre-push hook already carries the secret scan and the lint
   gate) or additionally in `.githooks/pre-push` (+~2.3 s per push).

## Verified against

Working tree at `chore/ship-changelog` (`ce22dce`) on 2026-11-05, and a probe
tree built from `git archive HEAD` with `node_modules` symlinked
(`/tmp/pretty-probe`).

Checked:

- `npx prettier --check .` → 371 files. Per area: `test/` 186, `src/` 57,
  `scripts/` 19, `index.ts` 1, `eslint.config.js` 1, markdown 90 (79 of them
  historical), config/data 10 (`.github/dependabot.yml`,
  `.github/workflows/test.yml`, `docs/mutation-data/nightly-r{1,2,4}.json`,
  `model-map.yaml`, `router-config.json`, `router-defaults.yaml`,
  `stryker.config.json`, `tsconfig.json`), `skills/` 2.
- Probe `prettier --write src test scripts index.ts eslint.config.js '*.json'
  '*.yaml' '*.md'`: 262 code files changed, ~15.9k diff lines (±), i.e. ~7.9k
  changed lines; `npx tsc --noEmit` clean; `npx vitest run` 2620 passed /
  3 skipped with the two failures named in the Problem section.
- `node scripts/redundancy-report.ts` in the probe: `repeatedBlocks` 45 → 60.
  The 15 new blocks (file count, preview):
  `16 role: 'assistant',` · `12 const mod = await import('../index.ts');` (was
  12 too) · `7 on: vi.fn((event: string, handler: any) => {` (×2 variants) ·
  `6 } from './helpers/extension-harness.ts';` (×3 variants) ·
  `3 import { describe, it, expect, vi } from 'vitest';` ·
  `import path from 'node:path';` ·
  `import type { AssistantMessageEvent } from '@earendil-works/pi-ai';` ·
  `const actual = await orig<typeof import('../src/logger.ts')>();` ·
  `const ctx: any = { modelRegistry, cwd: tmpDir, ui: { setFooter: vi.fn() } };` ·
  `const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);` ·
  `const onHandlers: Record<string, (ev: any, ctx: any) => any> = {};` ·
  `const { ctx: pi, onHandlers } = makeExtensionContext();` ·
  `cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },` ·
  `cost: { input: number; output: number };` ·
  `let handler: ((args: string, ctx: any) => Promise<void>) | undefined;` ·
  `method: 'min_cost_if_all_priced',` · `openrouter_pricing: {},` ·
  `provider: 'paid-cloud-provider',`.
- `node scripts/lint-gate.ts` in the probe: 4 stale entries, all
  `no-unsafe-member-access`, each one lower (`index.ts` 15→14,
  `src/dynamic-config-runner.ts` 15→14, `src/free-model-registration.ts` 9→8,
  `src/scan-runner.ts` 34→33).
- `npx prettier --check src test scripts index.ts eslint.config.js` runs in
  2.3 s.

Not checked: the shipped docs' reformat (never run — decision 1), `.github/`
and the config/data files (not reformatted in the probe), whether the
`skills/` markdown should be formatted (2 files), and the interaction with the
open lint slices S3–S5 (a reformat moves lines; the lint baseline is keyed by
file and rule, not by line, so it should be unaffected beyond the 4 entries
above — verified only for the probe tree).
