# Content-Based Model Router

**Zweck**: Erweitert den `pi-model-router` um eine **inhaltssensitive Routing-Logik**, die den Prompt des Users analysiert und basierend auf der **Komplexität/Kategorie** der Anfrage dynamisch das passende Modell auswählt.

---

## Hintergrund
Der bestehende `pi-model-router` routet basierend auf:
- **Modellqualität** (GDPval-Scores),
- **Kosten** (Billing-Präferenzen),
- **Verfügbarkeit** (Rate-Limits, Latenz).

**Lücke**: Es fehlt eine **Echtzeit-Analyse des Inhalts** der Anfrage. Beispiel:
- Eine einfache Code-Editierung (`"Ersetze Zeile 42") könnte lokal mit Ollama bearbeitet werden.
- Eine komplexe Architektur-Frage (`"Entwirf eine Mikroservice-Architektur") sollte an Claude Opus gehen.

---

## Funktionsweise
### 1. Prompt-Klassifizierung
Ein leichtes lokales Modell (z. B. `ollama/gemma2:2b`) analysiert die User-Anfrage und klassifiziert sie in eine der folgenden Kategorien:

| Kategorie          | Beschreibung                                                                 | Beispiel                                                                 |
|--------------------|------------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `code_simple`      | Einfache Code-Änderungen (1–10 Zeilen, Syntax-Fixes, Typos).              | `"Ersetze 'foo' mit 'bar' in Zeile 42"`                                |
| `code_complex`     | Komplexe Code-Änderungen (Refactoring, Debugging, >50 Zeilen).           | `"Optimiere diese 200-Zeilen-Funktion für Performance"`                |
| `design`           | Architektur, Systemdesign, API-Entwurf.                                    | `"Entwirf eine Event-Sourcing-Architektur für ein E-Commerce-System"`   |
| `planning`         | Projektplanung, Roadmaps, Aufgabenaufschlüsselung.                        | `"Erstelle einen 3-Monats-Plan für die Migration zu Kubernetes"`        |
| `exploration`      | Forschung, unklare Anforderungen, Brainstorming.                          | `"Welche Datenbank wäre für 10M IoT-Geräte geeignet?"`                  |
| `fallback`          | Unklar oder mehrere Kategorien zutreffend.                                  | `"Hilfe"` oder `"Mach alles besser"`                                   |

### 2. Routing-Entscheidung
Basierend auf der Kategorie wird eine **Modellgruppe** ausgewählt:

| Kategorie          | Zielgruppe          | Modellbeispiele                                                                 |
|--------------------|---------------------|-------------------------------------------------------------------------------|
| `code_simple`      | `operational`       | `ollama/phi3:mini`, `mistral-tiny` (lokal, schnell, günstig)               |
| `code_complex`     | `tactical`          | `mistral-medium`, `deepseek-coder` (remote, günstig, gute Code-Qualität)  |
| `design`           | `strategic`         | `claude-opus`, `gpt-4o` (beste verfügbare Option)                          |
| `planning`         | `tactical`          | `mistral-medium`, `claude-sonnet` (gute Balance aus Qualität und Kosten)  |
| `exploration`      | `scout`             | `ollama/gemma2:2b`, `mistral-tiny` (günstig, schnell)                      |
| `fallback`          | User-Bestätigung    | Frage den User, welches Modell genutzt werden soll.                        |

### 3. Integration in den bestehenden Router
- **Hook**: Nutze den `before_user_prompt`-Hook von PI, um die Analyse **vor** dem Routing durchzuführen.
- **Workflow**:
  1. User sendet Prompt.
  2. **Klassifizierung**: Prompt wird an `ollama/gemma2:2b` gesendet.
  3. **Routing**: Basierend auf der Kategorie wird eine Gruppe ausgewählt (z. B. `code_simple` → `operational`).
  4. **Modellauswahl**: Der bestehende Router wählt das beste Modell aus der Gruppe (basierend auf GDPval, Kosten, Verfügbarkeit).
  5. **Fallback**: Bei hohen Kosten (>5000 Tokens) oder Unsicherheit → User-Bestätigung einholen.

---

## Technische Umsetzung
### 1. Klassifizierungs-Prompt
Das lokale Modell erhält folgenden Prompt zur Analyse:
```text
Klassifiziere die folgende Anfrage in **genau eine** der Kategorien:
- code_simple
- code_complex
- design
- planning
- exploration
- fallback

**Anfrage**: "{{user_prompt}}"

**Antwortformat**:
{
  "category": "<Kategorie>",
  "reason": "<Begründung in 1–2 Sätzen>"
}
```

### 2. Beispiel-Klassifizierungen
| User-Prompt                                                                 | Kategorie          | Begründung                                                                 |
|---------------------------------------------------------------------------|--------------------|-----------------------------------------------------------------------------|
| "Ersetze alle Vorkommen von 'oldVar' mit 'newVar' in dieser Datei."      | `code_simple`      | Einfache Textersetzung, keine logische Komplexität.                        |
| "Debugge diese rekursive Funktion — sie stürzt bei großen Eingaben ab." | `code_complex`     | Erfordert Analyse von Logik und Performance.                               |
| "Entwirf eine REST-API für ein Benutzerverwaltungssystem."              | `design`           | Architektur-Entscheidungen, keine Implementierungsdetails.                |
| "Erstelle einen Projektplan für die Umstellung auf TypeScript."       | `planning`         | Aufgabenaufschlüsselung und Zeitplanung.                                  |
| "Welche Datenbank eignet sich für Echtzeit-Analysen von 10M Datensätzen?" | `exploration`    | Offene Frage ohne klare Anforderungen.                                    |
| "Mach das besser."                                                           | `fallback`         | Unklar, was gemeint ist.                                                   |

### 3. Fallback-Logik
- **Kostencheck**: Wenn die geschätzten Tokens >5000 oder die Kosten >$0.50 sind:
  ```text
  Diese Anfrage würde ~${costs} in ${model} verbrauchen. Soll ich stattdessen ein günstigeres Modell (z. B. Ollama) verwenden?
  ```
- **Unsicherheit**: Wenn die Klassifizierung `fallback` ergibt oder das lokale Modell unsicher ist (`"reason": "unclear"`):
  ```text
  Ich bin unsicher, welches Modell für diese Anfrage am besten geeignet ist. Möchtest du:
  1. Ein schnelles, lokales Modell (Ollama) verwenden,
  2. Ein hochwertiges Remote-Modell (z. B. Claude Opus) wählen, oder
  3. Selbst entscheiden?
  ```

---

## Abhängigkeiten
- **Lokales Modell**: `ollama/gemma2:2b` (schnell, leicht) oder `ollama/phi3:mini` (bessere Genauigkeit).
- **Token-Schätzung**: `tiktoken` oder `gpt-tokenizer` zur Kostenabschätzung.
- **PI-Hooks**: `before_user_prompt` für die Echtzeit-Analyse.

---

## Offene Fragen
1. **Genauigkeit der Klassifizierung**: Wie gut kann `gemma2:2b` die Kategorien unterscheiden?
   - *Test*: Manuelle Evaluation mit 20–30 Beispiel-Prompts.
2. **Performance**: Wie lange dauert die Klassifizierung (Ziel: <500ms)?
3. **Fallback-Strategie**: Soll bei `fallback` immer nachgefragt werden, oder eine Default-Gruppe (z. B. `tactical`) wählen?
4. **User-Control**: Soll der User die Klassifizierung überschreiben können (z. B. per `/model-hint complex`)?

---

## Nächste Schritte
1. **Prototyp implementieren**:
   - Klassifizierungsfunktion mit `ollama/gemma2:2b`.
   - Integration in den `before_user_prompt`-Hook.
   - Routing-Logik für die Gruppenauswahl.
2. **Testen**:
   - Manuelle Tests mit Beispiel-Prompts.
   - Performance-Messung (Latenz der Klassifizierung).
3. **Iteration**:
   - Kategorien und Routing-Regeln anpassen.
   - Fallback-Logik verfeinern.

---

## Beispiel-Code (Pseudocode)
```javascript
// Klassifizierungsfunktion
async function classifyPrompt(prompt) {
  const classificationPrompt = `
    Klassifiziere die folgende Anfrage in eine der Kategorien:
    code_simple, code_complex, design, planning, exploration, fallback.

    Anfrage: "${prompt}"
    Antwortformat: { "category": "...", "reason": "..." }
  `;

  const response = await callOllama("gemma2:2b", classificationPrompt);
  return JSON.parse(response);
}

// PI-Hook
pi.hooks.before_user_prompt(async ({ prompt, context }) => {
  const { category, reason } = await classifyPrompt(prompt);
  const group = categoryToGroup[category] || "tactical"; // Fallback
  const model = await router.resolveModelGroup(group);

  if (estimatedCost(prompt, model) > 0.50) {
    const confirmed = await askUser(
      `Diese Anfrage würde ~$${estimatedCost(prompt, model)} in ${model} kosten. Fortfahren?`
    );
    if (!confirmed) return { model: "ollama/phi3:mini" };
  }

  return { model };
});
```