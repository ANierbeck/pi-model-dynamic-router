# Design: Interceptierung von stopReason 'length' (max_tokens-Truncation)

## Problem (Root Cause)
Der Router klassifiziert jeden Stream so:
- Content gestreamt + Stream endet sauber → **immer** `ok: true` (Blind Spot)
- Der Grund (`stopReason`) des `done`-Events (`{ type: "done", reason: "stop" | "length" | "toolUse", message }`) wird **nie** geprüft.

Folge: Bei `reason: 'length'` (max_tokens erreicht → Antwort abgeschnitten, Aufgabe unvollständig) registriert der Router einen Erfolg → keine Cooldown, keine Blockliste, keine Wiederholung → das Modell wird beim nächsten Turn **wieder** gewählt. Das ist exakt das Symptom: "es hört einfach auf, sagt nix mehr" und "wir landen immer wieder im mistral-small-latest".

Heute im Log: 77 Stall/Empty-Ereignisse, **null** für mistral/* — weil der Stream sauber endet und der Router nichts zu beanstanden hat.

## Ziel
Blind Spot schließen: `stopReason: 'length'` als neue Soft-Failure-Klasse `truncated_length` erkennen, behandeln und loggen. Das behebt den Fehler für ALLE Modelle, nicht nur mistral-small-latest.

## Design-Entscheidungen

### A) Watcher-Interception (index.ts)
- **Funktion**: `consumeWithDetection` erhält neuen Parameter `ref: string` für Logging.
- **Neue Variable**: `let truncatedByLength = false;`
- **Event-Interception**: Im `for await`-Loop vor `proxy.push(event)`:
  ```ts
  if ((event as any).type === 'done') {
    const reason = String((event as any).reason ?? '');
    routerLog(`[stream] ${ref} finished (stopReason: ${reason}, ${accumulatedText.length} chars)`);
    if (reason === 'length') truncatedByLength = true;
  }
  ```
- **Terminal-Klassifikation**: Vor `!hadContent` prüfen:
  ```ts
  if (truncatedByLength) {
    return { ok: false, reason: 'truncated_length' };
  }
  ```

### B) StopReason-Logging (Evidence für den Restfall)
- Jedes Stream-Ende loggt `stopReason` + Content-Länge.
- Ermöglicht Unterscheidung zwischen:
  - `length`: max_tokens-Truncation → A fängt es ab.
  - `stop`: Modell gibt freiwillig auf (Modell-Qualitätsproblem) → dann manuelle Demotion/Blockliste.

### C) Orchestrator-Behandlung (stream-orchestrator.ts)
- **driveStream-Loop**: Neue Branch vor `isPaidCloudRateLimitFailure`:
  ```ts
  if (result.reason === 'truncated_length') {
    pushError(ref, 'truncated_length (hit max output tokens — answer incomplete)');
    ctx.recordSoftFailure(ref);
    const nextRef = candidates.slice(i + 1).find(r => !ctx.isLimited(r));
    const suffix = nextRef ? `, trying ${nextRef} …` : '';
    pushRouterInfoLogged(
      proxy,
      `> [router] ${ref} — output truncated at max tokens (task incomplete)${suffix}\n\n`
    );
    continue;
  }
  ```
- **bestRef-Pfad** (~line 787): Branch erweitern:
  ```ts
  if (result.reason === 'repetition_loop' || result.reason === 'truncated_length') {
    ctx.recordSoftFailure(bestRef);
    pushRouterInfoLogged(
      proxy,
      `> [router] ${bestRef} — ${result.reason === 'repetition_loop' ? 'stuck in a repetition loop' : 'output truncated at max tokens (task incomplete)'}\n\n`
    );
  }
  ```

### D) Tests
- **Watcher-Test**: Integrationstest erweitert `test/stall-timeout-detection.test.ts` um Testfall: Stream mit `done.reason === 'length'` → `ok: false`, `reason: 'truncated_length'`
- **Orchestrator-Test**: `test/stream-driver-logged.test.ts` oder `test/model-health.test.ts` prüft Narration und Soft-Failure-Akkumulation.

### E) Keine Änderungen an detection.ts
- `isRateLimitLikeReason` bleibt unverändert; `truncated_length` ist keine rate-limit-ähnliche Ursache.

## Konfiguration / Migration
- Keine Config-Änderung nötig.
- `router-config.json` unverändert.
- Bestehende Soft-Failure-Mechanik (`recordSoftFailure`, Cooldown, Blockliste) übernimmt die neue Ursache automatisch.

## Risiken & Trade-offs
- **Falsch-positive Truncation**: Ein legitimer langer Output, der genau an max_tokens endet, wird neu versucht. Akzeptabel, da max_tokens hoch (64k) und Truncation selten.
- **Performance**: Ein zusätzlicher `done`-Check pro Stream vernachlässigbar.
- **Logging**: Ein zusätzlicher Log-Eintrag pro Stream vernachlässigbar.

## Akzeptanzkriterien
1. Watcher erkennt `done.reason === 'length'` und liefert `{ ok: false, reason: 'truncated_length' }`.
2. Orchestrator startet nächsten Kandidaten mit korrekter Narration.
3. `ctx.recordSoftFailure(ref)` wird aufgerufen.
4. StopReason wird im Log ausgegeben (`[stream] ${ref} finished (stopReason: ${reason}, ...)`).
5. Bestehende Tests bleiben grün; neue Tests decken den Fall ab.
6. `npx tsc --noEmit` und `npx vitest run` grün.

## Offene Punkte (nach Evidence)
- Falls StopReason = `'stop'` (faules Aufgeben) → manuelle Demotion/Blockliste von mistral-small-latest (ADR-0008-Mechanismus).

---

## Implementierungsplan (bite-size Tasks)

### 1. Design & Planung
- [x] Design-Dokument erstellt (dieses File)

### 2. Code-Änderungen
- [ ] `consumeWithDetection` Signatur erweitern: Parameter `ref: string` hinzufügen
- [ ] Aufrufstellen in `tryStream` anpassen (2 Stellen: `consumeWithDetection` Aufrufe)
- [ ] Neue Variable `truncatedByLength` im Watcher deklarieren
- [ ] `done`-Event-Interception + Logging + Flag setzen im Loop
- [ ] Terminal-Klassifikation für `truncated_length` hinzufügen
- [ ] `stream-orchestrator.ts`: Branch für `truncated_length` in driveStream-Loop
- [ ] `stream-orchestrator.ts`: Branch in bestRef-Pfad erweitern

### 3. Tests
- [ ] `test/stall-timeout-detection.test.ts`: neuen Testfall für `truncated_length` hinzufügen
- [ ] `test/stream-driver-logged.test.ts` oder `test/model-health.test.ts`: Narration und Soft-Failure prüfen

### 4. Verifikation
- [ ] `npx tsc --noEmit` (clean)
- [ ] `npx vitest run` (bestehende Tests grün)
- [ ] `npm run build` → `dist/index.js`
- [ ] Live-Test nach Router-Neustart: mistral-small-latest wird NICHT mehr gewählt bei Truncation; Log zeigt `[stream] ... finished (stopReason: length, ...)`

### 5. Dokumentation / Commit
- [ ] Commit: `fix: intercept stopReason 'length' as truncated_length soft failure`
- [ ] Commit-Message Body erklärt WHY (Blind Spot + Symptom)
- [ ] CHANGELOG.md Eintrag (optional)
