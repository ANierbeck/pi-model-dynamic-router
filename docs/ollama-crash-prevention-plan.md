# Ollama Crash Prevention — Diagnose & Plan

## Diagnose (aus `~/.pi/logs/router.log`)

### Beweis: parallele Ollama-Streams um 18:42:47 UTC am 2026-08-27

Innerhalb von **75 Millisekunden** (18:42:47.624 → .698) werden **6 Ollama-Modelle gleichzeitig** zum Streamen gebracht:

| Zeit (UTC) | Modell | RAM-Belastung |
|---|---|---|
| 18:42:47.624 | `ollama/qwen3.8:27b-mlx` | ~16-20 GB (27B MLX) |
| 18:42:47.647 | `ollama/gemma4:latest` | ~5-8 GB |
| 18:42:47.661 | `ollama/gemma4:12b-mlx` | ~8-12 GB |
| 18:42:47.680 | `ollama/mistral-nemo:latest` | ~6-8 GB |
| 18:42:47.690 | `ollama/ornith:9b` | ~5-7 GB |
| 18:42:47.698 | `ollama/llama3.1:latest` | ~5-8 GB |

**Summe: 6 Modelle gleichzeitig → geschätzt 45-65 GB RAM-Anforderung** → Mac-Absturz (OOM-Killer oder Kernel-Panic).

Davor werden zusätzlich **7 OpenRouter-Free-Modelle** parallel gestreamt (18:42:46.049 → 47.213), die zwar nicht lokal RAM fressen, aber zeigen, dass hier ein **Parallel-Probe aller Kandidaten einer Gruppe** läuft, kein sequenzieller `driveStream`.

### Woher kommen die parallelen Streams?

- `driveStream` selbst ist **sequenziell** (for-of-Schleife, Zeile 2741 — bricht nach erstem Erfolg ab).
- Die parallelen Streams kommen von **Pi-Subagents**, die parallel gestartet werden und jeweils über den Router ein Modell streamen (z.B. `exploration → scout` war um 18:42:38 im Log, dann fan-out).
- Der Router hat **keine Concurrency-Control** für lokale Anbieter (Ollama/lm-studio). Jeder Subagent-Stream öffnet sofort sein Modell im RAM.

### Root Cause

Kein Throttling: N gleichzeitige Subagent-Streams → N Ollama-Modelle gleichzeitig im RAM → OOM-Crash.

## Plan

### Phase 1 — Diagnose abschließen (dieser Abschnitt)
- [x] Log-Analyse: parallele Ollama-Streams bestätigt (6 Modelle in 75ms)
- [x] Code-Analyse: keine Concurrency-Control für lokale Anbieter vorhanden
- [x] Quelle identifiziert: Pi-Subagent-Fanout, nicht der Router selbst
- [x] RAM-Verbrauch der konkreten installierten Modelle verifiziert:
      `ollama list` — qwen3.8:27b-mlx (18GB), gemma4:12b-mlx (10GB),
      gemma4:latest (9.6GB), mistral-nemo:latest (7.1GB), ornith:9b (5.6GB),
      llama3.1:latest (4.9GB), gemma2:2b (1.6GB). Summe der 6 parallel geladenen
      Modelle ~55GB → OOM garantiert bei 16-32GB RAM.

### Entscheidungen (2026-08-28, vom Nutzer bestätigt)
- **Release-Scope:** Erst bauen, dann entscheiden (1.4.3 vs. 1.5.0 je nach Ergebnis).
- **Verhalten bei Limit-Überschreitung:** **Soft-fail** mit `reason: 'local_concurrency_limit'` → `driveStream` nimmt sofort den nächsten Kandidaten (Cloud-Fallback). Kein Warten/Queue.
- **Default `ollama_max_concurrent_streams`:** **1** (strikt seriell — sicherster Wert).

### Phase 2 — Fix (1.4.3 oder 1.5.0, je nach Scope)

**Option A: Prozess-interne Semaphore im Router (empfohlen, minimal — WIRD UMGESETZT)**
- Neue Config `ollama_max_concurrent_streams` (default 1) in `router-defaults.yaml` + `src/types.ts`
- Modul-globaler Semaphor-Zähler in `index.ts` (oder `src/local-llm-throttle.ts`)
- In `tryStream`: wenn `isLocal` (PROVIDER_MAP), vor `streamSimple` Zähler prüfen+inkrementieren, nach Stream-Ende/Fehler dekrementieren.
- Bei Überschreitung: **soft-fail** (keine Queue) — `tryStream` gibt `null` zurück mit skipReason `'local_concurrency_limit (N of M)'` → `driveStream` nimmt sofort den nächsten Kandidaten (Cloud-Fallback).
- Schutz gilt NUR für lokale Anbieter (`ollama`, `lm-studio`), nicht für Cloud.
- Default 1 = strikt seriell für lokale Modelle.

**Option B: Präventiver RAM-Check (zusätzlich zu A, wenn Option A allein nicht reicht)**
- Beim Scan: Modell-Größe aus `/api/show` (`model_info.size` / `details.parameter_size`) in `cache.available_models[].capabilities` aufnehmen.
- Vor Stream: verfügbaren System-RAM abfragen (`os.totalmem() - os.freemem()`), überschlagsmäßig prüfen ob das Modell noch reinpasst. Wenn nicht: soft-fail.
- Komplexer, plattformabhängig — nur wenn Option A nicht ausreicht.

**Option C: Externe Überwachung (out of scope für diesen Router)**
- Ollama-eigenes `OLLAMA_MAX_LOADED_MODELS` env var (Ollama-seitiges Limit, unabhängig vom Router).
- System-Watchdog (siehe pi-watchdog-Subprojekt im memory).
- Dokumentation/README-Empfehlung, nicht Code im Router.

### Phase 3 — Tests
- `test/ollama-concurrency-limit.test.ts`: 3 parallele `groupStream`-Aufrufe mit Ollama-Kandidaten, `ollama_max_concurrent_streams: 1` → nur 1 streamt gleichzeitig, 2 warten oder fallen durch.
- Bestehende Tests dürfen nicht brechen (Free/Cloud-Modelle nicht throtteln).

### Phase 4 — Release
- Version bump, CHANGELOG, roborev-Review, Tag, GitHub Release → npm publish (gleicher Prozess wie 1.4.2).

## Offene Fragen (alle geklärt 2026-08-28)
1. ✅ RAM-Verbrauch verifiziert (s.o.).
2. ✅ Soft-fail (Cloud-Fallback), keine Queue.
3. ✅ Default 1 (strikt seriell).

## Verbleibende offene Frage (nach Implementierung)
- Reicht Option A (Semaphore) allein, oder wird zusätzlich Option B (RAM-Check) für 1.5.0 nötig? Entscheidung nach lokalem Test.
