# PI Model Router — Content-Based Extension

**Content-sensitive router for PI**: Extends the existing `pi-model-router` with **dynamic classification of user prompts** to select the optimal model based on the **complexity/category** of the request.

---

## Why This Fork?
The original [`a-canary/pi-model-router`](https://github.com/a-canary/pi-model-router) already handles:
- **Model quality** — GDPval-based ranking (composite intelligence + throughput + cost score)
- **Price routing** — tiered selection: cheapest model above a configurable quality floor
- **Availability** — rate-limit failover, key rotation, exponential backoff, stream retry
- **costMux** — automatic cost-penalty demotion after repeated 429s

See [README.md](./README.md) for a full description of these upstream features.

**Gap**: The upstream has no **real-time content analysis** of the request itself. Every prompt hits the same group regardless of complexity. For example:
- A simple code edit (`"Replace line 42"`) could be handled locally with Ollama.
- A complex architecture question (`"Design a microservice architecture"`) should go to Claude Opus.

This fork adds a **classification layer** that inspects the prompt *before* routing and selects the appropriate model group automatically.

---

## How It Works
### 1. Prompt Classification
A local model (e.g., `ollama/gemma4:12b`) analyzes the user request and classifies it into one of the following categories:

| Category          | Description                                                                 | Example                                  |
|-------------------|-----------------------------------------------------------------------------|------------------------------------------|
| `code_simple`     | Simple code changes (1–10 lines, syntax fixes, typos).              | `"Replace 'foo' with 'bar' in line 42"` |
| `code_complex`    | Complex code changes (refactoring, debugging, >50 lines).           | `"Optimize this 200-line function"`    |
| `design`          | Architecture, system design, API design.                                    | `"Design a REST API for X"`          |
| `planning`        | Project planning, roadmaps, task breakdown.                        | `"Create a migration plan"`       |
| `exploration`     | Research, unclear requirements, brainstorming.                          | `"Which database for 10M IoT devices?"` |
| `fallback`         | Unclear or multiple categories apply.                                  | `"Help"` or `"Make everything better"`   |

### 2. Routing Decision
Based on the category, a **model group** is selected:

| Category          | Target Group          | Model Examples                          |
|-------------------|-----------------------|------------------------------------------|
| `code_simple`     | `operational`         | `ollama/phi3:mini`, `mistral-tiny`      |
| `code_complex`    | `tactical`            | `mistral-medium`, `deepseek-coder`       |
| `design`          | `strategic`           | `claude-opus`, `gpt-4o`                 |
| `planning`        | `tactical`            | `mistral-medium`, `claude-sonnet`       |
| `exploration`     | `scout`               | `ollama/gemma4:12b`                      |
| `fallback`         | User confirmation    | Ask which model to use.                  |

### 3. Integration with Existing Router
- **Hook**: The `before_user_prompt` hook classifies the request **before** routing.
- **Workflow**:
  1. User sends prompt.
  2. **Classification**: Prompt is sent to `ollama/gemma4:12b`.
  3. **Routing**: Based on the category, a group is selected (e.g., `code_simple` → `operational`).
  4. **Model Selection**: The existing router selects the best model from the group (based on GDPval, cost, availability).

---

## Architecture

### Content Classifier (`src/content-classifier.ts`)
The classifier uses **Ollama (gemma4:12b)** for prompt classification:

```typescript
// Classification prompt sent to Ollama
export const CLASSIFICATION_PROMPT = `
Classify the following user request into exactly one category:
- trivial: Very simple requests ("list files", "show TODOs")
- simple: Simple questions ("explain briefly", "summarize")
- code_simple: Small code changes (1–10 lines, syntax fixes)
- standard: Standard requests (general questions, moderate complexity)
- code_complex: Substantial changes (refactoring, debugging, >50 lines)
- design: Architecture, system design, API design
- planning: Task breakdown, roadmaps, prioritization
- exploration: Vague or open-ended questions
- fallback: Ambiguous or short continuation

Current request:
{{prompt}}

Respond ONLY with a JSON object containing:
- category: one of the above categories
- reason: brief explanation
- confidence: 0.0-1.0 score
`;
```

### Classification Process
1. **Prompt Extraction**: Extract the last user prompt from the context.
2. **Ollama Call**: Send the prompt to Ollama with the classification prompt.
3. **JSON Parsing**: Parse the JSON response from Ollama.
4. **Fallback**: If Ollama fails, use static classification (keyword-based).

### Model Groups (`router-config.json`)
Each group defines:
- **Models**: List of models that belong to the group.
- **Method**: Selection method (`best`, `tiered`, `min_cost`, `dynamic`).
- **Criteria**: Minimum GDPval, maximum cost, etc.

Example:
```json
{
  "model_groups": {
    "scout": {
      "description": "Free models for simple tasks",
      "method": "min_cost",
      "max_cost": 0,
      "models": ["qwen/qwen3-4b:free", "google/gemma-3-4b-it:free"]
    },
    "operational": {
      "description": "Cost-effective models for standard tasks",
      "method": "tiered",
      "min_gdpval": 300,
      "max_cost_per_m": 0.5,
      "models": ["anthropic/claude-3-haiku", "openai/gpt-4o-mini"]
    }
  }
}
```

---

## Features

### ✅ Implemented
- [x] **Content-based classification** with Ollama
- [x] **Dynamic model group selection**
- [x] **Fallback to static classification**
- [x] **Cloud fallback** for classification
- [x] **Cost tier system** (free/budget/premium)
- [x] **HINT-Override** for manual model selection
- [x] **Session escalation** on loop detection

### 🚀 Planned
- [ ] **Multi-label classification**
- [ ] **Context-based classification**
- [ ] **Performance metrics**

---

## Usage

### Basic Usage
1. Install the extension:
   ```bash
   pi install git:github.com/ANierbeck/pi-model-dynamic-router
   ```
2. Reload PI:
   ```
   /reload
   ```
3. Use the dynamic model group:
   ```
   /model dynamic
   ```

### HINT-Override
Prefix your prompt with `HINT:` to bypass the automatic classifier and route directly to a specific model or group. Detection is deterministic (regex-based) — the LLM classifier is never called for HINT prompts.

**Route to a model** (all forms are equivalent):
```
HINT: mistral-medium-3.5
HINT: use mistral-medium-3.5
HINT: nutze mistral-medium-3.5
HINT: verwende mistral-medium-3.5
HINT: mistral/mistral-medium-3.5
```

**Route to a group** (English and German):
```
HINT: use group tactical
HINT: use group strategic
HINT: verwende Gruppe tactical
HINT: nutze gruppe complex
HINT: benutze Gruppe operational
```

The HINT is case-insensitive and may appear at the start of a multi-line prompt:
```
HINT: use group tactical
Refactor the authentication module to use JWT tokens.
```

Qualified provider refs are also accepted (`provider/model-name`). If the exact ref is not found in any group, the router tries the short name as a fallback.

### Session Escalation
When the router detects that a session is stuck in a loop (repeated errors or correction keywords), it automatically upgrades the model group for subsequent requests.

**Escalation ladder**: `operational` → `tactical` → `strategic`

Detection runs every three turns and uses two complementary mechanisms:

1. **Rule-based** (synchronous): checks the last 2 turns for error keywords (`error`, `failed`, `wrong`, …) and user correction phrases (`again`, `still`, `nochmal`, `immer noch`, …). Triggers immediately.
2. **LLM-based** (fire-and-forget): sends the same history to `gemma2:2b` in the background for a semantic loop judgment. Only escalates if the rule-based check was quiet, to avoid double-escalation.

The escalation level resets at the start of each new session.

---

## Configuration

### `router-config.json`
Configure model groups, providers, and cost tiers:
```json
{
  "providers": {
    "openrouter": {
      "billing": "pay_per_token",
      "free_models": ["openrouter/qwen/qwen3-4b:free"]
    }
  },
  "model_groups": {
    "dynamic": {
      "description": "Dynamic model selection based on content",
      "method": "dynamic"
    }
  },
  "cost_tiers": {
    "free": {"max_cost_per_m": 0.01, "max_cost_per_request": 0.01},
    "budget": {"max_cost_per_m": 0.75, "max_cost_per_request": 1.5},
    "premium": {"max_cost_per_m": 10.0, "max_cost_per_request": 20.0}
  }
}
```

---

## Development

### Prerequisites
- Node.js >= 20.11.0
- Ollama (optional, for local classification)

### Installation
```bash
npm install
```

### Tests
```bash
npm test
```

### Build
```bash
npm run build
```

---

## Contributing
- All documentation **MUST** be in English
- All code comments **MUST** be in English
- Follow the existing code style
- Add tests for new features
