# ADR-0018: Reparatur des HINT-Mechanismus (HINT/MHINT/MODEL-HINT-Präfix)

## Status
Entwurf (2026-09-27)

## Kontext / Problem
Achim meldet am 27.09.2026: Der HINT-Mechanismus funktioniert nicht mehr wie erwartet. Der Mechanismus basiert auf:
- **HINT/MHINT/MODEL-HINT-Präfix** im Prompt (z.B. `HINT: ...` oder `MHINT: ...`)
- **Detektion** in `src/content-classifier.ts` via `detectHintDirectly` / `containsHintMarker`
- **Aktion:** Bei HINT-Erkennung wird die Klassifizierung unterdrückt und die Antwort als `HINT: ...` an den Benutzer ausgegeben, statt als reguläre Antwort.

**Symptom:**
- HINT-Präfixe werden nicht erkannt.
- Klassifizierung läuft durch, obwohl ein HINT vorliegt.
- Der Benutzer sieht die HINT-Antwort nicht als solche, sondern als normale Antwort.

**Hintergrund:**
Der Mechanismus wurde während der Cloud-first-Ollama-Planung auffällig, ist aber ein **separates, unabhängiges Problem** von der Router-Architektur. Er funktionierte in der Vergangenheit (roborev job 345 HIGH, 2026-09-02), ist aber aktuell defekt.

## Entscheidung
Wir reparieren den HINT-Mechanismus durch:
1. **Reproduzieren** des Fehlers (Testfall mit HINT-Präfix im Prompt).
2. **Root Cause analysieren** (Code-Review von `detectHintDirectly` / `containsHintMarker` und der Klassifizierungs-Kette).
3. **Fix umsetzen** (Code-Änderung + Regressionstest).
4. **ADR finalisieren** (falls Änderungen an Design/Architektur nötig sind).

## Konsequenzen
- **Positiv:** HINT-Mechanismus funktioniert wieder — bessere UX für HINT-basierte Workflows.
- **Negativ:** Kleine Code-Änderung in `src/content-classifier.ts`; Regressionstest nötig.
- **Risiko:** Kein Risiko — Mechanismus ist optional; wenn er defekt ist, ist das Verhalten "normale Klassifizierung" (kein Abbruch).

## Details

### Aktuelle Implementierung (Auszug)
- `src/content-classifier.ts`:
  - `detectHintDirectly(text: string): boolean`
  - `containsHintMarker(text: string): boolean`
  - `classifyPrompt()` nutzt diese Funktionen, um HINT zu erkennen und die Klassifizierung zu unterdrücken.
- `src/classification-prompt.ts` / `src/classifier-fallback-probe.ts` enthalten Logik zur HINT-Erkennung.

### Mögliche Root Causes (Verdachtsliste)
1. **Narration-Leak:** Router-Nachrichten (z.B. `> [router] HINT: ...`) werden in den Prompt eingeschleust und verfälschen die HINT-Erkennung (2026-09-18 lock-in loop — behoben in 26e99f0, aber Regression möglich).
2. **Classifier-Kette-Änderung:** Die Cloud-first-Änderung (Sept 2026) hat die Reihenfolge der Kandidaten geändert — HINT-Erkennung könnte an falscher Stelle stattfinden.
3. **Prompt-Extraktion:** `extractLastUserPrompt` oder `extractLastAssistantSnippet` könnte HINT-Präfixe entfernen oder maskieren.
4. **HINT-Präfixe nicht im User-Prompt:** HINT könnte in einem anderen Feld (z.B. System-Prompt) stehen und nicht im User-Prompt.
5. **Falsche Match-Logik:** `detectHintDirectly` sucht nach `/HINT[:\s]/i` — könnte durch neue Prompt-Formatierung nicht mehr greifen.

### Geplante Schritte

#### 1. Reproduktion (Testfall)
- **Test:** `test/classifier-hint-regression.test.ts`
  - Prompt mit `HINT: ...` oder `MHINT: ...` an den Klassifizierer senden.
  - Assert: `classifyPrompt()` liefert ein Ergebnis mit `isHint: true` oder unterdrückt die Klassifizierung und gibt eine HINT-Antwort zurück.
  - Assert: Die HINT-Antwort wird als `HINT: ...` an den Benutzer gesendet (Narration oder Message).

#### 2. Root Cause Analyse
- **Code-Review:**
  - `detectHintDirectly` / `containsHintMarker` — Match-Logik prüfen.
  - `classifyPrompt()` — Reihenfolge der Kandidaten, HINT-Erkennung, Unterdrückung.
  - `extractLastUserPrompt` — HINT-Präfixe im User-Prompt erhalten?
  - `pushRouterInfo` / Narration-Leak — werden HINT-Zeilen in den Prompt eingeschleust?
- **Log-Analyse:**
  - Router-Log (`~/.pi/logs/router.log`) nach HINT-Zeilen durchsuchen.
  - Klassifizierungs-Logs (`classification.log`?) nach HINT-Erkennung durchsuchen.

#### 3. Fix umsetzen
- **Code-Änderung:**
  - Falls Narration-Leak: `extractLastUserPrompt` muss Router-Nachrichten strippen (wie in 26e99f0).
  - Falls Match-Logik: Regex anpassen (z.B. `/HINT[:\s]|MHINT[:\s]|MODEL-HINT[:\s]/i`).
  - Falls Reihenfolge: HINT-Erkennung vor der Kandidaten-Auswahl durchführen.
- **Regressionstest:**
  - Testfall aus Schritt 1 muss grün werden.
  - Bestehende Tests dürfen nicht brechen.

#### 4. ADR finalisieren
- Falls Architektur-Änderungen nötig sind (z.B. HINT-Erkennung aus der Kandidaten-Auswahl herausziehen), ADR anpassen.

## Alternativen verworfen
- **HINT-Mechanismus komplett entfernen** — nicht sinnvoll, da er für Workflows genutzt wird.
- **Workaround via Blockliste** — keine saubere Lösung.

## Verwandte Dokumente
- `src/content-classifier.ts` — HINT-Detektion
- `src/classification-prompt.ts` — Prompt-Aufbereitung
- `src/utils.ts` — `stripRouterNarration` (Narration-Leak Fix 26e99f0)
- ADR-0002: Narration-Leak Fix (2026-09-18)

## Verantwortlichkeit
Achim / pi-team

## Reviewer
- [ ] Code-Review via `requesting-code-review` mit Code-Reviewer-Template
- [ ] Roborev-Review vor Release (AGENTS.md §1)

---
**Erstellt:** 2026-09-27  
**Letzte Änderung:** 2026-09-27  
**Zustand:** Entwurf
