# ADR-0009: Union-merge for `exclude.*` arrays, and the bundled classifier model as source of truth

**Status**: Accepted (2026-09-26). Decided by the owner after a code review
of the 2026-09-26 fixes (`d3a51e3`, `fce3f2b`) found that neither fix had
any effect on the owner's machine.

## Context

Two fixes shipped on 2026-09-26 were silently ineffective in the owner's
live setup. A test suite that was green locally masked both.

### 1. The static blocklist was overwritten by the user config

`fce3f2b` added 14 permanently blocked OpenRouter free models to
`exclude.models` in the bundled `router-config.json`. Config loading is
layered (`src/config-loader.ts`): bundled defaults, then
`~/.pi/agent/router-config.user.json`, then `<project>/.pi/router-config.json`.
`deepMergeConfig` merges objects recursively but **replaced arrays
wholesale**. The owner's user config carries its own
`exclude.models` (`*fable*`, `*opus*`, `*nemotron-3*`,
`deepseek-v4-flash-0731`). That list replaced the bundled one, so the two
inkling models, lfm-2.5, both laguna models, glm-5.2 and both minimax
models stayed routable. The failure pattern that motivated the blocklist
continued unchanged.

The same effect hid a red CI. Tests load the real user config from `$HOME`,
so locally the user's list replaced the bundled one and a test using
`z-ai/glm-5.2:free` as a fixture kept passing. CI has no user config and
failed on every push from `fce3f2b` on. The failure went unnoticed because
the push was reported as done without checking the CI result.

### 2. The classifier default was overridden by the bundled config

`d3a51e3` changed `DEFAULT_MODEL` in `src/content-classifier.ts` from
`gemma4:12b-mlx` (Ollama MLX backend, HTTP 501 on every JSON-schema call) to
`mistral-nemo:latest`. But `stream-orchestrator.ts` passes
`model_groups.dynamic.classifier_model` from the config into the classifier,
and the bundled `router-config.json` still said `ollama/gemma4:12b-mlx`.
`DEFAULT_MODEL` only applies when the config key is absent, which it
never is. The effect: classification ran on the `gemma2:2b` fallback, and
every 24 h (after the `classifier_no_schema` mark expired) one call was
burned on a guaranteed 501. README, PI.md and AGENT.md also still named
gemma4:12b-mlx as primary.

## Decision Drivers

- **Exclusions are a safety property.** A model on the bundled blocklist is
  known to fail permanently. A user adding one personal exclusion must not
  silently re-admit it.
- **Least surprise for ordered lists.** `fallback_groups` and group `models`
  are ordered preferences. Unioning them would produce orderings nobody
  wrote. They must keep replace semantics.
- **One source of truth per setting.** A default in code that is always
  overridden by a bundled config value is dead code that looks alive.
- **Local green must mean CI green.** Tests must not depend on the
  developer's `$HOME`.

## Options Considered

### Blocklist merge

**A — Keep replace semantics; move the 14 refs into the user config.**
Fixes the owner's machine only. Every other user with an `exclude.models`
of their own has the same hole, and the next bundled addition is lost
again. Rejected.

**B — Union all arrays everywhere.** Breaks ordered lists: a project
`fallback_groups: ["c"]` would become `["a", "b", "c"]`. Rejected.

**C — Union only arrays directly under the top-level `exclude` block
(accepted).** `exclude.models`, `exclude.providers` and
`exclude.paid_models_from` accumulate across layers, base order first,
deduplicated. Everything else keeps replace semantics.
Cost: a higher layer can no longer *remove* a lower layer's exclusion. If
that is ever needed, it gets an explicit mechanism (e.g. an
`include`/`allow` override list). An array that silently drops entries is
not an acceptable substitute.

### Classifier model

**A — Remove `classifier_model` from the bundled config and rely on
`DEFAULT_MODEL`.** One source of truth in code, but the config key is the
documented way users pick their classifier. Removing it from the example
hides the knob. Rejected.

**B — Set the bundled `classifier_model` to `ollama/mistral-nemo:latest`
and pin it to `DEFAULT_MODEL` with a test (accepted).** The config remains
the visible, documented knob. A test asserts the bundled value equals
`ollama/${DEFAULT_MODEL}` and is not an `-mlx` model, so the two can never
drift apart again.

## Decision

1. `deepMergeConfig` takes a key path. Arrays at path `exclude.<key>` are
   unioned (`[...new Set([...base, ...override])]`). All other arrays are
   replaced as before. A nested key merely named `exclude` below the top
   level is not affected.
2. `model_groups.dynamic.classifier_model` in the bundled
   `router-config.json` is `ollama/mistral-nemo:latest`.
3. The test fixture in `test/free-model-on-demand-registration.test.ts`
   uses a fictional model (`openrouter/test-vendor/fixture-model:free`)
   instead of a real ref that sits on the blocklist.
4. Docs updated: `docs/config-override.md` (merge semantics), README.md,
   PI.md, AGENT.md (classifier model).

## Consequences

**Easier:**
- Bundled blocklist entries apply to every user regardless of their own
  exclusions. ADR-0008's point 7 (static list as manual override) now
  holds in practice.
- The classifier runs on a schema-capable primary. Its config value and the
  code default are pinned together by a test.

**Harder / new risks:**
- A user cannot un-exclude a bundled entry via override. Accepted until a
  concrete need appears.
- Behaviour change for anyone relying on "my `exclude.models` replaces the
  default". The only bundled entries are the 14 permanently failing refs,
  so no working model is lost.

**Open follow-up (not decided here):** tests still read the real
`~/.pi/agent/router-config.user.json`. This change removes the specific
masking effect (the user list now unions instead of replacing), but other
user settings (e.g. `paid_models_from`) can still make local results differ
from CI. Isolating `homedir()` in the test harness is the proper fix, and
checking the CI result after every push remains mandatory.

## Tests

- `test/config-loader.test.ts`: `exclude.*` arrays union (order, dedupe,
  all three keys); arrays outside `exclude` still replace; a nested key named
  `exclude` is not unioned; project exclusions accumulate on top of global
  ones.
- `test/config-excludes-guardrail-blocked.test.ts`: the bundled blocklist
  survives a merge with the owner's actual user-config shape. This test fails
  under replace semantics.
- `test/config-classifier-model.test.ts`: the bundled classifier model is not
  MLX and equals `ollama/${DEFAULT_MODEL}`.
