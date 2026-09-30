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
> involved at runtime; categories map straight to model groups.

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

| Category           | Description                                                                   | Example                                                                   |
|--------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `code_simple`      | Simple code changes (1–10 lines, syntax fixes, typos).                       | `"Replace 'foo' with 'bar' in line 42"`                                  |
| `code_complex`     | Complex code changes (refactoring, debugging, >50 lines).                    | `"Optimize this 200-line function for performance"`                      |
| `design`           | Architecture, system design, API design.                                     | `"Design an event-sourcing architecture for an e-commerce system"`       |
| `planning`         | Project planning, roadmaps, task breakdown.                                  | `"Create a 3-month plan for the Kubernetes migration"`                   |
| `exploration`      | Research, unclear requirements, brainstorming.                                | `"Which database would be suitable for 10M IoT devices?"`                |
| `fallback`         | Unclear, or several categories apply.                                         | `"Help"` or `"Make everything better"`                                   |

### 2. Routing decision
Based on the category, a **model group** is selected:

| Category           | Target group        | Example models                                                              |
|--------------------|---------------------|-----------------------------------------------------------------------------|
| `code_simple`      | `operational`       | `ollama/phi3:mini`, `mistral-tiny` (local, fast, cheap)                     |
| `code_complex`     | `tactical`          | `mistral-medium`, `deepseek-coder` (remote, cheap, good code quality)      |
| `design`           | `strategic`         | `claude-opus`, `gpt-4o` (best available option)                             |
| `planning`         | `tactical`          | `mistral-medium`, `claude-sonnet` (good quality/cost balance)              |
| `exploration`      | `scout`             | `ollama/gemma2:2b`, `mistral-tiny` (cheap, fast)                           |
| `fallback`         | user confirmation   | Ask the user which model to use.                                            |

### 3. Integration into the existing router
- **Hook**: use Pi's real-time analysis **before** routing.
- **Workflow**:
  1. User sends a prompt.
  2. **Classification**: the prompt is analyzed (shipped: cloud-first
     chain when enabled, then the local models above).
  3. **Routing**: a group is selected based on the category (e.g.
     `code_simple` → `operational`).
  4. **Model selection**: the existing router picks the best model from
     the group (based on GDPval, cost, availability).
  5. **Fallback**: on high cost or uncertainty → the `fallback` group
     (shipped behavior; the sketch below proposed asking the user).

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

### 3. Fallback logic
- **Cost check**: if the estimated tokens are >5000 or the cost is >$0.50:
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

## Dependencies
- **Local model**: `ollama/mistral-nemo:latest` (shipped primary) with
  `ollama/gemma2:2b` as the local fallback (or `ollama/phi3:mini` for
  better accuracy on small hardware).
- **Token estimation**: `tiktoken` or `gpt-tokenizer` for cost estimation.
- **Pi hooks**: real-time analysis before prompt routing.

---

## Open questions
1. **Classification accuracy**: how well can a small model distinguish
   the categories?
   - *Test*: manual evaluation with 20–30 example prompts.
2. **Performance**: how long does classification take (target: <500ms)?
3. **Fallback strategy**: should `fallback` always ask, or select a
   default group (e.g. `tactical`)? — *Shipped answer: a `fallback` group.*
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

## Example code (pseudocode)
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
  const group = categoryToGroup[category] || "tactical"; // fallback
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
