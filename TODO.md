# 🚀 pi-model-router - Aktuelle Aufgaben & Roadmap

> **Status**: Aktualisiert mit kosteneffizientem Routing  
> **Letzte Aktualisierung**: 13. Juni 2026  
> **Aktueller Stand**: ✅ Migration abgeschlossen, alle Tests grün, Cloud-Fallback & Kostenoptimierung geplant

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
- [ ] **Kosteneffizientes dynamisches Routing** - Nutze billige Modelle für einfache Aufgaben
  - *Problem*: Alle Anfragen nutzen teure Modelle, auch für einfache Aufgaben
  - *Lösung*: Klassifizierung nach Komplexität + Routing zu passenden Kostenstufen
  - *Kostenstufen*:
    - **trivial/simple** ($0): `qwen/qwen3-4b:free`, `gemma-3-12b-it:free`, `llama-3.3-70b:free`
    - **standard** ($): `gpt-4o-mini`, `claude-3-haiku`
    - **complex** ($$): `claude-3-sonnet`, `gpt-4o`, `mistral-medium-3.5`
  - *Einsparpotenzial*: ~90% der Anfragen könnten $0 kosten
  - *Impact*: **SEHR HOCH** - Massive Kosteneinsparung
  - *Aufwand*: 4-5 Stunden
  - *Abhängigkeiten*: `src/content-classifier.ts`, `router-config.json`, `src/routing.ts`

- [ ] **Cloud-Fallback für Klassifizierung** - Nutze freie Cloud-Modelle wenn Ollama nicht verfügbar
  - *Problem*: Aktuell schlägt Klassifizierung fehl wenn Ollama nicht läuft
  - *Lösung*: Fallback auf kostenlose Cloud-Modelle (z.B. `qwen/qwen3-4b:free`, `openai/gpt-oss-120b:free`)
  - *Verfügbare freie Modelle*: Siehe `model-map.yaml` (50+ kostenlose Modelle)
  - *Impact*: **HOCH** - System bleibt funktionsfähig ohne Ollama
  - *Aufwand*: 3-4 Stunden
  - *Abhängigkeiten*: `src/providers.ts`, `src/discovery.ts`, `src/content-classifier.ts`

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
- [ ] **Freie Cloud-Modelle für Klassifizierung nutzen** - Erweitere `src/providers.ts` und `src/discovery.ts`
  - *Änderungen*:
    - `PROVIDER_MAP` um `freeModels: string[]` erweitern
    - `DiscoveryManager.getFreeModels()` implementieren
    - `DiscoveryManager.hasFreeModels()` für schnelle Prüfung
  - *Beispiel*: `openrouter.freeModels = ['qwen/qwen3-4b:free', 'openai/gpt-oss-120b:free']`
  - *Impact*: **HOCH** - Klassifizierung funktioniert ohne Ollama
  - *Aufwand*: 2 Stunden

- [ ] **Klassifizierung mit Cloud-Fallback** - Erweitere `src/content-classifier.ts`
  - *Fallback-Kette*: Ollama → Freie Cloud-Modelle → Statische Klassifizierung
  - *Neue Funktion*: `classifyWithCloudModel(prompt: string, model: string)`
  - *Impact*: **HOCH** - Volle Funktionalität ohne Ollama
  - *Aufwand*: 2 Stunden

- [ ] **Statische Klassifizierung als Ultimate Fallback** - Keyword-basierte Klassifizierung
  - *Funktionen*: `classifyStatically(prompt: string): string`
  - *Kategorien*: code, design, documentation, analysis, general
  - *Fallback-Kette*: Ollama → Cloud → Statisch → Default-Modell
  - *Impact*: **MITTEL** - Letzte Sicherheitsstufe
  - *Aufwand*: 1 Stunde

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
