# ADR-0017: Bounded Wait-for-Short-Reset statt Kaskaden-Ausbrennen

## Status
Angenommen (2026-09-27) — ersetzt den ersten Entwurf ("Explizite Reset-Zeit in der Narration"), der das Problem verkannte: die absolute Reset-Zeit wurde bereits angezeigt (`formatResetMsg` rendert "(resets 27.9.2026, 14:37:11)"). Achims Anfrage ("das WARTEN darauf konfigurieren") meinte das tatsächliche Warten, nicht die Anzeige.

## Kontext / Vorfall (2026-09-27, 12:36–12:44 UTC)

Beobachtete Kette (vollständig aus router.log rekonstruiert):

1. **12:36:11** — `zai-glm-5-3` trifft ein echtes Mistral-TPM-Limit mit bekanntem, kurzen Reset: "resets 27.9.2026, 14:37:11" — **60 Sekunden**. Alle Mistral-Modelle teilen sich das konto-weite TPM; die nachfolgenden Kandidaten melden dasselbe +60s-Muster (14:37:14, :17, :21).
2. Der Router cascade-t **sofort** durch alle Kandidaten, statt 60s zu warten. Jeder Kandidat erhält einen Failure-Record (422 → "likely rate limit", rate limits, empty responses).
3. Der laufende Agent-Turn feuert viele Tool-Call-Requests hintereinander → **jede Request brennt die Kette erneut durch** → 2 Failures/15 Min pro Modell → eskalierende Backoffs.
4. **12:37:11** — zai ist real wieder verfügbar (TPM-Fenster abgelaufen). Der Router merkt es nicht: die Kaskade läuft weiter.
5. **Total-Cooldown-Collapse-Zweig**: "Force-retrying X (**28s remaining**)" — Retry **in einen bekannten, nicht abgelaufenen Cooldown hinein** → garantiertes Fail → **neuer Failure-Record** → Backoff verdoppelt → Cooldown verlängert sich über die reale Erholung hinaus (**Selbstvergiftung**).
6. **12:43:58** — Totaler Kollaps: alle 17–18 Kandidaten aller 10 Gruppen gesperrt. Der Router bleibt minutenlang tot, obwohl die API längst wieder geht.
7. **Beweis der Divergenz**: Achim setzt das Modell **hart auf zai-glm-5-3** (umgeht den Router-State) → **funktioniert sofort**. Der Router-State hatte sich von der Wirklichkeit entkoppelt.

## Entscheidung

**1. Bounded Wait-for-Short-Reset (driveStream, rate_limit-Branch):**
Wenn ein Kandidat mit `rate_limit_exceeded` failt, `resetAtMs` bekannt ist und `resetAtMs − now ≤ rate_limit_wait_max_ms` (Default 120s, 0 = aus):
- Kaskade anhalten, narraten "rate limited (resets …) — waiting Ns, then retrying…"
- Schlafen bis `resetAtMs + 2s`, das **gleiche Modell 1× neu versuchen**
- Erfolg → fertig; erneuter Fail → normal in der Kaskade weiterlaufen
- **Maximal ein Wait pro driveStream-Aufruf** (`rateLimitWaitUsed`) — keine Livelock-Gefahr

**2. Collapse-Zweig-Reparatur (Selbstvergiftung beenden):**
Im Total-Cooldown-Collapse: wenn die kürzeste Restzeit `bestSecs ≤ rate_limit_wait_max_ms` → **warten** (`bestSecs + 2s`), dann erst retryen. Kein Force-Retry mehr in bekannte, nicht abgelaufene Cooldowns (jeder solche Retry erzeugte einen garantierten Fail und verlängerte den Cooldown — die Eskalationsspirale). Lange Restzeiten behalten die alte Immediate-Retry-Semantik. Die Narration wechselte außerdem von `pushRouterInfo` (unsichtbar im Log!) zu `pushRouterInfoLogged`.

**3. `/router cooldowns [clear]` (Sofort-Entlastung):**
- `/router cooldowns` — listet aktive Cooldowns (Ref, Restsekunden, Hits, Provider-Reset) + model_health-Streaks
- `/router cooldowns clear` — löscht ALLE In-Memory-Cooldowns + `cache.model_health`-Streaks (persistiert), ohne pi-Neustart. Für künftige Vorfälle: ein Befehl statt Neustart.

## Konsequenzen
- **Positiv:** Kurzfristige TPM-Fenster (60s) kosten eine Wartepause statt eines Total-Kollapses; die Failure-Flut auf 17 unbeteiligte Modelle entfällt; der Router-State kann sich nicht mehr selbst vergiften; manuelle Erholung ohne Neustart.
- **Negativ:** Im Wait-Fenster (≤120s) steht der Stream still (narrated). Ein Abbruch während des Waits ist erst nach Ablauf wirksam (kein Abort-Plumbing in driveStream — akzeptiert, bounded).
- **Neutral:** Cooldown-Backoffs und Eskalation bleiben für limitenlose/ungeklärte Failures unverändert.

## Konfiguration
- `rate_limit_wait_max_ms` (router-defaults.yaml: 120000; überlagerbar in router-config.json / User-Layer; `0` deaktiviert beide Wait-Pfade)

## Implementierung
- `src/stream-orchestrator.ts`: rate_limit-Branch (Wait+Retry), Collapse-Zweig (Wait statt Immediate-Force-Retry), `sleepMs`-Helper
- `src/rate-limit.ts`: `clearAllLimits()`, `listLimits()`
- `index.ts`: `getRateLimitWaitMaxMs()`-Getter, ctx-Wiring, `/router cooldowns [clear]`
- `src/types.ts`, `router-defaults.yaml`: `rate_limit_wait_max_ms`
- Tests: `test/rate-limit-wait.test.ts`

## Alternativen verworfen
- **Nur Narration erweitern** (erster Entwurf) — Reset-Zeit wurde schon angezeigt; löst nichts.
- **Warten am ersten Rate-Limit ohne Schwelle** — würde bei five_hour-Fenstern (2h+) den Turn ewig blocken; deshalb bounded.
- **Cooldown-Eskalation absenken** — bekämpft das Symptom, nicht die Ursache; die Kette darf gar nicht erst durchgebrennt werden.

## Verwandte Dokumente
- ADR-0008 (Learned Blocklist) — permanente Provider-Defekte
- ADR-0011 (HINT-Reparatur) — unabhängig
- `src/rate-limit.ts` — recordLimit (resetAtMs-berücksichtigend), recordSoftFailure

---
**Erstellt:** 2026-09-27 · **Letzte Änderung:** 2026-09-27 (Rewrite nach Live-Vorfall) · **Zustand:** Angenommen
