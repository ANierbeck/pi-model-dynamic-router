# Content-Based Model Router

**Purpose**: Extends the `pi-model-router` with **content-sensitive
routing logic**: it analyzes the user's prompt and dynamically selects the
appropriate model based on the request's **complexity/category**.

> **Current state (v1.6.0)**: this document originated as the design sketch
> for the shipped `dynamic` group. The implementation differs in the
> details documented below — the classification model is
> **mistral-nemo:latest** (primary) with **gemma2:2b** as the local
> fallback and a cloud-first candidate chain (see the README section
> "Dynamic Group" for the shipped behavior). No user confirmation is
> involved at runtime, and there is **no cost-based rerouting**: categories
> map straight to model groups via the shipped `CATEGORY_TO_GROUP` table
> (`src/content-classifier.ts`). Anything in this document that reads like
> a runtime prompt to the user ("Should I use a cheaper model?" — section 3
> fallback logic, the pseudocode at the end) is a **sketch idea that was
> never shipped**. Sections marked "shipped" describe real behavior;
> sections marked "sketch" describe the original proposal.

---

## Background
The existing `pi-model-router` routes based on:
- **model quality** (GDPval scores),
- **cost** (billing preferences),
- **availability** (rate limits, latency).

**Gap**: a **real-time analysis of the request's content** was missing.
Examples:
- A simple code edit ("Replace line 42") could be handled locally by Ollama.
- A complex architecture question ("Design a microservice architecture")
  should go to Claude Opus.

---

## How it works
### 1. Prompt classification
A light local model (shipped: `ollama/mistral-nemo:latest`, local fallback
`ollama/gemma2:2b`) analyzes the user's request and classifies it into one
of the following categories:

The categories **shipped** in `src/content-classifier.ts` (the authoritative
list — the original sketch had only six):

| Category           | Description                                                                   | Example                                                                   |
|--------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `trivial`          | Greetings, one-liners, questions about the router itself.                    | `"Hi"`                                                                    |
| `simple`          | Simple conversational requests.                                              | `"Thanks, that worked"`                                                   |
| `standard`        | Everyday tasks with no special shape.                                       | `"Summarize this file"`                                                   |
| `code_simple`      | Simple code changes (1–10 lines, syntax fixes, typos).                       | `"Replace 'foo' with 'bar' in line 42"`                                  |
| `code_complex`     | Complex code changes (refactoring, debugging, >50 lines).                    | `"Optimize this 200-line function for performance"`                      |
| `design`           | Architecture, system design, API design.                                     | `"Design an event-sourcing architecture for an e-commerce system"`       |
| `planning`         | Project planning, roadmaps, task breakdown.                                  | `"Create a 3-month plan for the Kubernetes migration"`                   |
| `exploration`      | Research, unclear requirements, brainstorming.                                | `"Which database would be suitable for 10M IoT devices?"`                |
| `fallback`         | Unclear, or several categories apply.                                         | `"Help"` or `"Make everything better"`                                   |

### 2. Routing decision (shipped)
Based on the category, a **model group** is selected via the shipped
`CATEGORY_TO_GROUP` table (`src/content-classifier.ts`). Example models
are illustrative only — the router picks the concrete model per group from
GDPval/cost/availability at runtime:

| Category           | Target group        | Rationale (shipped comment)                                                  |
|--------------------|---------------------|-----------------------------------------------------------------------------|
| `trivial`          | `scout`             | any free model                                                              |
| `simple`           | `operational`       | GDPval ≥ 300                                                                 |
| `standard`        | `operational`       | GDPval ≥ 300                                                                |
| `code_simple`      | `simple`            | GDPval ≥ 300, max_cost=0 (free models only)                                 |
| `code_complex`     | `tactical`          | GDPval ≥ 600                                                                 |
| `design`           | `tactical`          | GDPval ≥ 600                                                                 |
| `planning`         | `tactical`          | GDPval ≥ 600                                                                 |
| `exploration`      | `scout`             | any model, cheap                                                             |
| `fallback`         | `tactical`          | uncertain → use a decent model, not a free one                              |

Note: nothing maps to `strategic`, and there is no "user confirmation"
branch — the original sketch's `design → strategic` and
`fallback → ask the user` rows were never shipped.

### 3. Integration into the existing router
- **Integration point (shipped)**: there is no `before_user_prompt` hook —
  the `dynamic` group's `groupStream` runs the classifier inline when a
  prompt is routed to it (see `src/stream-orchestrator.ts` and
  `src/content-classifier.ts`).
- **Workflow (shipped)**:
  1. User sends a prompt while the active model is the `dynamic` group.
  2. **Classification**: the prompt is analyzed (cloud-first chain when
     `classifier_cloud_fallback` is enabled, then the local models above).
  3. **Routing**: a group is selected via `CATEGORY_TO_GROUP` (e.g.
     `code_simple` → `simple`).
  4. **Model selection**: the existing router picks the best model from
     the group (based on GDPval, cost, availability).
  5. **Uncertain classification**: the `fallback` category routes to
     `tactical` — no user prompt, no cost gate.

---

## Technical implementation
### 1. Classification prompt
The classification model receives a prompt like:
```text
Classify the following request into **exactly one** of the categories:
- code_simple
- code_complex
- design
- planning
- exploration
- fallback

**Request**: "{{user_prompt}}"

**Response format**:
{
  "category": "<category>",
  "reason": "<justification in 1–2 sentences>"
}
```

### 2. Example classifications
| User prompt                                                                    | Category           | Justification                                                              |
|--------------------------------------------------------------------------------|--------------------|-----------------------------------------------------------------------------|
| "Replace all occurrences of 'oldVar' with 'newVar' in this file."             | `code_simple`      | Simple text replacement, no logical complexity.                             |
| "Debug this recursive function — it crashes on large inputs."                 | `code_complex`     | Requires analysis of logic and performance.                                 |
| "Design a REST API for a user-management system."                             | `design`           | Architecture decisions, no implementation details.                         |
| "Create a project plan for the TypeScript migration."                         | `planning`         | Task breakdown and scheduling.                                             |
| "Which database is suitable for real-time analytics over 10M records?"       | `exploration`      | Open question without clear requirements.                                  |
| "Make this better."                                                            | `fallback`         | Unclear what is meant.                                                      |

### 3. Fallback logic (sketch — NOT shipped)
The original proposal asked the user on cost or uncertainty. **None of this
shipped**: the shipped classifier routes `fallback` → `tactical`
automatically and never consults the user. Kept for design history:

- **Cost check (sketch)**: if the estimated tokens are >5000 or the cost is >$0.50:
  ```text
  This request would use ~${costs} in ${model}. Should I use a cheaper model (e.g. Ollama) instead?
  ```
- **Uncertainty**: if the classification yields `fallback` or the local
  model is uncertain (`"reason": "unclear"`):
  ```text
  I'm not sure which model is best suited for this request. Would you like:
  1. A fast, local model (Ollama),
  2. A high-quality remote model (e.g. Claude Opus), or
  3. To decide yourself?
  ```

---

## Dependencies (shipped)
- **Local model**: `ollama/mistral-nemo:latest` (shipped primary) with
  `ollama/gemma2:2b` as the local fallback (or `ollama/phi3:mini` for
  better accuracy on small hardware).
- **No token-estimation or user-confirmation dependency**: the sketch's
  `tiktoken`/`gpt-tokenizer` cost gate was never implemented — the
  classifier returns `{ category, reason }` and routing is automatic.

---

## Open questions
1. **Classification accuracy**: how well can a small model distinguish
   the categories?
   - *Test*: manual evaluation with 20–30 example prompts.
2. **Performance**: how long does classification take (target: <500ms)?
3. **Fallback strategy**: should `fallback` always ask, or select a
   default group (e.g. `tactical`)? — *Shipped answer: route `fallback` →
   the `tactical` group automatically (`CATEGORY_TO_GROUP`); no asking.*
4. **User control**: should the user be able to override the
   classification (e.g. via a `/model-hint complex` prefix)? — *Shipped
   answer: yes, the HINT prefix mechanism.*

---

## Next steps
1. **Implement the prototype**:
   - classification function with the local model.
   - integration before routing.
   - routing logic for group selection.
2. **Test**:
   - manual tests with example prompts.
   - performance measurement (classification latency).
3. **Iterate**:
   - adjust categories and routing rules.
   - refine the fallback logic.

---

## Example code (pseudocode — NOT shipped, design sketch only)

Nothing below runs in the router: the real integration is the `dynamic`
group's `groupStream` (no `pi.hooks` API, no `askUser`, no cost
confirmation):
```javascript
// Classification function
async function classifyPrompt(prompt) {
  const classificationPrompt = `
    Classify the following request into one of the categories:
    code_simple, code_complex, design, planning, exploration, fallback.

    Request: "${prompt}"
    Response format: { "category": "...", "reason": "..." }
  `;

  const response = await callOllama("mistral-nemo:latest", classificationPrompt);
  return JSON.parse(response);
}

// Routing
pi.hooks.before_user_prompt(async ({ prompt, context }) => {
  const { category, reason } = await classifyPrompt(prompt);
  const group = categoryToGroup[category]; // shipped: CATEGORY_TO_GROUP covers every category
  const model = await router.resolveModelGroup(group);

  if (estimatedCost(prompt, model) > 0.50) {
    const confirmed = await askUser(
      `This request would cost ~$${estimatedCost(prompt, model)} in ${model}. Continue?`
    );
    if (!confirmed) return { model: "ollama/phi3:mini" };
  }

  return { model };
});
```

---
**Created:** 2026-09-27 · **Translated to English:** 2026-09-30 (AGENTS.md §3)
