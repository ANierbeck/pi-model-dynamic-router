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

## Spotify's reference architecture (detail lost in the first draft)

The Context section above compressed `shunt` into four bullets. The
underlying architecture has details that matter for judging feasibility of
a Pi equivalent, so they're captured here explicitly.

**Three layers, degrading gracefully:**

1. **Hooks** (`PreToolUse`) — `check-file-size` blocks any `Read` over a
   configurable line threshold (default 350, `SHUNT_MIN_LINES` env var) and
   tells Claude to use the `/bulk-reader` skill instead. `check-bash-read`
   does the same for `cat`/`head`/`tail`/`less`/`more` on large files.
   **Targeted reads pass through untouched**: a `Read` with `offset`/`limit`,
   or a piped `cat file | grep ...`, is assumed to already be narrow enough
   that delegation wouldn't help.
2. **Scripts** — two bash wrappers around the Portal CLI. `bulk-read` wraps
   each file in XML tags and sends them + a question to the `bulk-reader`
   mode; safe to call repeatedly with the same paths for follow-up
   questions because each invocation is stateless/ephemeral (nothing stored
   server-side) and the file corpus never enters Claude's own context.
   `code-write` sends a spec + a *required* reference file to the
   `code-writer` mode, strips markdown fences from the output, and writes
   straight to disk — Claude never sees the generated code as output
   tokens.
3. **Skills** — markdown files telling Claude when/how to call the
   scripts. Purely advisory on their own, but layered under the hooks so
   **the system degrades gracefully**: even if Claude ignores the skill,
   the hook still blocks the oversized read. This is the key structural
   idea — enforcement doesn't depend on the orchestrating model cooperating.

**Two modes** (the "worker" side; Gemini 2.5 Flash in the article's
examples, but model-agnostic — `model` accepts anything configured on the
Portal instance):
- `bulk-reader` — read + summarize into structured bullets, no prose, no
  preambles.
- `code-writer` — generate code matching an existing reference file's
  conventions exactly, output only code (explicitly "no markdown fences" —
  the article notes this instruction matters, otherwise Claude has to parse
  fences back out of the response).

**What explicitly does NOT work** (the article's own "What doesn't work"
section — directly relevant to scoping any Pi equivalent):
- **Can't delegate editing.** Worker summaries don't carry reliable line
  numbers, so Claude still reads the specific section directly before
  editing. Delegation only saves tokens on *understanding*, not on the
  read-before-edit step.
- **Can't delegate reasoning.** The worker model found surface-level
  patterns but missed a subtle thread-safety bug that Claude caught in
  seconds once given the right context. Routing explicitly excludes
  debugging, architectural decisions, and safety-critical code.
- **Latency.** Each delegation is a network round-trip (10-30s typical,
  Portal caps a single invocation at 30s). Acceptable for large reads,
  counterproductive for small ones — this is *why* the line threshold
  exists, not an incidental detail.

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

- What Claude/Pi is about to do with a tool call — the router only sees
  `Context`/messages when *it* is asked to stream a completion, not when
  Pi's main agent loop decides to call `Read`.
- Multi-step task planning. The router resolves ONE model ref per request; it
  is stateless across turns and has no task/subtask model.

**Correction (2026-09-18, follow-up discussion)**: the original draft of this
ADR claimed Pi has no `PreToolUse`-equivalent hook at all, concluding that
Spotify's *enforced* interception (vs. advisory-only delegation) simply isn't
buildable in Pi. That claim was wrong and has been removed. Pi's extension
API (`node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`) DOES
expose exactly this seam:

- **`tool_call`** — fires before a tool executes, can `{ block: true, reason
  }` it (Spotify's `shunt` pattern: block a large `read`, tell the agent to
  use a delegation path instead).
- **`tool_result`** — fires after a tool executes, can transparently replace
  its `content` before the calling model ever sees it. This is strictly
  better than blocking for this use case: call a cheap model to summarize a
  large `read` result and substitute the summary, with no dependence on the
  orchestrating model cooperating with a redirect instruction.

So an enforced, Spotify-equivalent (or better) delegation layer IS technically
buildable in Pi. It still does not belong inside `pi-model-dynamic-router`,
for the same scope reason as before: intercepting tool calls/results is a
different extension point than resolving a model ref for a completion
request, and conflating them would mean this router starts making
tool-execution decisions it has no context for. It would have to be a
**separate, new Pi extension** — one that could reuse `pi-model-dynamic-router`
groups (via `trivial/trivial` etc., same as the subagent path above) as its
cheap-model backend, closing the loop without merging the two concerns.

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

## Who actually decomposes a task today? (2026-09-18, follow-up)

The subagent path above proves cheap groups are *addressable*, but it does
not answer who *decides* to split a task. As of this writing:

- **Nobody does it automatically.** `pi-subagents`' own operating rules
  explicitly say subagents should be invoked only when the operator
  requested delegation — "task size, complexity, risk, tool-call count,
  recipe fit, or an available specialist does not independently authorize
  delegation." So the orchestrating agent (Claude, in this environment) does
  not proactively decompose "read a file, then implement based on it" into a
  cheap-read + expensive-implement split unless a human asks for it, per
  request.
- **An enforced version is technically buildable** (see the `tool_call` /
  `tool_result` correction above), but does not exist as any installed
  extension in this environment today. It would require a new, separate Pi
  extension implementing the equivalent of Spotify's `shunt` — most cleanly
  via a `tool_result` hook on `read` (and maybe `bash cat/head/tail`) that
  summarizes oversized results with a cheap model before the expensive model
  sees them.
- **A weaker, advisory-only alternative** (a skill/CLAUDE.md instruction
  telling the orchestrating agent to proactively delegate large reads) has
  the same failure mode Spotify identified with their own first version:
  "the rules were advisory, not enforced — Claude could ignore them."

**Conclusion: this is a real, currently-unfilled gap**, not a solved problem.
Building the enforced version is a legitimate, separate project (a new Pi
extension, not a `pi-model-dynamic-router` change) if the token-cost savings
are worth the engineering effort — not yet scoped or decided.

## Feasibility check against this repo's own preconditions (AGENTS.md / AGENT.md)

Before treating any of the above as a green light, checked both (a) this
revision's docs-only change and (b) the hypothetical future
enforced-delegation extension against this repo's hard rules (`AGENTS.md`)
and architecture notes (`AGENT.md`):

- **This revision (docs-only)**: fully compliant. English-only throughout
  (rule 3), no release action implied (rule 1 N/A), no code touched so
  rules 4/6 don't apply yet, commit will use the `docs:` prefix (rule 5).
- **Ü1 invariant** (rule 6, `AGENTS.md`; "Provider Registration" section,
  `AGENT.md`): `pi.registerProvider` replaces a provider's model list
  wholesale, so any new registration must not clobber an existing one. The
  hypothetical future extension does **not** need to register any provider
  of its own — it would address the router's already-registered virtual
  group providers (`trivial/trivial`, `scout/scout`, ...) by model ref,
  exactly as the subagent-addressability verification above already
  confirmed live. By construction it inherits zero Ü1 risk. Worth stating
  explicitly so a future implementer doesn't "helpfully" register a
  dedicated `delegate-worker` provider instead of reusing the existing
  groups — that would reintroduce the exact risk Ü1 guards against.
- **Tests & verification** (rule 4): N/A to this docs-only revision. Would
  apply in full (`tsc --noEmit`, `vitest run`, non-vacuous regression
  tests per the "Ü1 invariant test" lesson) to the future extension's own
  codebase, wherever it lives — it would not inherit this repo's
  `vitest.config.ts` coverage thresholds since it's a separate
  extension/repo per the scope decision above.
- **Release approval** (rule 1): N/A — no tag/publish implied by this ADR
  edit. Flagged here only so it isn't forgotten later: the future
  extension, if built, is its own release surface with its own explicit,
  named approval gate — this router's release process doesn't cover it.
- **Single source of truth** (rule 2): the future extension's own
  operating rules (which tool calls trigger delegation, threshold
  defaults, etc.) belong in *that* extension's own `AGENTS.md`, not bolted
  onto this router's. This ADR documents the *decision*, not the future
  extension's operating rules.

**Conclusion: yes, implementable.** Nothing in this repo's preconditions
blocks either the docs-only change proposed here or the hypothetical
future extension — the two are cleanly decoupled by the scope decision
already made above. The one still-untested technical claim: the
`tool_result` hook's documented ability to attach nested `usage` for a
sub-model call (`docs/extensions.md` shows the type signature: `return {
content: [...], usage: nestedModelUsage }`) has been read, not exercised
against a live Pi session in this investigation. Worth a small spike
before committing engineering time to the full extension — not a blocker
to documenting the design now.

## Next step

1. Done — the subagent-addressability research and the README example
   (point 1 above) are both in place; `pi-subagents`, already a listed skill
   in this environment, is sufficient for *manually invoked* delegation.
2. Open — decide whether to scope and build the separate enforced-delegation
   extension described above (`tool_result` hook + cheap-model summarization).
   Not started; no code exists for it yet in this repo or elsewhere in this
   environment as far as this investigation found.

No ADR status change to "Accepted" is needed because no `pi-model-dynamic-router`
code changes are implied by either point.
