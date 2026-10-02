# ADR-0021: The router never registers models Pi does not know

- Status: accepted (2026-10-02)
- Supersedes: the F4 scan-union registration (2026-09-02, "make scan-discovered
  variants visible to routing"); retires most of ADR-0019's round-trip machinery.
- Related: ADR-0005 (registerProvider replaces, never merges), AGENTS.md §6
  (never overwrite existing registrations).

## Context

The Mistral 422 investigation ("store" field rejected, `ministral-3b/8b/14b-2512`
classifier-probe failures, 320+ log entries) traced the failures to their root
cause: the router's scan-union registered scan-discovered models into Pi's
registry with `api: 'openai-completions'`. For `mistral` alone that added 29
models Pi's builtin catalog does not ship — including OCR models
(`mistral-ocr-*`) and audio models (`voxtral-mini-*`) registered as **chat**
models. Pi's own Mistral models use `mistral-conversations`, which never sends
`store`; the openai-completions API does (`compat.supportsStore` detection in
pi-ai, `openai-completions.js`). The 422 was a symptom of the wrong API — and
the wrong API was a symptom of the router inventing model registrations.

The fork's design principle (owner decision, 2026-10-02):

> "Unser Fork kümmert sich explizit um Modelle, welche schon im Pi registriert
> sind, und nutzt diese. Alles andere ist ein Rückschritt!"
> ("Our fork explicitly takes care of models that are already registered in
> Pi and uses them. Everything else is a step backwards!")

The original pi-model-router shipped its own model lists; the fork moved away
from that long ago. But the F4 scan-union quietly reintroduced exactly that:
the router, not Pi, decided which models exist.

The union registration was also the root of a whole defect class that existed
only to make re-registration *safe*:

- Ü1 — `registerProvider` replaces the provider's `models` array wholesale;
  a naive union silently deleted Pi's own registrations (compat flags
  included).
- roborev 425/426 HIGH — the first Ü1 fix passed only the new models, wiping
  the known ones.
- roborev 649 HIGH — the union started from the scan's subset, wiping
  Pi-registered models the scan does not report.
- ADR-0019 — `getAll()` being chat-only meant the round-trip wiped non-chat
  inventory unless every field was feature-detected and allow-listed.

Every one of these guarded a call that should not exist.

## Decision

1. **The router never registers a model or provider into Pi's registry that
   Pi does not already know.** Pi's registry (builtin catalog + models.json +
   extensions) is the single source of truth for the cloud model inventory.
   The scan-union registration is removed. Exceptions (see Out of scope): the
   LOCAL Ollama registration, explicitly-configured `free_models` on demand,
   and the router's own virtual group providers — each is either local
   reality Pi cannot discover or explicit user/router intent, never scan
   discovery.
2. **The scan stays, with a narrowed role**: local inventory (Ollama / LM
   Studio), GDPval scraping, OpenRouter pricing, and capability data in the
   cache. Scan entries for models Pi does not know are inert:
   - the snapshot builder's streamability filter (2026-09-20 ghost-model
     incident) drops refs unresolvable in Pi's registry,
   - the classifier-fallback probe skips refs `find()` cannot resolve,
   - live candidate resolution is registry-first (`allDiscoveredRefs`,
     which falls back to `cache.available_models` only when no
     `modelRegistry` is in scope — in that branch the streamability filter
     cannot run (no registry to query), so only the exclude / virtual-group
     / scopedModels guards apply; structurally the fallback refs must still
     be members of a generated-config group, and group membership already
     passed the persist-path registry filter. The path is practically
     unreachable in a live session, where `modelRegistry` is always in
     scope, and is unchanged by this ADR).
   No separate "Pi-known" filter is needed — the existing defenses already
   key on Pi's registry; the union registration was the only thing that made
   scan-only refs resolvable.
3. **Scan data enriches only refs that survive via Pi's registry.** Scoring,
   pricing, and capability lookups are by ref; a ref present via the
   registry still finds its scan data in the cache.

## Consequences

- New provider models (e.g. `ministral-8b-2512`) appear in routing when Pi's
  catalog — or the user's `models.json` — ships them, not before.
- Provider API keys must live where Pi resolves them (`auth.json`,
  `models.json`). Router-config provider keys alone no longer make a
  provider's models routable: the union was the only path that injected them
  into a registration. (Owner setup unaffected: `auth.json` carries the
  mistral / mistral-zai / openrouter keys.)
- The Mistral 422 "store" symptom disappears with its cause. No
  `compat.supportsStore` special case is needed — there is nothing left to
  register with the wrong API. No manual cleanup of the 29 invented Mistral
  registrations is needed either: a Pi restart rebuilds the registry from
  catalog + models.json + extensions, and the extension registrations the
  scan-union wrote vanish with the old session.
- Removed with the union: the Ü1 round-trip, the ADR-0019 field allow-list,
  the `[scan-union]` log line, `SKIP_REGISTRATION`, and
  `piKnownProviderSet()`. ADR-0019's remaining value is its documentation of
  Pi 0.99.1's registry composition; its round-trip preservation concern is
  retired.

## Out of scope (unchanged; separate owner decisions pending)

- **Ollama registration** stays (LM Studio was never registered — it sat in
  the removed `SKIP_REGISTRATION` set; its refs are scan/cache-only and
  streamable via the `isLocalProvider` exemption): Pi has no live
  local-discovery mechanism, and the local scan is the only source of real
  `num_ctx` / capability data. Known issue found during this investigation:
  the guard
  compares untagged models.json ids against tag-suffixed scan ids
  (`gemma4` vs `gemma4:latest`), so a Pi registration the router should
  respect is silently replaced each session (83× in the live logs). Owner
  decision required: fix the guard, or move local registration to models.json
  entirely.
- **`registerFreeModelOnDemand`** stays: it acts only on explicitly configured
  `free_models` (user intent, not scan discovery), and on 0.99.1 it never
  fires for builtin-catalog providers (`getRegisteredProviderIds` includes
  them all).
- **Virtual group providers** (`registerGroupProviders`) stay: the router's
  own product surface, not foreign models.
