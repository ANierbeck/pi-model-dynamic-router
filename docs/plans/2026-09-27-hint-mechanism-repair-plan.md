# Plan: Reparatur des HINT-Mechanismus (HINT/MHINT/MODEL-HINT-Präfix)

## Ziel
Der HINT-Mechanismus (HINT/MHINT/MODEL-HINT-Präfix im Prompt) soll wieder funktionieren: Bei HINT-Erkennung wird die Klassifizierung unterdrückt und eine HINT-Antwort an den Benutzer ausgegeben.

## Akzeptanzkriterien
1. HINT-Präfixe (`HINT:`, `MHINT:`, `MODEL-HINT:`) werden im User-Prompt erkannt.
2. Bei HINT-Erkennung wird die Klassifizierung unterdrückt und eine HINT-Antwort generiert.
3. Die HINT-Antwort wird als `HINT: ...` an den Benutzer gesendet (Narration oder Message).
4. Regressionstest deckt den Fall ab.
5. Commit: `fix: repair HINT-mechanism (detect hint prefix and suppress classification)`

---

## Bite-size Tasks (2–5 min)

### 1. Reproduktion testen
- [ ] Neue Test-Datei `test/classifier-hint-regression.test.ts` anlegen.
- [ ] Testfall 1: Prompt mit `HINT: Bitte beachte die folgende Anleitung` → Assert: Klassifizierung unterdrückt, HINT-Antwort generiert.
- [ ] Testfall 2: Prompt ohne HINT → Assert: normale Klassifizierung.
- [ ] Testfall 3: `MHINT:` und `MODEL-HINT:` Präfixe testen.

**Owner:** pi  
**Zeit:** 15 min

### 2. Root Cause analysieren
- [ ] Code-Review von `src/content-classifier.ts`:
  - `detectHintDirectly(text: string): boolean` — Regex prüfen: `/HINT[:\s]/i`
  - `containsHintMarker(text: string): boolean` — Logik prüfen.
  - `classifyPrompt()` — Reihenfolge der Kandidaten, HINT-Erkennung, Unterdrückung.
- [ ] `extractLastUserPrompt` prüfen: Stripped Router-Nachrichten? (Narration-Leak Fix 26e99f0)
- [ ] Log-Analyse: `~/.pi/logs/router.log` nach HINT-Zeilen durchsuchen.

**Owner:** pi  
**Zeit:** 20 min

### 3. Fix umsetzen (Code-Änderung)
**Option A: Narration-Leak (wahrscheinlichste Ursache)**
- [ ] `extractLastUserPrompt` prüfen: Falls Router-Nachrichten eingeschleust werden, strippen wie in 26e99f0.
- [ ] `classifyPrompt` prüfen: HINT-Erkennung VOR der Kandidaten-Auswahl durchführen.

**Option B: Regex-Anpassung**
- [ ] `detectHintDirectly` Regex erweitern: `/HINT[:\s]|MHINT[:\s]|MODEL-HINT[:\s]/i`

**Option C: Unterdrückungslogik**
- [ ] `classifyPrompt` so anpassen, dass bei HINT-Erkennung die Klassifizierung übersprungen und eine HINT-Antwort zurückgegeben wird.

**Owner:** pi  
**Zeit:** 25 min

### 4. HINT-Antwort generieren
- [ ] Bei HINT-Erkennung: `return { ok: true, isHint: true, hintText: '...' }` oder ähnliches Schema.
- [ ] `stream-orchestrator.ts` anpassen: Falls `isHint: true`, Narration `> [router] HINT: ...` ausgeben und die Antwort als HINT an den Benutzer senden.

**Owner:** pi  
**Zeit:** 15 min

### 5. Tests finalisieren
- [ ] `test/classifier-hint-regression.test.ts` muss grün werden.
- [ ] Bestehende Tests prüfen: `test/classifier-mapping-hints.test.ts`, `test/hint-classification.test.ts` — dürfen nicht brechen.
- [ ] Falls nötig: Tests anpassen oder neue Assertions hinzufügen.

**Owner:** pi  
**Zeit:** 10 min

### 6. Verifikation
- [ ] `npx tsc --noEmit` (clean)
- [ ] `npx vitest run` (bestehende Tests grün)
- [ ] `npm run build` → `dist/index.js`
- [ ] Live-Test: Prompt mit `HINT: ...` → Router gibt HINT-Antwort aus.

**Owner:** pi  
**Zeit:** 15 min

### 7. Commit & Dokumentation
- [ ] Commit: `fix: repair HINT-mechanism (detect hint prefix and suppress classification)`
- [ ] Commit-Message Body erklärt WHY (HINT-Mechanismus war defekt, Reparatur nötig für Workflows).
- [ ] CHANGELOG.md Eintrag (optional)
- [ ] ADR-0018 finalisieren (falls Architektur-Änderungen nötig waren).

**Owner:** pi  
**Zeit:** 5 min

---

## Zeitaufwand gesamt
~105 min (kumulativ, inkl. Tests + Verifikation)

## Abhängigkeiten
- Keine — nutzt bestehende Klassifizierungs-Logik.

## Risiken & Mitigations
- **Falsche HINT-Erkennung:** Regex testen mit verschiedenen Präfixen.
- **Narration-Leak:** `extractLastUserPrompt` strippen wie in 26e99f0.
- **CI-Tests brechen:** Bestehende Tests anpassen oder neue Regressionstests hinzufügen.

## Review
- Code-Review via `requesting-code-review` Skill
- Roborev-Review vor Release (AGENTS.md §1)

---
**Erstellt:** 2026-09-27  
**Letzte Änderung:** 2026-09-27  
**Zustand:** Entwurf
