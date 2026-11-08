# Router config UI: a guided path for optional integrations

**Status:** proposed 2026-11-08 — not started. Depends on the contract in
[`2026-11-08-optional-integrations-config.md`](2026-11-08-optional-integrations-config.md)
(`integrations.*` namespace, health registry, `config integration` subcommand);
it adds the *interactive* layer on top. Not a 2.0.0 blocker by itself, but the
rename it builds on is (`2026-10-25-laya-sole-classifier.md`, "Release gate").

## Problem

The config surface has no guided path: a user can only reach an optional
integration by knowing key names and editing JSON.

1. **`/router config` is read-mostly.** Bare shows the config sources and the
   exclude rules; the subcommands are `exclude`, `unexclude` and `compaction`
   (`src/commands.ts:234-237`). There is no way to see or change an
   integration.
2. **Enabling Laya requires knowing six keys and their valid values**
   (`enabled`, `checkpoint`, `endpoint`, `mode`, `confidence_threshold`,
   `timeout_ms` — `src/types.ts:255-300`) and hand-editing the user layer. A
   wrong value does not fail loudly: the loader warns and disables the stage
   (`src/config-loader.ts:256`), so the user believes Laya runs while the chain
   answers.
3. **The interactive UI exists and is unused.** `ctx.ui.select`, `confirm` and
   `input` are part of `ExtensionUIContext`
   (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:85-93`)
   and the command context exposes exactly those four
   (`types.d.ts:567`). The router calls only `notify`.
4. **Status is a per-feature special case.** `/router status` prints one Laya
   line (`src/commands.ts:207`); a second integration would add a second
   special case.

## Solution

1. **`/router config integration <name>`** — an interactive wizard built on
   `ctx.ui.select` / `confirm` / `input`:
   - shows the current state (enabled, mode, endpoint, reported identity);
   - offers the actions that apply (enable, disable, change mode, change port);
   - validates through the integration contract **before** writing, so the
     wizard cannot produce a config the loader would reject;
   - writes the global user layer only (the trust rule of the integrations
     plan), applies live, and prints what changed.
   Non-interactive (`/router config integration laya mode=shadow`) stays
   available for scripts and for the print/RPC modes where `select` is not
   available.
2. **One "Integrations" section** in `/router config` (bare) and `/router
   status`, rendering every registered integration the same way: enabled, mode,
   endpoint, health (`ok | down | unknown`), reported identity, last error.
   `/router config` keeps its current sources/exclude output above it.
3. **Unknown-key warnings** come from the integrations plan (decision 2); this
   plan only renders them where the user looks after a wizard run.
4. **The wizard never downloads.** It may *point* at the install skill
   (`2026-11-08-laya-model-artifact.md`) when no weights are installed, but it
   does not fetch anything itself — setup stays a confirmed, separate step.

## Open decisions

1. **Wizard scope:** the four common actions (enable/disable/mode/port) or
   every field including `confidence_threshold` and `timeout_ms`?
   Recommendation: the four, with the rest shown read-only plus a pointer to
   the file.
2. **Does the wizard run in `print`/RPC mode?** `select` is interactive-only;
   the fallback is the non-interactive form plus a clear message.
   Recommendation: fall back, never hang.
3. **Where does "Integrations" live — `/router config` or `/router status`?**
   The integrations plan puts the health registry in `/router status`.
   Recommendation: full detail in `/router config`, one summary line per
   integration in `/router status`.

## Verified against

Commit `a20ac9e` (`main`, 2026-11-08):

- `src/commands.ts:234-237` (usage lines: `config`, `config exclude`,
  `config unexclude`, `config compaction`), `:471-488`
  (`handleConfigCommand` subcommand dispatch), `:544-568` (autocomplete items),
  `:207` (the Laya status line), `:591` (`ctx.ui.notify` as the only UI call).
- `src/types.ts:255-300` (`ClassifierLayaConfig` field set),
  `src/config-loader.ts:256,291,302,308` (invalid values warn and fall back
  instead of failing).
- `ExtensionUIContext` with `select`/`confirm`/`input`/`notify`
  (`types.d.ts:85-93`) and the command-context pick (`types.d.ts:567`).

**Not checked:** whether `select` renders acceptably in long option lists (the
group list already uses autocomplete instead — worth a smoke test); whether the
RPC mode's `select` rejects or resolves `undefined`.

## Steps

- [ ] Owner decides 1–3.
- [ ] Red-first: wizard tests with a stubbed `ctx.ui` — a cancelled dialog
      writes nothing; an invalid value is rejected before the write; the
      non-interactive form produces the same config as the wizard.
- [ ] Red-first: "Integrations" section tests (one integration, two, none,
      unreachable) with snapshot-free assertions on the rendered lines.
- [ ] Implement the wizard on top of the integration contract.
- [ ] Implement the section in `/router config` and the summary line in
      `/router status`.
- [ ] Docs: `docs/config-override.md` (guided setup), README pointer, CHANGELOG
      under 2.0.0.
