# ADR-0007: Task decomposition and delegation to cheap worker models

**Status**: Exploratory — no code changes yet. This document captures the
2026-09-15/18 discussion and analysis before any implementation decision.

## Context

Spotify's engineering blog ("Portal by Spotify cut my Claude Code token usage
by 90%", Sept 2026) describes a Claude Code plugin (`shunt`) that:

1. Intercepts `Read`/`Bash cat|head|tail` calls via `PreToolUse` hooks when a
   file exceeds a line threshold.
2. Redirects the read to a cheap "worker" model (Gemini 2.5 Flash) running as
   an ephemeral "AiKA Mode" (Spotify's internal agent-as-a-function platform)
   that summarizes the file(s) and returns structured bullets.
3. Does the same for boilerplate code generation (tests, config stubs) via a
   second mode, writing output directly to disk so Claude never sees the
   generated code as expensive output tokens.
4. Reports ~90% token savings on bulk-read scenarios in their benchmark.

**We do not want to adopt Spotify's Portal/AiKA platform.** It's a proprietary
internal system (Backstage-based) not available outside Spotify. The
*principle* — route I/O-heavy, low-reasoning work to a cheap model and reserve
the expensive model for reasoning — is the reusable idea, not their specific
implementation.

## What the router already does (baseline)

- **Group-based cost/quality routing** (`router-config.json` /
  `router-defaults.yaml`): groups like `trivial`, `simple`, `scout` already
  bias toward free/cheap models; `strategic`/`complex` bias toward high-GDPval
  models. This is *model selection per group*, decided once per request by
  `resolve()` — not per-subtask within a single request.
- **Live token forwarding**: `consumeWithDetection()` (index.ts) pushes every
  `text_delta` to Pi immediately — the router never buffers/withholds partial
  output.
- **`dynamic` group**: classifies a prompt once (via a local Ollama classifier
  with cloud fallback) and picks ONE group for the whole request. This is the
  closest existing analog to "routing decision", but it's a single
  classification for the entire prompt, not a decomposition into subtasks.

## The user's actual ask (2026-09-18, clarified)

> "aktuell machen wir das auf 'Befehlsebene' ... In Zukunft wäre es sinnvoller,
> den Befehl auf unterschiedliche 'Aufgaben' zu zerlegen und dann die
> einfachen Dinge mit den einfachen Modellen machen zu lassen, um
> anschließend das große Modell auf den Ergebnissen laufen zu lassen."

Concretely: **decompose a single user command into subtasks, route the
I/O-heavy/mechanical subtasks (e.g. "read and summarize these 5 files") to a
cheap model, then feed the summarized results into the expensive model for
the reasoning/synthesis step** — same shape as Spotify's bulk-reader, but
without an external platform dependency.

## Why this does NOT fit inside `pi-model-dynamic-router` as currently scoped

The router is a **Pi extension that intercepts `streamSimple` for a single
model reference**. It has no visibility into:

- What Claude/Pi is about to do with a tool call (it's not a `PreToolUse`
  hook — the router only sees `Context`/messages when *it* is asked to
  stream a completion, not when Pi's main agent loop decides to call `Read`).
- Multi-step task planning. The router resolves ONE model ref per request; it
  is stateless across turns and has no task/subtask model.

**Decomposing a command into subtasks and orchestrating cheap-model +
expensive-model steps is an agent-loop / orchestration concern, not a model
*routing* concern.** The router picks *which model* answers a single
completion request; it does not decide *how many* completion requests a task
should be split into, or what each one should contain. Building that inside
`index.ts`'s `streamSimple` hook would mean re-implementing a task planner
and a subagent dispatcher inside a model router — a scope violation and a
duplication of functionality Pi already exposes via subagents (see below).

## Where this belongs instead

Pi already has a **subagent system** (`pi-subagents`, exposed as the
`subagent` tool) that supports exactly the "decompose into tasks, run some in
parallel, pick a model per task" pattern:

- `subagent({ agent, task, model })` — dispatch one bounded task to a named
  agent, with an explicit `model` override (bare id or `provider/id`, with a
  thinking-level suffix like `:low`).
- `subagent({ workflowScript, args })` — run a JS orchestration script that
  can call `runs.run(key, { agent, task, model })` and `runs.all([...])` to
  fan out N independent subtasks **in parallel**, each with its own model.
- Because `model` accepts any exact `provider/id` from Pi's registry, a
  workflow script can send the "read and summarize these files" subtasks to
  `trivial/trivial` or `scout/scout` (cheap groups our router already
  resolves) and the final synthesis step to `strategic/strategic` — all
  without the router itself doing any decomposition. **Verified live**
  (2026-09-18): `subagent({action: "models"})` lists `complex/complex`,
  `dynamic/dynamic`, `dynamic/dynamic:use-static`, `fallback/fallback` as
  addressable model refs in the session's registry — these are exactly the
  virtual providers `registerGroupProviders()` (index.ts:1255) registers, one
  per configured group, with provider name == model id == group name (not
  `dynamic/<group>` — each group is its own top-level provider). The
  registration loop is unconditional over every entry in `cfg.model_groups`,
  so `trivial/trivial`, `simple/simple`, `scout/scout`, `tactical/tactical`,
  `operational/operational`, `standard/standard`, and `strategic/strategic`
  are registered identically, even though the truncated live listing ("...and
  60 more") didn't render them inline. **This confirms the core premise of
  this ADR is not theoretical: any Pi subagent workflow can already address
  our cheap groups today, no router code change required.**

This means: **the router's job stays "resolve a group name to the best
available model reference." The decomposition/orchestration job belongs to
whatever calls the router** — either the main Pi agent loop's own planning,
or an explicit subagent workflow the user/agent invokes. The router's only
required contribution is to keep exposing well-behaved cheap groups
(`trivial`, `scout`, `simple`) that a subagent workflow can address by name
via `dynamic/<group>` model refs, which it already does.

## Where the router *could* still help (in-scope, incremental)

1. **Document the pattern**: add a section (README or a skill) showing how to
   call `pi-model-dynamic-router` groups from a subagent workflow, e.g.
   `subagent({ workflowScript: "return runs.all([...files.map(f => ({key: f, agent: 'scout', model: 'trivial/trivial', task: 'Summarize ' + f}))])" })`
   fanned out in parallel, followed by one `strategic/strategic` synthesis
   call over the collected summaries. This costs nothing to build — it's a
   docs-only change — and directly delivers the "cheap model reads, expensive
   model reasons" value the user wants, using infrastructure that already
   exists and is verified working (see verification note above).
2. **Nothing else changes in the router's code** for this specific ask. No
   new group method, no new `delegate` provider, no PreToolUse hook — those
   would duplicate subagent orchestration inside the router, which is exactly
   the scope violation this ADR argues against.

## Explicitly rejected approaches (from earlier, less careful analysis)

- ~~New `delegate`/`bulk_scan` group methods inside the router that call a
  second "worker model" from within `groupStream`~~ — this conflates model
  *routing* (picking a ref) with *task orchestration* (deciding how many
  calls to make and what goes in each). Wrong layer.
  - Also, note this reasoning was based on turns 5. Turn 5's specific
    "cooldown collapse" and "checkpoint hint" ideas are a **separate,
    unrelated topic** (see the 2026-09-15 memory entries
    `project.pi-model-router.collapse_strategy_decision_2026_09_15` and
    `project.pi-model-router.teilergebnisse_decision_2026_09_15`) that got
    conflated with the Spotify discussion in an earlier draft of this
    analysis — corrected here.
- ~~A Claude-Code-style `PreToolUse` hook inside the router~~ — the router is
  not a tool-call interceptor; Pi's hook system (if/when exposed to
  extensions) would be a different extension point entirely, not something
  `pi-model-dynamic-router` should absorb.

## Next step

Done — see the "Verified live" note above for the research finding (no
separate research doc was needed; `pi-subagents`, already a listed skill in
this environment, is sufficient). The only remaining router-side deliverable
is the docs addition in point 1 above (README section with a concrete
`subagent(...)` example). No ADR status change to "Accepted" is needed
because no router code changes.
