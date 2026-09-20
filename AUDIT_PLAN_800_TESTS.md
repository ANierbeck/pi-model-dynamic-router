# Audit-Plan: ~800 Tests (Verdacht auf alte/unbenutzte Tests)

## Ziel
Identifizieren und bereinigen alter/unbenutzter Tests, um die Test-Suite schlanker und schneller zu machen, ohne Funktionalität zu verlieren.

## Kriterien für "veraltet/unbenutzt"
- Tests, die seit >6 Monaten nicht mehr geändert wurden und deren Funktionalität durch neuere Tests abgedeckt ist.
- Tests, die nur Mocks/Stubs testen und keine Router-Logik.
- Tests, die von anderen Tests redundant abgedeckt werden (z.B. mehrere Tests für dieselbe Funktion mit leicht anderen Mocks).
- Tests, die auf veraltete Router-Architektur verweisen (z.B. vor ADR-0007, vor Delegation, vor Bulk-Read).

## Tools & Methoden
- `vitest list` / `vitest list --exclude "**/node_modules/**"` → alle Testdateien auflisten
- `git log --since="6 months ago" --oneline -- test/` → letzte Änderungen pro Testdatei
- `rg "describe\\|it\(" test/*.test.ts | wc -l` → Anzahl der Testblöcke pro Datei
- `npx vitest run --reporter=verbose` → welche Tests tatsächlich ausgeführt werden (inkl. Zeit pro Test)
- `npx vitest list-unused` (falls verfügbar) oder manuelle Analyse

## Schritt-für-Schritt-Plan

### Phase 1: Inventur (1–2h)
1. **Alle Testdateien auflisten**
   ```bash
   find test -name "*.test.ts" -type f | sort > /tmp/all_tests.txt
   wc -l /tmp/all_tests.txt
   ```
   → Aktuell: 93 Testdateien (804 Tests).

2. **Letzte Änderungen pro Testdatei**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do echo -n "$f "; git log --oneline -n 1 -- "$f" 2>/dev/null || echo "no commits"; done | sort -k2
   ```
   → Fokus auf Dateien ohne Commits seit >6 Monaten.

3. **Testblöcke pro Datei zählen**
   ```bash
   for f in $(cat /tmp/all_tests.txt); do echo -n "$f "; rg "describe\(|it\(" "$f" | wc -l; done | awk '$2<5 {print}'
   ```
   → Dateien mit <5 Testblöcken prüfen, ob sie redundant sind.

4. **Ausführungszeit pro Testdatei messen**
   ```bash
   npx vitest run --reporter=verbose --no-coverage 2>&1 | grep "Test Files" -A 2
   ```
   → Langsamste Dateien identifizieren (z.B. >5s pro Datei).

### Phase 2: Analyse (2–4h)
1. **Redundanz-Check**
   - Für jede Testdatei prüfen, ob die abgedeckte Funktion bereits durch andere Tests (z.B. integration, routing.integration) abgedeckt ist.
   - Beispiel: `test/provider-shadow.test.ts` vs. `test/routing.integration.test.ts` (Provider-Shadowing-Logik).

2. **Mock-Tiefe prüfen**
   - Tests, die nur Mocks von Mocks testen (z.B. `test/cache.test.ts` mit reinem Cache-Verhalten), können oft entfallen, da die Cache-Logik in `src/cache.ts` durch andere Tests indirekt geprüft wird.

3. **Architektur-History prüfen**
   - Tests, die vor ADR-0007 (Delegation) oder vor Bulk-Read entstanden sind und seitdem nicht mehr angepasst wurden, sind Kandidaten für Konsolidierung.

4. **Flaky-Tests markieren**
   - Tests, die in CI oft fehlschlagen und manuell nachgelaufen werden müssen, separat dokumentieren (nicht löschen, sondern fixen).

### Phase 3: Bereinigung (2–3h)
1. **Tests deaktivieren statt löschen**
   - Vor dem Löschen: Tests in `.skip` ändern und PR mit Begründung erstellen.
   - Beispiel:
     ```ts
     describe.skip('legacy: old architecture', () => { ... })
     ```

2. **Dokumentation aktualisieren**
   - `CHANGES.md` oder `IMPLEMENTATION_SUMMARY.md` um gelöschte/skippte Tests ergänzen.
   - Commit-Message: `test: deactivate legacy tests for old architecture (no functional change)`

3. **CI-Verify**
   - Nach jedem Batch: `npx tsc --noEmit && npx vitest run` sicherstellen, dass nichts kaputt geht.

### Phase 4: Validierung (1–2h)
1. **Neue Baseline messen**
   - Nach Bereinigung: Ausführungszeit der Suite vergleichen.
   - Beispiel:
     ```bash
     git stash
     npx vitest run --run --reporter=basic > /tmp/before.txt
     git stash pop
     npx vitest run --run --reporter=basic > /tmp/after.txt
     diff /tmp/before.txt /tmp/after.txt
     ```

2. **Coverage prüfen**
   - `npx vitest run --coverage` vor/nachher vergleichen: keine neuen uncovered lines.

3. **Manuelle Verifikation**
   - `/router status` und `/router model <name>` manuell testen, um keine Regression einzuführen.

## Empfohlene erste Kandidaten zum Deaktivieren/Skipp

| Testdatei | Begründung | Alternative Tests |
|-----------|------------|-------------------|
| test/cache.test.ts | Testet nur Cache-Objekte, keine Router-Logik | Indirekt durch routing.integration.test.ts abgedeckt |
| test/model-matcher-batched.test.ts | Altes Modell-Matching vor GDPval-Reengineering | routing.integration.test.ts, apply-group-filters.test.ts |
| test/scratch-slug-debug.test.ts | Debug-Datei, keine Tests | – |
| test/provider-shadow.test.ts (Teile) | Shadowing-Logik vor ADR-0007 | routing.integration.test.ts |

## Risiken & Abwägungen
- **Löschen vs. Skipp**: Lieber skipp, um bei Bedarf schnell revertieren zu können.
- **Coverage**: Im Zweifel Datei behalten und nur Tests reduzieren.
- **CI-Flakes**: Separate Issue für Flaky-Tests erstellen.

## Zeitaufwand
- **Inventur**: 1–2h
- **Analyse**: 2–4h
- **Bereinigung**: 2–3h
- **Validierung**: 1–2h
- **Gesamt**: ~8h (1 Arbeitstag)

## Next Steps
1. Inventur durchführen und Liste der Kandidaten erstellen.
2. PR mit `.skip`-Änderungen erstellen und Review abwarten.
3. Nach Freigabe: Löschen oder final skipp.

---
**Frage**: Soll mit der Inventur begonnen werden, oder sollen zuerst die Footer-Polish-Änderungen in der Praxis getestet werden?
