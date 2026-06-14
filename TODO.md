# 🚀 pi-model-router - Current Tasks & Roadmap

> **Status**: Updated with cost-efficient dynamic routing Phase 2 implementation
> **Last Updated**: June 14, 2026
> **Current State**: ✅ Migration complete, all tests green (192), Cloud-Fallback implemented, HINT-Override implemented, model boundaries improved, cost tiers system implemented

## 📌 **IMPORTANT RULES**

### Documentation Language
- **ALL documentation MUST be in English** - This includes:
  - Code comments
  - JSDoc comments
  - Markdown files (README.md, TODO.md, etc.)
  - Commit messages
  - Type definitions and interfaces
- **Rationale**: International project, English is the lingua franca of development
- **Exception**: None - all German comments/documentation must be translated to English

---

## ✅ **Abgeschlossene Aufgaben**

### Migration & Refactoring
- [x] **Modulare Architektur implementiert** (8 Module)
- [x] **Strangler Fig Pattern angewendet** (inkrementelle Migration)
- [x] **Alle 40+ Funktionen in Module verschoben**
- [x] **index.ts von 1.528 auf 1.047 Zeilen reduziert** (-481 Zeilen)
- [x] **Alle 91 Tests grün** (88 Unit + 3 Integration)
- [x] **Dokumentation aktualisiert** (README.md, SKILL.md, REFACTORING_SUMMARY.md)
- [x] **Veraltete Planungsdateien archiviert**

### Module
- [x] `src/types.ts` - Typdefinitionen
- [x] `src/providers.ts` - Provider-Definitionen (24 Provider)
- [x] `src/utils.ts` - Hilfsfunktionen
- [x] `src/rate-limit.ts` - RateLimitManager
- [x] `src/discovery.ts` - DiscoveryManager
- [x] `src/metrics.ts` - Metrics Modul
- [x] `src/cache.ts` - CacheManager
- [x] `src/routing.ts` - Router
- [x] `src/content-classifier.ts` - Content-Klassifizierung
- [x] `src/ollama-utils.ts` - Ollama-Hilfsfunktionen

---

## 🎯 **Priorisierte Aufgaben (Next Steps)**

### 🔥 **Sofort umsetzbar** (Quick Wins - 1-2 Stunden)

#### 0. **Kritische Verbesserungen** ⭐⭐⭐⭐⭐

**Wichtig zum Verständnis des dynamischen Modus:**
- *Zweck*: Im dynamischen Modus (`/model dynamic`) entscheidet der Router **automatisch**, welches Modell am besten zur Anfrage passt
- *Ablauf*: User-Prompt → Klassifizierung (Ollama/Cloud/Statisch) → Modellauswahl basierend auf Kategorie → Antwort
- *Vorteil*: Kostenoptimierung durch Verwendung des günstigsten geeigneten Modells
- *HINT-Override*: User kann diese automatische Entscheidung überschreiben mit z.B. `HINT: use mistral-medium-3.5`

- [x] **HINT-Override System** - ✅ **LLM-basiert implementiert**
  - *Zweck*: User kann die automatische Modellauswahl überschreiben
  - *Funktionsweise*:
    - **Funktioniert in ALLEN Modi** (dynamisch, statisch, direkt) - HINT wird in der Klassifizierung erkannt
    - User fügt `HINT: use mistral-medium-3.5` oder `HINT: use group tactical` zum Prompt hinzu
    - Das LLM erkennt den HINT und klassifiziert mit `category: "hint:mistral-medium-3.5"` oder `category: "hint:group:tactical"`
    - Die `classifyPrompt` Funktion extrahiert dann das Modell/die Gruppe und gibt es zurück
  - *Implementierung*:
    - **Keine Regex mehr!** - HINT-Erkennung ist jetzt in den `CLASSIFICATION_PROMPT` integriert
    - Der Prompt enthält jetzt eine HINT-Rule: "If the request contains a HINT instruction... return it with the 'hint:' prefix"
    - Unterstützt alle Sprachen (deutsch, englisch, etc.) und Formate
    - `classifyPrompt` erkennt HINT-Kategorien und extrahiert Modell/Gruppe
  - *Status*: ✅ **Funktioniert jetzt korrekt mit LLM-basierter Erkennung**
  - *Vorteile*:
    - Keine Regex-Probleme mehr mit natürlicher Sprache
    - Funktioniert in allen Sprachen
    - Funktioniert mit beliebigen Formaten (mit/ohne Doppelpunkt, verschiedene Befehle)
    - Einfacher zu warten und zu erweitern

- [x] **Modellabgrenzung verbessern** - ✅ **Implementiert mit GDPval-basierten Modell-Grenzen**
  - *Lösung*: 
    - `CATEGORY_TO_GROUP`-Mapping in `src/content-classifier.ts` ordnet Kategorien Modell-Gruppen basierend auf GDPval-Anforderungen zu
    - `router-config.json` enthält Modell-Gruppen mit `min_gdpval`-Schwellenwerten für präzise Modellauswahl
    - Komplexe Aufgaben (code_complex, design, planning) → tactical-Gruppe (GDPval ≥ 600) → enthält `mistral/mistral-medium-3.5`
    - Standard-Aufgaben → operational-Gruppe (GDPval ≥ 300)
    - Triviale/Einfache Aufgaben → scout-Gruppe (beliebige kostenlose Modelle)
  - *Aktuelles Mapping*:
    ```typescript
    trivial: 'scout' (beliebige kostenlose Modelle)
    simple: 'operational' (GDPval ≥ 300)
    code_simple: 'operational' (GDPval ≥ 300)
    standard: 'operational' (GDPval ≥ 300)
    code_complex: 'tactical' (GDPval ≥ 600) → enthält mistral-medium-3.5
    design: 'tactical' (GDPval ≥ 600) → enthält mistral-medium-3.5
    planning: 'tactical' (GDPval ≥ 600) → enthält mistral-medium-3.5
    exploration: 'scout' (beliebige günstige Modelle)
    fallback: 'tactical' (unsicher → nutze gutes Modell)
    ```
  - *Modell-Gruppen in router-config.json*:
    - `complex`-Gruppe: min_gdpval: 600, Modelle: [claude-3-sonnet, gpt-4o, mistral/mistral-medium-3.5]
    - `tactical`-Gruppe: min_gdpval: 600, Modelle: [mistral/mistral-medium-3.5]
    - `operational`-Gruppe: min_gdpval: 300, Modelle: [mistral/mistral-medium-3.5, codestral-latest, claude-3-haiku]
  - *Status*: ✅ **Vollständig implementiert mit präzisen Modell-Grenzen**
  - *Impact*: **HOCH** - Bessere Modellauswahl, höhere Qualität
  - *Abhängigkeiten*: `src/content-classifier.ts`, `router-config.json`, `src/routing.ts`

- [ ] **Session-Eskalation bei Kreis-Erkennung** - Modell automatisch hochstufen wenn Session stagniert
  - *Problem*: Wenn ein Modell dasselbe Problem mehrfach falsch löst (Session "dreht im Kreis"), hilft oft nur ein stärkeres Modell
  - *Idee*: Erkennung anhand gleicher Fehler-Keywords, wiederholter kurzer Prompts oder User-Korrekturen in n aufeinanderfolgenden Turns → automatisch eine Tier-Stufe nach oben (`operational → tactical → strategic`)
  - *Signale*: gleiche Fehlermeldung 2× gesehen, User schreibt "nochmal", "immer noch", "schon wieder", Review-Findings steigen statt fallen
  - *Impact*: **HOCH** - verhindert Frustrations-Loops mit schwachen Modellen
  - *Aufwand*: 3-4 Stunden (Kreis-Detektion ist komplex)
  - *Abhängigkeiten*: `index.ts` (turn-Kontext mitführen, Eskalations-Logik)
- [x] **Kosteneffizientes dynamisches Routing** - ✅ **Phase 2 implementiert**
  - *Lösung*: Kostenstufen-System (free/budget/premium) + Klassifizierung → Kostenstufe → Modellgruppe
  - *Implementierung*:
    - `src/cost-tiers.ts`: Kostenstufen-System mit DEFAULT_COST_TIERS
    - `src/routing.ts`: Erweiterte Router-Klasse mit Kostenstufen-Methoden
    - `resolveByCategory()`: Löst Gruppe basierend auf Klassifizierungskategorie auf
    - `resolveWithCostTier()`: Filtert Modelle nach Kostenstufe
    - `getCostTierForCategory()`: Mapping von Kategorie zu Kostenstufe
  - *Kostenstufen-Mapping*:
    ```
    trivial → free ($0)
    simple → free ($0)
    code_simple → free ($0)
    standard → budget ($)
    code_complex → premium ($$)
    design → premium ($$)
    planning → premium ($$)
    exploration → free ($0)
    fallback → budget ($)
    ```
  - *Kostenstufen-Konfiguration*:
    - **free**: max_cost_per_m: 0, max_cost_per_request: 0, min_gdpval: 0
    - **budget**: max_cost_per_m: 0.5, max_cost_per_request: 0.1, min_gdpval: 300
    - **premium**: max_cost_per_m: 2.0, max_cost_per_request: 1.0, min_gdpval: 600
  - *Einsparpotenzial*: ~90% der Anfragen könnten $0 kosten
  - *Status*: ✅ **Kernimplementierung abgeschlossen**
  - *Impact*: **SEHR HOCH** - Massive Kosteneinsparung
  - *Aufwand*: 4-5 Stunden (tatsächlich: ~3 Stunden)
  - *Abhängigkeiten*: `src/cost-tiers.ts`, `src/routing.ts`
  - *Nächste Schritte*: Integration in dynamisches Routing (index.ts), Monitoring, Feinabstimmung

- [x] **Cloud-Fallback für Klassifizierung** - ✅ **Implementiert mit kostenlosen Cloud-Modellen**
  - *Lösung*: Fallback-Kette: Ollama → Kostenlose Cloud-Modelle (aus `router-config.json` `free_models`) → Statische Klassifizierung
  - *Implementierung*:
    - `DiscoveryManager.getFreeModels()` gibt kostenlose Modelle aus Provider-Konfigurationen zurück
    - `classifyPrompt()` in `src/content-classifier.ts` nutzt Cloud-Modelle wenn Ollama fehlschlägt
    - Cloud-Fallback wird durch `allowCloudFallback`-Option gesteuert
    - Nutzt `CloudClient` um kostenlose Cloud-Modelle für die Klassifizierung aufzurufen
  - *Konfigurierte kostenlose Modelle*: `openrouter/qwen/qwen3-4b:free`, `openrouter/openai/gpt-4o-mini:free`, `openrouter/meta-llama/llama-3.3-70b-instruct:free`, `openrouter/google/gemma-3-4b-it:free`, `openrouter/google/gemma-3-12b-it:free`
  - *Status*: ✅ **Vollständig implementiert und funktionsfähig**
  - *Impact*: **HOCH** - System bleibt funktionsfähig ohne Ollama
  - *Abhängigkeiten*: `src/providers.ts`, `src/discovery.ts`, `src/content-classifier.ts`, `router-config.json`

#### 1. Code-Qualität & Wartung
- [ ] **Code Review durchführen** - Alle Module auf Konsistenz prüfen
- [ ] **TypeScript Strict Mode aktivieren** - `strict: true` in tsconfig.json
- [ ] **ESLint/Prettier konfigurieren** - Konsistente Code-Formatierung
- [ ] **JSDoc-Kommentare hinzufügen** - Bessere Dokumentation der Module

#### 2. Testing
- [ ] **Test-Coverage erhöhen** - Aktuell ~80%, Ziel: 90%+
- [ ] **Mock-Daten für Unit-Tests verbessern** - Realistischere Testdaten
- [ ] **Performance-Tests hinzufügen** - Benchmarks für Module

#### 3. Build & Deployment
- [ ] **Build-Prozess optimieren** - `npm run build` Zeit reduzieren
- [ ] **Docker-Container erstellen** - Einfache Bereitstellung
- [ ] **CI/CD Pipeline einrichten** - Automatisierte Tests & Deployment

---

### 🚀 **Mittelfristige Verbesserungen** (1-3 Tage)

#### 0. **Resilienz & Fallback-Strategien** ⭐⭐⭐⭐
- [x] **Freie Cloud-Modelle für Klassifizierung nutzen** - ✅ **Implementiert in `src/discovery.ts`**
  - *Änderungen*:
    - `DiscoveryManager.getFreeModels()` gibt kostenlose Modelle aus `router-config.json` zurück
    - `DiscoveryManager.hasFreeModels()` für schnelle Verfügbarkeitsprüfung
  - *Beispiel-Konfiguration*: `openrouter.free_models = ['openrouter/qwen/qwen3-4b:free', ...]`
  - *Impact*: **HOCH** - Klassifizierung funktioniert ohne Ollama
  - *Status*: ✅ **Vollständig implementiert**

- [x] **Klassifizierung mit Cloud-Fallback** - ✅ **Implementiert in `src/content-classifier.ts`**
  - *Fallback-Kette*: Ollama → Freie Cloud-Modelle → Statische Klassifizierung
  - *Implementierung*: `classifyPrompt()` mit `allowCloudFallback`-Option
  - *Cloud-Client-Integration*: Nutzt `CloudClient.callModel()` für Cloud-Klassifizierung
  - *Impact*: **HOCH** - Volle Funktionalität ohne Ollama
  - *Status*: ✅ **Vollständig implementiert**

- [x] **Statische Klassifizierung als Ultimate Fallback** - ✅ **Implementiert in `src/content-classifier.ts`**
  - *Funktion*: `classifyStatically(prompt: string): ClassificationResult`
  - *Kategorien*: trivial, simple, code_simple, standard, code_complex, design, planning, exploration, fallback
  - *Fallback-Kette*: Ollama → Cloud → Statisch → Default-Modell
  - *Implementierung*: Keyword-basierte Klassifizierung mit Confidence-Scores
  - *Impact*: **MITTEL** - Letzte Sicherheitsstufe
  - *Status*: ✅ **Vollständig implementiert**

- [x] **Fix für dynamische Konfiguration** - ✅ **Implementiert in `index.ts`**
  - *Problem*: Kostenlose Modelle wurden nicht in die dynamische Konfiguration aufgenommen
  - *Lösung*: Statische `free_models` aus `router-config.json` werden jetzt extrahiert und hinzugefügt
  - *Änderungen*:
    - `generateDynamicConfig()` lädt jetzt `free_models` aus Provider-Konfigurationen
    - Statische Modelle haben Priorität vor gescannten Modellen
    - Kostenfilter berücksichtigen jetzt kostenlose Modelle
    - Sortierung bevorzugt kostenlose Modelle
  - *Impact*: **HOCH** - Behebt das Problem, dass immer Qwen3-32B-TEE verwendet wurde
  - *Status*: ✅ **Vollständig implementiert und getestet (14 Tests)**

#### 1. Performance-Optimierungen
- [ ] **Caching für Klassifizierung** - LRU-Cache mit TTL für häufige Prompts
  - *Impact*: Reduziert Ollama-Aufrufe um ~30-50%
  - *Komplexität*: Mittel
  
- [ ] **Batch-Processing** - Parallelisierung von Klassifizierungsanfragen
  - *Impact*: Bessere Performance für Batch-Operationen
  - *Komplexität*: Hoch
  
- [ ] **Model-Optimierung** - Kleinere Modelle für Klassifizierung evaluieren
  - *Kandidaten*: phi3:mini, mistral-nemo, gemma2:2b
  - *Impact*: Schnellere Klassifizierung (Ziel: <2s)

#### 2. Erweiterte Klassifizierung
- [ ] **Mehr Kategorien** - Spezifischere Unterscheidung
  - *Beispiele*: `code_review`, `documentation`, `testing`, `refactoring`
  - *Impact*: Bessere Routing-Entscheidungen
  
- [ ] **Multi-Label Klassifizierung** - Mehrere Kategorien pro Prompt
  - *Beispiel*: `code_complex + design` für Architektur-Refactoring
  - *Impact*: Präzisere Modellauswahl
  
- [ ] **Kontext-basierte Klassifizierung** - Berücksichtigung des Session-Kontexts
  - *Idee*: Vorherige Nachrichten und Antworten einbeziehen
  - *Impact*: Konsistenteres Routing

#### 3. Erweiterte Metriken & Monitoring
- [ ] **Prometheus-Metriken** - Monitoring für Router-Performance
- [ ] **Usage-Analytics** - Statistiken über Modellnutzung
- [ ] **Cost-Tracking** - Echtzeit-Kostenüberwachung

---

### 🌟 **Langfristige Features** (1-2 Wochen)

#### 1. Erweitertes Provider-Management
- [ ] **Automatische Provider-Erkennung** - Neue Provider automatisch hinzufügen
- [ ] **Provider-Health-Checks** - Regelmäßige Verfügbarkeitsprüfung
- [ ] **Auto-Balancing** - Intelligente Lastverteilung

#### 2. Intelligentes Routing
- [ ] **Adaptive Routing-Strategien** - Dynamische Anpassung basierend auf Performance
- [ ] **User-Präferenzen** - Individuelle Routing-Regeln pro User
- [ ] **Team-basiertes Routing** - Unterschiedliche Strategien für verschiedene Teams

#### 3. Integration & Erweiterbarkeit
- [ ] **Plugin-System** - Einfaches Hinzufügen neuer Provider
- [ ] **Web-UI für Konfiguration** - Grafische Oberfläche für Router-Einstellungen
- [ ] **API für externe Tools** - REST-API für Router-Funktionen

---

## 📊 **Technische Schulden**

### Niedrige Priorität
- [ ] **Legacy-Code bereinigen** - Letzte lokale Variablen in index.ts prüfen
- [ ] **Error-Handling verbessern** - Konsistente Fehlerbehandlung in allen Modulen
- [ ] **Logging standardisieren** - Einheitliches Logging-Format

### Mittel Priorität
- [ ] **Typ-Sicherheit erhöhen** - Mehr TypeGuards und Validierungen
- [ ] **Zirkuläre Abhängigkeiten vermeiden** - Module entkoppeln
- [ ] **Memory-Leaks prüfen** - Cache und Event-Listener bereinigen

---

## 📅 **Zeitplan (Vorschlag)**

### **🔥 Woche 0: Kritische Fixes (1 Tag)**
- **Fallback-Strategie implementieren** - Graceful Degradation für Klassifizierung
- **Test-Coverage für discovery.ts** - Integrationstests erstellen

### Woche 1: Stabilisierung
- **Tag 1-2**: Code Review & Dokumentation
- **Tag 3-4**: Test-Coverage erhöhen (metrics.ts, rate-limit.ts)
- **Tag 5**: Performance-Optimierungen (Caching)

### Woche 2: Erweiterte Features
- **Tag 1-2**: Erweiterte Klassifizierung
- **Tag 3-4**: Monitoring & Metriken
- **Tag 5**: Build & Deployment optimieren

### Woche 3+: Neue Features
- **Adaptive Routing-Strategien**
- **Plugin-System**
- **Web-UI**

---

## 🎯 **Empfehlungen für den Start**

### 1. **Code Review (1-2 Stunden)**
```bash
# Alle Module durchgehen
cd /Users/anierbeck/git/pi-model-router-fork

# TypeScript-Check
npx tsc --noEmit

# Linting (falls konfiguriert)
npx eslint src/**/*.ts

# Tests ausführen
npm test
```

### 2. **Dokumentation finalisieren (1 Stunde)**
- [ ] **API-Dokumentation** für alle Module erstellen
- [ ] **Beispiel-Konfigurationen** hinzufügen
- [ ] **Troubleshooting-Guide** erstellen

### 3. **Performance-Tests (2 Stunden)**
- [ ] **Benchmark-Skript** erstellen
- [ ] **Performance-Metriken** messen
- [ ] **Optimierungspotenziale** identifizieren

### 4. **Manuelle Steuerung (1-2 Stunden)** ⭐⭐⭐
- [ ] **Manuelle Modellauswahl** - User kann Modell für nächste Anfrage festlegen
  - *Beispiel*: `/use-model claude-3-sonnet` oder `/use-group complex`
  - *Impact*: **HOCH** - Mehr Kontrolle für User
  - *Aufwand*: 1-2 Stunden

---

## 📊 **MONITORING & LOGGING** (aus alter TODO.md)

### 1. **Monitoring-Logging implementieren** ⭐⭐⭐
- [ ] **Routing-Entscheidungen loggen** - Welches Modell wurde gewählt und warum
  - *Beispiel*: `[router] Selected claude-3-sonnet for design task (confidence: 0.95)`
  - *Impact*: **HOCH** - Transparenz & Debugging
  - *Aufwand*: 2 Stunden

- [ ] **Kosten-Tracking** - Echtzeit-Kostenüberwachung pro Anfrage
  - *Beispiel*: `[cost] Request cost: $0.25 (tokens: 1000, model: claude-3-sonnet)`
  - *Impact*: **HOCH** - Kostenkontrolle
  - *Aufwand*: 2 Stunden

- [ ] **Performance-Metriken** - Latenz, Durchsatz, Fehlerraten
  - *Beispiel*: `[perf] Latency: 2.4s, Throughput: 5 req/s, Errors: 0`
  - *Impact*: **MITTEL** - Performance-Überwachung
  - *Aufwand*: 1 Stunde

---

## 🔌 **ERWEITERBARKEIT** (aus alter TODO.md)

### 1. **Plugin-System entwerfen** ⭐⭐⭐
- [ ] **Provider-Plugin-System** - Einfaches Hinzufügen neuer Provider
  - *Beispiel*: `plugins/my-provider.ts` mit `registerProvider()`
  - *Impact*: **HOCH** - Erweiterbarkeit
  - *Aufwand*: 3-4 Stunden

- [ ] **Modell-Plugin-System** - Einfaches Hinzufügen neuer Modelle
  - *Beispiel*: `plugins/my-model.ts` mit `registerModel()`
  - *Impact*: **MITTEL** - Flexibilität
  - *Aufwand*: 2 Stunden

### 2. **Weitere Provider unterstützen** ⭐⭐⭐
- [ ] **Neue Provider integrieren** - Unterstützung für weitere LLM-Anbieter
  - *Kandidaten*: `together.ai`, `cohere`, `ai21`, `perplexity`
  - *Impact*: **HOCH** - Mehr Auswahl für User
  - *Aufwand*: 2-3 Stunden pro Provider

---

## 💰 **KOSTENEFFIZIENTES ROUTING IMPLEMENTIERUNG**

### 1. Klassifizierungskategorien erweitern
```typescript
// src/content-classifier.ts
export type ClassificationResult = {
  category: 
    | 'trivial'      // $0 - "Liste TODOs", "Was steht in der Datei?"
    | 'simple'       // $0 - "Erkläre kurz", "Fasse zusammen"
    | 'code_simple'  // $0 - 1-10 Zeilen Code
    | 'standard'     // $ - Standard-Anfragen
    | 'code_complex' // $$ - >50 Zeilen, Refactoring
    | 'design'       // $$ - Architektur
    | 'planning'     // $$ - Roadmaps
    | 'exploration'  // $$ - Brainstorming
    | 'fallback';
  reason: string;
  confidence?: number;
};

// Mapping zu Kostenstufen
export const CATEGORY_TO_GROUP: Record<ClassificationResult['category'], string> = {
  trivial: 'trivial',      // Kostenlos
  simple: 'simple',        // Kostenlos
  code_simple: 'simple',   // Kostenlos
  standard: 'standard',    // Günstig
  code_complex: 'complex', // Premium
  design: 'complex',       // Premium
  planning: 'complex',     // Premium
  exploration: 'standard', // Standard
  fallback: 'trivial',     // Kostenlos
};
```

### 2. router-config.json erweitern
```json
{
  "model_groups": {
    "trivial": {
      "description": "Triviale Aufgaben - kostenlos",
      "method": "cheapest",
      "max_cost": 0,
      "models": [
        "qwen/qwen3-4b:free",
        "google/gemma-3-4b-it:free",
        "ollama/gemma4:12b-mlx"
      ]
    },
    "simple": {
      "description": "Einfache Aufgaben - kostenlos",
      "method": "cheapest",
      "max_cost": 0,
      "models": [
        "qwen/qwen3-4b:free",
        "google/gemma-3-12b-it:free",
        "meta-llama/llama-3.3-70b-instruct:free",
        "ollama/gemma4:12b-mlx"
      ]
    },
    "standard": {
      "description": "Standard Aufgaben - günstig",
      "method": "tiered",
      "min_gdpval": 500,
      "max_cost_per_m": 0.5,
      "models": ["openai/gpt-4o-mini", "anthropic/claude-3-haiku"]
    },
    "complex": {
      "description": "Komplexe Aufgaben - Premium",
      "method": "best",
      "min_gdpval": 800,
      "models": ["anthropic/claude-3-sonnet", "openai/gpt-4o", "mistral-medium-3.5"]
    }
  },
  "cost_optimization": {
    "enabled": true,
    "default_group": "simple",
    "auto_downgrade": true
  }
}
```

### 3. Klassifizierungsprompt anpassen
```typescript
// src/content-classifier.ts
const CLASSIFICATION_PROMPT = `Classify the following user request into exactly one category:

- trivial:      Very simple requests ("list files", "show TODOs", "what's in this file?")
- simple:       Simple questions ("explain briefly", "summarize", "what does this do?")
- code_simple:   Small code changes (1–10 lines, syntax fixes, renames, typos)
- standard:      Standard requests (general questions, moderate complexity)
- code_complex:  Substantial code changes (refactoring, debugging, new features, >50 lines)
- design:        Architecture, system design, API design, database schema
- planning:      Task breakdown, roadmaps, prioritization, project planning
- exploration:   Vague or open-ended questions ("what could we do about X?", brainstorming)
- fallback:      Ambiguous, or short continuation of previous work

Classify by complexity and required model capability.
Short requests with clear, simple answers → trivial or simple.
"List TODOs", "Show me the file" → trivial.
"Explain this code" (simple code) → simple.
"Design an architecture" → design.

Current request: "{{prompt}}"

Respond with JSON only:
{"category": "<category>", "reason": "<1-2 sentences>", "confidence": <0.0-1.0>}`;
```

---

## 📋 **CLOUD-FALLBACK IMPLEMENTIERUNG**

### 1. `src/providers.ts` erweitern
```typescript
// Vorher:
openrouter: {
  envVar: 'OPENROUTER_API_KEY',
  billing: 'pay_per_token',
  baseUrl: 'https://openrouter.ai/api/v1',
  api: 'openai-completions',
},

// Nachher:
openrouter: {
  envVar: 'OPENROUTER_API_KEY',
  billing: 'pay_per_token',
  baseUrl: 'https://openrouter.ai/api/v1',
  api: 'openai-completions',
  freeModels: [
    'qwen/qwen3-4b:free',
    'openai/gpt-oss-120b:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-3-4b-it:free',
  ],
},
```

### 2. `src/discovery.ts` erweitern
```typescript
// Neue Methode in DiscoveryManager
getFreeModels(): string[] {
  const freeModels: string[] = [];
  
  for (const [provId, def] of Object.entries(PROVIDER_MAP)) {
    if (def.freeModels) {
      // Prüfe ob Provider konfiguriert und Keys verfügbar
      const prov = this.cfg.providers?.[provId];
      if (prov?.keys?.length > 0) {
        freeModels.push(...def.freeModels);
      }
    }
  }
  
  return freeModels;
}

// Hilfsmethode
hasFreeModels(): boolean {
  return this.getFreeModels().length > 0;
}
```

### 3. `src/content-classifier.ts` anpassen
```typescript
// Neue Funktion
async function classifyWithCloudModel(
  prompt: string,
  model: string
): Promise<ClassificationResult> {
  // Nutze das freie Cloud-Modell für Klassifizierung
  // Implementierung ähnlich wie classifyWithOllama, aber mit Cloud-API
  const response = await callCloudModel(model, CLASSIFICATION_PROMPT, { timeoutMs: 15000 });
  // ... Parsing-Logik wie bei Ollama
}

// Angepasste classifyPrompt-Funktion
export async function classifyPrompt(
  prompt: string,
  options: ClassificationOptions = {}
): Promise<ClassificationResult> {
  // 1. Versuche Ollama
  if (await isOllamaAvailable()) {
    try {
      return await classifyWithOllama(prompt, options);
    } catch (error) {
      console.warn('[classifier] Ollama failed, trying free cloud models');
    }
  }
  
  // 2. Versuche freie Cloud-Modelle
  const discovery = new DiscoveryManager(config, cache);
  const freeModels = discovery.getFreeModels();
  
  if (freeModels.length > 0) {
    for (const model of freeModels) {
      try {
        return await classifyWithCloudModel(prompt, model);
      } catch (error) {
        console.warn(`[classifier] Free model ${model} failed, trying next`);
      }
    }
  }
  
  // 3. Ultimate Fallback: Statische Klassifizierung
  return classifyStatically(prompt);
}
```

---

## 📋 **FALLBACK-KONFIGURATION BEISPIEL**

### Aktuelle `router-config.json` (Auszug):
```json
{
  "model_groups": {
    "strategic": {
      "description": "Best available model by intelligence",
      "method": "best"
    }
  }
}
```

### Erweitert mit Fallback-Strategien:
```json
{
  "classification": {
    "primary": "ollama",
    "fallback": "static",
    "static_rules": {
      "code": ["python", "javascript", "typescript", "function", "class", "import", "export"],
      "design": ["design", "architecture", "diagram", "UML", "flowchart", "system"],
      "documentation": ["write", "document", "explain", "describe", "summary", "tutorial"],
      "analysis": ["analyze", "review", "compare", "evaluate", "critique"],
      "general": ["what", "how", "why", "tell me", "question"]
    },
    "default_group": "tactical"
  },
  "model_groups": {
    "strategic": {
      "description": "Best available model by intelligence",
      "method": "best",
      "models": ["anthropic/claude-3-sonnet", "openai/gpt-4", "google/gemini-1.5-pro"]
    },
    "tactical": {
      "description": "High quality, cost-effective",
      "method": "tiered",
      "models": ["anthropic/claude-3-haiku", "openai/gpt-3.5-turbo"]
    },
    "fallback": {
      "description": "Local models when nothing else is available",
      "method": "tiered",
      "models": ["local/llama-3.2-1b", "local/mistral-7b"]
    }
  }
}
```

### Fallback-Logik:
```typescript
// src/content-classifier.ts
async function classifyPrompt(prompt: string): Promise<string> {
  // 1. Primär: Ollama
  if (await isOllamaAvailable()) {
    try {
      return await classifyWithOllama(prompt);
    } catch (error) {
      console.warn("Ollama classification failed, falling back to static");
    }
  }
  
  // 2. Fallback: Statische Klassifizierung
  const staticCategory = classifyStatically(prompt);
  if (staticCategory) {
    return staticCategory;
  }
  
  // 3. Ultimate Fallback: Default-Gruppe
  return config.classification.default_group || "tactical";
}
```

---

## 📚 **Hilfreiche Befehle**

```bash
# Alle Tests ausführen
npm test

# Nur Unit-Tests
npm test -- --run

# Nur Integrationstests (Ollama muss laufen)
TEST_INTEGRATION=true npm test

# Build testen
npm run build

# TypeScript-Check
npx tsc --noEmit

# Ollama starten
ollama serve

# Ollama Modell pullen
ollama pull gemma2:2b

# Router-Status anzeigen
/router

# Cache bereinigen
rm -rf .cache/scan-cache.json
```

---

## 🔗 **Verwandte Dokumente**
- [REFACTORING_SUMMARY.md](./REFACTORING_SUMMARY.md) - Detaillierte Migrationsdokumentation
- [README.md](./README.md) - Hauptdokumentation
- [SKILL.md](./SKILL.md) - Skill-Beschreibung
- [archive/](./archive/) - Alte Planungsdateien (zu Referenzzwecken)

---

*Letzte Aktualisierung: 12. Juni 2026, 13:45 Uhr*
