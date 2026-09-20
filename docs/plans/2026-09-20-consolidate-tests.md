# Test Suite Konsolidierung — Implementierungsplan

> **REQUIRED SUB-SKILL:** Verwende nach diesem Plan das `/skill:executing-plans`, um die Tasks Schritt für Schritt umzusetzen.

**Goal:** Reduziere die ~800 Tests auf eine wartbare, performante Suite durch Identifikation und Deaktivierung veralteter/unbenutzter Tests, ohne funktionale Abdeckung zu verlieren. Erhalte Reversibilität durch `.skip` statt Löschen.

**Architektur:**
- **Keine funktionalen Änderungen** — nur Test-Bereinigung.
- **TDD-Prinzip:** Vor dem Deaktivieren/Löschen sicherstellen, dass die Test-Suite grün bleibt und die Abdeckung nicht sinkt.
- **Reversibilität:** `.skip` statt Löschen; PR mit Begründung, Review vor finaler Löschung.
- **Datengetrieben:** Inventur via `vitest list`, `git log`, `rg`, und Ausführungszeiten.

**Tech Stack:**
- vitest 1.x
- TypeScript
- bash / Node.js
- git

---

## Vorbereitung

### Task 0: Worktree und Baseline sichern
**Files:**
- Create: (keine neuen Dateien)
- Modify: `.gitignore` (optional)

**Schritte:**
1. **Aktuellen Stand commiten** (falls nicht bereits geschehen):
   ```bash
   git add .
   git commit -m "chore: baseline vor Test-Konsolidierung"
   ```
2. **Baseline-Ausführungszeit und -Coverage messen:**
   ```bash
   npx vitest run --run --reporter=basic > /tmp/before_consolidation.txt
   npx vitest run --run --coverage --reporter=basic > /tmp/coverage_before.txt
   echo "Baseline gespeichert in /tmp/before_consolidation.txt und /tmp/coverage_before.txt"
   ```

**Erwartet:**
- `before_consolidation.txt` enthält die Test-Ergebnisse vor Änderungen.
- `coverage_before.txt` enthält die Code-Coverage vor Änderungen.

---

## Phase 1: Inventur (1–2 Stunden)

### Task 1: Alle Testdateien auflisten und analysieren
**Files:**
- Modify: (keine Dateien, nur Befehle)

**Schritte:**
1. **Alle Testdateien auflisten:**
   ```bash
   find test -name "*.test.ts" -type f | sort > /tmp/all_tests.txt
   wc -l /tmp/all_tests.txt
   ```
   **Erwartet:**
   ```
   93 /tmp/all_tests.txt
   ```

2. **Letzte Änderungen pro Testdatei anzeigen:**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do 
     echo -n "$f "; 
     git log --oneline -n 1 -- "$f" 2>/dev/null || echo "no commits"; 
   done | sort -k2 > /tmp/test_last_commit.txt
   head -20 /tmp/test_last_commit.txt
   ```

3. **Testblöcke pro Datei zählen (describe/it):**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do 
     echo -n "$f "; 
     rg "describe\(|it\(" "$f" | wc -l; 
   done > /tmp/test_blocks.txt
   awk '$2<5 {print}' /tmp/test_blocks.txt | head -10
   ```
   **Erwartet:**
   - Dateien mit <5 Blöcken sind Kandidaten für Deaktivierung.

4. **Ausführungszeit pro Testdatei messen:**
   ```bash
   npx vitest run --run --reporter=verbose --no-coverage 2>&1 | tee /tmp/vitest_run.txt | grep "✓ test/" | awk '{print $2, $3}' | sort -k2 > /tmp/test_times.txt
   wc -l /tmp/test_times.txt
   head -20 /tmp/test_times.txt
   ```

**Ergebnis:**
- `/tmp/all_tests.txt` – Liste aller 93 Testdateien
- `/tmp/test_last_commit.txt` – Letzte Commits pro Datei
- `/tmp/test_blocks.txt` – Testblock-Anzahl pro Datei
- `/tmp/test_times.txt` – Ausführungszeiten pro Datei

---

### Task 2: Kandidaten für Konsolidierung identifizieren
**Files:**
- Create: `docs/plans/candidates_consolidation.md`

**Schritte:**
1. **Kriterien anwenden:**
   - **Alter:** Keine Commits seit >6 Monaten
   - **Mock-Tiefe:** Nur Mock-Objekte, keine Router-Logik
   - **Redundanz:** Gleiche Funktion getestet in mehreren Dateien
   - **Architektur:** Vor ADR-0007 (Delegation, Bulk-Read)

2. **Erste Kandidaten aus Audit-Plan übernehmen und verfeinern:**
   ```markdown
   ## Erste Kandidaten (vorläufig)
   
   | Datei | Letzter Commit | Blöcke | Zeit (ms) | Begründung |
   |-------|----------------|--------|-----------|------------|
   | test/cache.test.ts | <6 Monate | 3 | 120 | Nur Cache-Objekte, keine Router-Logik |
   | test/model-matcher-batched.test.ts | <6 Monate | 2 | 80 | Altes Modell-Matching vor GDPval-Reengineering |
   | test/scratch-slug-debug.test.ts | <6 Monate | 1 | 10 | Debug-Datei, keine Tests |
   | test/provider-shadow.test.ts (Teile) | <6 Monate | 8 | 450 | Shadowing-Logik vor ADR-0007 |
   ```

3. **Manuell prüfen:**
   - `test/cache.test.ts`: `rg "Router\|routing\|applyGroupFilters" test/cache.test.ts` → sollte keine Treffer haben
   - `test/model-matcher-batched.test.ts`: `rg "GDPval|slug" test/model-matcher-batched.test.ts` → sollte keine Treffer haben
   - `test/scratch-slug-debug.test.ts`: `cat test/scratch-slug-debug.test.ts` → sollte nur Debug-Code enthalten

**Ergebnis:**
- `docs/plans/candidates_consolidation.md` mit Tabelle der Kandidaten und Begründungen.

---

## Phase 2: Analyse (2–4 Stunden)

### Task 3: Redundanz und Abdeckung prüfen
**Files:**
- Modify: `docs/plans/candidates_consolidation.md`

**Schritte:**
1. **Redundanz zwischen Dateien prüfen:**
   ```bash
   # Beispiel: provider-shadow vs. routing.integration
   rg "provider.*mistral|mistral.*provider" test/provider-shadow.test.ts test/routing.integration.test.ts | wc -l
   ```
   **Erwartet:**
   - provider-shadow.test.ts hat Shadowing-Logik (vor ADR-0007), routing.integration.test.ts hat moderne Router-Tests → Teile können deaktiviert werden.

2. **Coverage-Report vor Konsolidierung anzeigen:**
   ```bash
   npx vitest run --run --coverage --reporter=basic > /tmp/coverage_before.txt
   cat /tmp/coverage_before.txt | grep -A 20 "Coverage summary"
   ```

3. **Funktionen identifizieren, die nur von Kandidaten-Tests abgedeckt werden:**
   ```bash
   # Beispiel: Cache-Funktionen
   rg "setCache|getCache|cache" src/ | grep -v "test/" | cut -d: -f1 | sort -u
   ```
   **Entscheidung:**
   - Wenn keine funktionalen Aufrufe in `src/` → Cache-Tests können deaktiviert werden.

**Ergebnis:**
- `docs/plans/candidates_consolidation.md` um Spalte "Funktionale Abdeckung" und "Risiko bei Deaktivierung" ergänzt.

---

### Task 4: Flaky-Tests dokumentieren
**Files:**
- Modify: `docs/plans/candidates_consolidation.md`

**Schritte:**
1. **Flaky-Tests identifizieren:**
   ```bash
   npx vitest run --run --retry=3 --reporter=verbose 2>&1 | grep -i "flaky\|failed after retries" || echo "Keine Flaky-Tests gefunden"
   ```
   Falls Flaky-Tests gefunden werden:
   ```bash
   npx vitest run --run --retry=3 --reporter=basic > /tmp/flaky_before.txt
   ```

2. **Separate Issue erstellen:**
   - Titel: `Issue: Flaky-Tests identifizieren und beheben`
   - Inhalt: Liste der Flaky-Tests aus `/tmp/flaky_before.txt`

**Ergebnis:**
- Flaky-Tests in `candidates_consolidation.md` als separates Kapitel.

---

## Phase 3: Bereinigung (2–3 Stunden)

### Task 5: Tests deaktivieren (`.skip`) statt löschen
**Files:**
- Modify: `test/cache.test.ts`, `test/model-matcher-batched.test.ts`, `test/scratch-slug-debug.test.ts`, `test/provider-shadow.test.ts`

**Schritte pro Datei:**

#### 5.1: test/cache.test.ts
**Schritte:**
1. **Datei öffnen:**
   ```bash
   code test/cache.test.ts
   ```
2. **Alle `describe`/`it`-Blöcke mit `.skip` versehen:**
   ```ts
   describe.skip('Cache tests (veraltet, nur Mock-Objekte)', () => {
     it.skip('should cache available models', () => { ... })
     // ... alle Tests
   });
   ```
3. **Commit:**
   ```bash
   git add test/cache.test.ts
   git commit -m "test: deaktivieren veraltete Cache-Tests"
   ```

#### 5.2: test/model-matcher-batched.test.ts
**Schritte:**
1. **Datei öffnen:**
   ```bash
   code test/model-matcher-batched.test.ts
   ```
2. **Alle Tests mit `.skip` versehen:**
   ```ts
   describe.skip('Legacy model matcher (vor GDPval-Reengineering)', () => { ... })
   ```
3. **Commit:**
   ```bash
   git add test/model-matcher-batched.test.ts
   git commit -m "test: deaktivieren Legacy model-matcher-Tests"
   ```

#### 5.3: test/scratch-slug-debug.test.ts
**Schritte:**
1. **Datei öffnen:**
   ```bash
   code test/scratch-slug-debug.test.ts
   ```
2. **Gesamte Datei mit `.skip` versehen:**
   ```ts
   describe.skip('Debug-Tests (keine funktionalen Tests)', () => { ... });
   ```
3. **Commit:**
   ```bash
   git add test/scratch-slug-debug.test.ts
   git commit -m "test: deaktivieren Debug-Tests"
   ```

#### 5.4: test/provider-shadow.test.ts (Teile)
**Schritte:**
1. **Datei öffnen:**
   ```bash
   code test/provider-shadow.test.ts
   ```
2. **Nur die Shadowing-Logik-Blöcke mit `.skip` versehen:**
   ```ts
   describe.skip('Legacy provider shadowing (vor ADR-0007)', () => { ... });
   ```
3. **Commit:**
   ```bash
   git add test/provider-shadow.test.ts
   git commit -m "test: deaktivieren Legacy provider-shadowing-Tests"
   ```

**Ergebnis:**
- 4 Dateien mit `.skip` versehen
- 4 neue Commits

---

### Task 6: Dokumentation aktualisieren
**Files:**
- Modify: `CHANGES.md`, `IMPLEMENTATION_SUMMARY.md`

**Schritte:**
1. **CHANGES.md aktualisieren:**
   ```markdown
   - test: Deaktivieren veralteter Tests (cache.test.ts, model-matcher-batched.test.ts, scratch-slug-debug.test.ts, provider-shadow.test.ts Teile) — .skip statt Löschen für Reversibilität
   ```
2. **IMPLEMENTATION_SUMMARY.md aktualisieren:**
   ```markdown
   - Test-Konsolidierung: 4 Testdateien deaktiviert, Baseline erhalten, Reversibilität via .skip
   ```
3. **Commit:**
   ```bash
   git add CHANGES.md IMPLEMENTATION_SUMMARY.md
   git commit -m "docs: aktualisieren nach Test-Konsolidierung"
   ```

---

## Phase 4: Validierung (1–2 Stunden)

### Task 7: Baseline nach Konsolidierung messen
**Files:**
- Modify: (keine Dateien)

**Schritte:**
1. **Tests ausführen und Ergebnisse speichern:**
   ```bash
   npx vitest run --run --reporter=basic > /tmp/after_consolidation.txt
   npx vitest run --run --coverage --reporter=basic > /tmp/coverage_after.txt
   ```
2. **Differenz anzeigen:**
   ```bash
   diff /tmp/before_consolidation.txt /tmp/after_consolidation.txt
   diff /tmp/coverage_before.txt /tmp/coverage_after.txt
   ```
   **Erwartet:**
   - Keine neuen Fehler
   - Coverage unverändert (oder minimal verbessert durch weniger Mock-Overhead)

3. **Ausführungszeit vergleichen:**
   ```bash
   echo "Vorher: $(grep "Test Files" /tmp/before_consolidation.txt | awk '{print $4}')"
   echo "Nachher: $(grep "Test Files" /tmp/after_consolidation.txt | awk '{print $4}')"
   ```

**Ergebnis:**
- `/tmp/after_consolidation.txt` und `/tmp/coverage_after.txt` zeigen keine Regression.

---

### Task 8: PR erstellen und Review abwarten
**Files:**
- Modify: (keine Code-Änderungen, nur PR-Erstellung)

**Schritte:**
1. **PR erstellen:**
   ```bash
   git push origin HEAD:test-consolidation
   gh pr create --title "test: Konsolidierung veralteter Tests" --body "$(cat docs/plans/candidates_consolidation.md)" --label "test"
   ```
2. **Review abwarten:**
   - Reviewer kann Änderungen kommentieren
   - Bei Einwänden: `.skip` → `.only` oder Tests anpassen
   - Bei Freigabe: nächste Phase

---

### Task 9: Finale Löschung oder weitere Anpassung
**Files:**
- Modify: `test/cache.test.ts`, `test/model-matcher-batched.test.ts`, `test/scratch-slug-debug.test.ts`, `test/provider-shadow.test.ts`

**Schritte (nach Review-Freigabe):**
1. **`.skip` → `.only` prüfen:**
   Falls `.only` gesetzt, zurücksetzen.
2. **Tests endgültig löschen:**
   ```bash
   git rm test/cache.test.ts test/model-matcher-batched.test.ts test/scratch-slug-debug.test.ts
   git commit -m "test: entfernen veraltete Cache-Tests"
   ```
3. **Oder Tests behalten und weiter reduzieren:**
   ```bash
   # Beispiel: Nur 1 Test behalten
   git checkout HEAD~1 -- test/cache.test.ts
   # ... manuell reduzieren
   git add test/cache.test.ts
   git commit -m "test: behalten nur einen Cache-Test"
   ```

---

## Zusammenfassung der erwarteten Ergebnisse

| Phase | Dauer | Ergebnis |
|-------|-------|----------|
| Vorbereitung | 10 min | Baseline gespeichert |
| Inventur | 1–2 h | Kandidatenliste in `candidates_consolidation.md` |
| Analyse | 2–4 h | Risikoanalyse und Abdeckungsprüfung |
| Bereinigung | 2–3 h | 4 Dateien mit `.skip`, Dokumentation aktualisiert |
| Validierung | 1–2 h | Keine Regression, PR erstellt |
| Finale Löschung | 30 min | Optional nach Review |

**Gesamt:** ~8 Stunden (1 Arbeitstag)

---

## Risiken & Abwägungen

- **Reversibilität:** `.skip` statt Löschen erlaubt schnelles Revert.
- **Falsch-positive Kandidaten:** Im Zweifel Datei behalten und Tests reduzieren.
- **Flaky-Tests:** Separate Issue erstellen, nicht in dieser Konsolidierung behandeln.
- **Coverage:** Vor/nach Vergleich sicherstellen, dass keine funktionale Abdeckung verloren geht.

---

## Nächste Schritte nach diesem Plan

1. **Plan ausführen** mit `/skill:executing-plans` (dieser Plan als Anleitung).
2. **PR erstellen** und Review abwarten.
3. **Nach Freigabe:** Finale Löschung oder weitere Anpassung.
4. **Flaky-Tests separat behandeln** (Issue erstellen).

---

**Fertig.**

> **Frage an dich:** Soll ich diesen Plan jetzt mit `/skill:executing-plans` umsetzen?
> 
> Optionen:
> - **Ja, Subagent-Driven in dieser Session** — ich führe jeden Task als Subagent aus, du reviewst zwischen den Tasks
> - **Nein, ich mache es selbst** — du öffnest eine neue Session mit `/skill:executing-plans` und arbeitest den Plan dort ab
> 
> Wähle eine Option.