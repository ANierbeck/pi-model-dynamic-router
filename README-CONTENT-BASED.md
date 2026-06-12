# PI Model Router — Content-Based Extension

**Inhaltssensitiver Router für PI**: Erweitert den bestehenden `pi-model-router` um eine **dynamische Klassifizierung von User-Prompts**, um basierend auf der **Komplexität/Kategorie** der Anfrage das optimale Modell auszuwählen.

---

## Warum dieser Fork?
Der originale [`a-canary/pi-model-router`](https://github.com/a-canary/pi-model-router) routet Modelle basierend auf:
- **Modellqualität** (GDPval-Scores),
- **Kosten** (Billing-Präferenzen),
- **Verfügbarkeit** (Rate-Limits, Latenz).

**Lücke**: Es fehlt eine **Echtzeit-Analyse des Inhalts** der Anfrage. Beispiel:
- Eine einfache Code-Editierung (`"Ersetze Zeile 42"`) könnte lokal mit Ollama bearbeitet werden.
- Eine komplexe Architektur-Frage (`"Entwirf eine Mikroservice-Architektur"`) sollte an Claude Opus gehen.

---

## Wie es funktioniert
### 1. Prompt-Klassifizierung
Ein lokales Modell (z. B. `ollama/gemma4:12b`) analysiert die User-Anfrage und klassifiziert sie in eine der folgenden Kategorien:

| Kategorie          | Beschreibung                                                                 | Beispiel                                  |
|--------------------|------------------------------------------------------------------------------|-------------------------------------------|
| `code_simple`      | Einfache Code-Änderungen (1–10 Zeilen, Syntax-Fixes, Typos).              | `"Ersetze 'foo' mit 'bar' in Zeile 42"` |
| `code_complex`     | Komplexe Code-Änderungen (Refactoring, Debugging, >50 Zeilen).           | `"Optimiere diese 200-Zeilen-Funktion"` |
| `design`           | Architektur, Systemdesign, API-Entwurf.                                    | `"Entwirf eine REST-API für X"`          |
| `planning`         | Projektplanung, Roadmaps, Aufgabenaufschlüsselung.                        | `"Erstelle einen Migrationsplan"`       |
| `exploration`      | Forschung, unklare Anforderungen, Brainstorming.                          | `"Welche Datenbank für 10M IoT-Geräte?"` |
| `fallback`          | Unklar oder mehrere Kategorien zutreffend.                                  | `"Hilfe"` oder `"Mach alles besser"`   |

### 2. Routing-Entscheidung
Basierend auf der Kategorie wird eine **Modellgruppe** ausgewählt:

| Kategorie          | Zielgruppe          | Modellbeispiele                          |
|--------------------|---------------------|------------------------------------------|
| `code_simple`      | `operational`       | `ollama/phi3:mini`, `mistral-tiny`      |
| `code_complex`     | `tactical`          | `mistral-medium`, `deepseek-coder`       |
| `design`           | `strategic`         | `claude-opus`, `gpt-4o`                 |
| `planning`         | `tactical`          | `mistral-medium`, `claude-sonnet`       |
| `exploration`      | `scout`             | `ollama/gemma4:12b`                      |
| `fallback`          | User-Bestätigung    | Nachfrage, welches Modell genutzt werden soll. |

### 3. Integration in den bestehenden Router
- **Hook**: Der `before_user_prompt`-Hook klassifiziert die Anfrage **vor** dem Routing.
- **Workflow**:
  1. User sendet Prompt.
  2. **Klassifizierung**: Prompt wird an `ollama/gemma4:12b` gesendet.
  3. **Routing**: Basierend auf der Kategorie wird eine Gruppe ausgewählt (z. B. `code_simple` → `operational`).
  4. **Modellauswahl**: Der bestehende Router wählt das beste Modell aus der Gruppe (basierend auf GDPval, Kosten, Verfügbarkeit).
  5. **Fallback**: Bei hohen Kosten (>5000 Tokens) oder Unsicherheit → User-Bestätigung.

---

## Installation
### 1. Fork klonen und installieren
```bash
git clone https://github.com/a-canary/pi-model-router /Users/anierbeck/git/pi-model-router-fork
cd /Users/anierbeck/git/pi-model-router-fork
npm install
```

### 2. Ollama-Modelle vorbereiten
```bash
# gemma4:12b wird genutzt (lokal bereits verfügbar)
ollama pull phi3:mini      # Fallback-Option
```

### 3. PI-Extension aktivieren
```bash
# Symlink für Entwicklung
ln -s /Users/anierbeck/git/pi-model-router-fork ~/.pi/agent/extensions/pi-model-router
# PI neu laden
/reload
```

---

## Testen
### 1. Unit-Tests (ohne Ollama)
```bash
npm test
```
- Testet die Klassifizierungslogik mit gemockten Ollama-Antworten.

### 2. Integrationstests (mit Ollama)
```bash
npm run test:integration
```
- **Voraussetzung**: Ollama muss laufen (`ollama serve`).
- Testet die Klassifizierung mit echten Prompts.

### 3. Manuell in PI testen
1. PI starten und eine Anfrage stellen.
2. Der Router sollte automatisch das Modell basierend auf der Kategorie auswählen.
3. Überprüfen mit:
   ```
   /router
   ```
   - Die aktive Gruppe und das Modell sollten angepasst sein.

---

## Konfiguration
### 1. Routing-Regeln anpassen
Die Zuordnung von Kategorien zu Gruppen kann in `src/content-classifier.ts` angepasst werden:
```typescript
// src/content-classifier.ts
export const CATEGORY_TO_GROUP = {
  code_simple: "operational",  // Einfach → günstige lokale Modelle
  code_complex: "tactical",    // Komplex → Remote, aber kosteneffizient
  design: "strategic",         // Design → beste verfügbare Modelle
  // ...
};
```

### 2. Klassifizierungs-Prompt anpassen
Der Prompt für die Ollama-Klassifizierung kann in `src/content-classifier.ts` modifiziert werden:
```typescript
const CLASSIFICATION_PROMPT = `
  Klassifiziere die folgende Anfrage in eine der Kategorien:
  code_simple, code_complex, design, planning, exploration, fallback.
  ...
`;
```

---

## Beispiel-Prompts und erwartete Routing-Entscheidungen
| User-Prompt                                                                 | Kategorie          | Gruppe          | Beispiel-Modell               |
|---------------------------------------------------------------------------|--------------------|------------------|--------------------------------|
| "Ersetze alle Vorkommen von 'oldVar' mit 'newVar' in dieser Datei."      | `code_simple`      | `operational`    | `ollama/phi3:mini`             |
| "Debugge diese rekursive Funktion — sie stürzt bei großen Eingaben ab." | `code_complex`     | `tactical`       | `mistral-medium`               |
| "Entwirf eine REST-API für ein Benutzerverwaltungssystem."              | `design`           | `strategic`      | `claude-opus`                  |
| "Erstelle einen Projektplan für die Umstellung auf TypeScript."       | `planning`         | `tactical`       | `mistral-medium`               |
| "Welche Datenbank eignet sich für Echtzeit-Analysen von 10M Datensätzen?" | `exploration`    | `scout`          | `ollama/gemma4:12b`             |
| "Hilfe"                                                                   | `fallback`         | User-Bestätigung | —                              |

---

## Offene Fragen & TODO
1. **Genauigkeit der Klassifizierung**:
   - Wie gut kann `gemma4:12b` die Kategorien unterscheiden?
   - *Aktion*: Manuelle Evaluation mit 20–30 Beispiel-Prompts.
2. **Performance**:
   - Latenz der Klassifizierung messen (Ziel: <500ms).
3. **User-Control**:
   - Soll der User die Klassifizierung überschreiben können (z. B. per `/model-hint complex`)?
4. **Kategorien erweitern**:
   - Fehlen Kategorien wie `documentation` (Dokumentationsgenerierung)?

---

## Entwicklung
### 1. Code-Struktur
```
pi-model-router-fork/
├── src/
│   ├── content-classifier.ts   # Kernlogik: Klassifizierung + Routing
│   └── ollama-utils.ts         # Hilfsfunktionen für Ollama-Aufrufe
├── skills/
│   └── content-based-router/   # Dokumentation des Skills
│       └── SKILL.md
├── test/
│   └── classifier.test.ts      # Unit- und Integrationstests
├── index.ts                    # Hauptdatei (Hook ist eingebunden)
└── README-CONTENT-BASED.md     # Diese Dokumentation
```

### 2. Wichtige Funktionen
- **`classifyPrompt()`** (`src/content-classifier.ts`):
  Klassifiziert einen Prompt mit Ollama.
- **`setupContentBasedRouting()`** (`src/content-classifier.ts`):
  Registriert den `before_user_prompt`-Hook in PI.
- **`callOllama()`** (`src/ollama-utils.ts`):
  Führt Ollama-Aufrufe aus (mit Fehlerbehandlung).

---

## Lizenz
MIT (wie der originale Router).