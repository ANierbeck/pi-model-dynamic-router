# Migration pi-model-router → @earendil-works/* 0.82.1

Arbeitsanweisung. Schritte strikt in Reihenfolge abarbeiten, nach jedem Schritt die
angegebene Verifikation ausführen. Nicht weitergehen, wenn eine Verifikation fehlschlägt.

## Kontext (warum das nötig ist)

Das laufende `pi` nutzt `@earendil-works/pi-ai` **0.82.1**. Das Repo hat als
devDependency **0.74.2**. Der Build markiert pi-ai als `--external`, der Import bleibt
also bare im Bundle und Node löst ihn zur Laufzeit von `dist/` aufwärts auf → die
veraltete Repo-Kopie. Die Extension läuft daher in einer 0.74.2-Blase.

In 0.74.2 gab es eine **modulglobale API-Registry** (`registerApiProvider` /
`getApiProvider`). Extensions wie `claude-bridge` registrieren ihren Stream-Handler
beim Host; in der Blase des Routers ist er unsichtbar, weil dort nur die Builtins
sich selbst eintragen. Genau daran scheitert das HINT-Routing auf
`claude-bridge/*`-Modelle.

In 0.82.1 ist diese globale Registry entfernt. Streaming gehört jetzt dem jeweiligen
`Provider`-Objekt (`Provider.streamSimple`), erreichbar über
`ModelRegistry.getProvider(id)`.

Entfernte Exports in pi-ai 0.82.1: `streamSimple`, `stream`, `getApiProvider`,
`registerApiProvider`. Neu: `hasApi`, `lazyApi`, `lazyStream`.

## Vorab geprüft — diese APIs sind in 0.82.1 unverändert vorhanden

Nicht anfassen, kein Migrationsbedarf:

- `pi.registerProvider(name, config)` inkl. `streamSimple` und `api` im Config-Objekt
- `pi.unregisterProvider`, `pi.registerCommand`, `pi.on(...)`
- `ctx.ui.setFooter`, `ctx.ui.notify`
- `ctx.sessionManager.getBranch()`
- `ctx.modelRegistry.find()`, `.getAvailable()`, `.getApiKeyForProvider()` — alle weiterhin synchron bzw. mit gleicher Signatur
- `truncateToWidth` aus `@earendil-works/pi-tui`

Typprüfung gegen 0.82.1 ergab exakt **zwei** Fehler, beide in `index.ts`:

```
index.ts(20,3): error TS2305: Module '"@earendil-works/pi-ai"' has no exported member 'streamSimple'.
index.ts(22,3): error TS2305: Module '"@earendil-works/pi-ai"' has no exported member 'getApiProvider'.
```

Der Migrationsumfang ist also klein und auf `tryStream` konzentriert.

---

## Schritt 1 — devDependencies auf 0.82.1 heben

```bash
cd /Users/anierbeck/git/pi-model-router-fork
npm install -D @earendil-works/pi-ai@0.82.1 @earendil-works/pi-coding-agent@0.82.1 @earendil-works/pi-tui@0.82.1
```

`peerDependencies` bleiben auf `"*"` — nicht ändern.

**Verifikation:**

```bash
node -p "require('./node_modules/@earendil-works/pi-ai/package.json').version"   # muss 0.82.1 sein
```

---

## Schritt 2 — Laufzeit auf eine einzige Modulinstanz zwingen (nur Dev-Setup)

Auch bei identischer Version bleiben es zwei physische Kopien und damit zwei
Modulinstanzen. Für lokales Testen die Repo-Kopien auf die Host-Kopien symlinken
(Node löst per realpath auf → identische Instanz wie der Host):

```bash
cd /Users/anierbeck/git/pi-model-router-fork/node_modules/@earendil-works
H=$HOME/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent
rm -rf pi-ai pi-tui pi-agent-core
ln -s "$H/node_modules/@earendil-works/pi-ai"          pi-ai
ln -s "$H/node_modules/@earendil-works/pi-tui"         pi-tui
ln -s "$H/node_modules/@earendil-works/pi-agent-core"  pi-agent-core
rm -rf pi-coding-agent && ln -s "$H" pi-coding-agent
```

**Wichtig:** Ein späteres `npm install` überschreibt diese Symlinks. Dann Schritt 2
wiederholen. Das ist reines Dev-Setup und gehört **nicht** ins Repo committet.

**Verifikation:**

```bash
cd /Users/anierbeck/git/pi-model-router-fork
ls -l node_modules/@earendil-works/   # alle vier müssen Symlinks sein
```

---

## Schritt 3 — `index.ts`: Imports korrigieren

**Datei:** `index.ts`, Zeilen 19–23.

Vorher:

```ts
import {
  streamSimple as piStreamSimple,
  createAssistantMessageEventStream,
  getApiProvider,
} from '@earendil-works/pi-ai';
```

Nachher:

```ts
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
```

`piStreamSimple` und `getApiProvider` werden in Schritt 4 vollständig ersetzt; nach
Schritt 4 darf keine Referenz darauf mehr existieren.

---

## Schritt 4 — `index.ts`: `tryStream` auf den Host-Stream-Pfad umstellen

**Datei:** `index.ts`, Funktion `tryStream` (beginnt bei ca. Zeile 1454).

### 4a — Neuen Helper direkt oberhalb von `tryStream` einfügen

```ts
/**
 * Host-eigenen streamSimple für ein Modell auflösen.
 *
 * Ab pi-ai 0.82.1 gibt es keine modulglobale API-Registry mehr — Streaming gehört
 * dem Provider-Objekt des Hosts. Das ist zugleich der Fix dafür, dass von anderen
 * Extensions registrierte Provider (z.B. claude-bridge) für den Router unsichtbar
 * waren, sobald er eine eigene pi-ai-Instanz erwischt hat.
 *
 * Bevorzugt die ModelRuntime (löst Auth, baseUrl und Header exakt so auf wie ein
 * nativer pi-Turn), fällt auf das öffentliche Provider-Objekt zurück.
 */
function hostStreamSimple(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined
): AssistantMessageEventStream | null {
  const registry = sessionCtx?.modelRegistry as any;
  if (!registry) return null;

  // Bevorzugt: ModelRuntime — identischer Pfad wie ein nativer pi-Turn.
  const runtime = registry.runtime;
  if (typeof runtime?.streamSimple === 'function') {
    return runtime.streamSimple(model, context, options);
  }

  // Fallback: öffentliches Provider-Objekt. Auth wird hier nicht aufgelöst,
  // der Router übergibt den apiKey aber ohnehin selbst in den Optionen.
  const provider = registry.getProvider?.(model.provider);
  if (typeof provider?.streamSimple === 'function') {
    return provider.streamSimple(model, context, options);
  }

  return null;
}
```

Benötigte Typimporte in `index.ts` prüfen — `Model`, `Context`, `SimpleStreamOptions`
und `AssistantMessageEventStream` werden bereits als `type` importiert. Falls eines
fehlt, ergänzen.

### 4b — Das `getApiProvider`-Gate entfernen

**Ersatzlos löschen**, aktuell ca. Zeile 1471–1478:

```ts
    // If the model's declared api has no registered stream handler in Pi (e.g. an
    // extension registers the model but never calls registerApiProvider for its api
    // string), streaming will always fail. Fail fast here instead of waiting for a
    // timeout on every candidate.
    const hasHandler = Boolean(getApiProvider(realModel.api as any));
    routerLog(`[diag] getApiProvider("${(realModel as any).api}") registered: ${hasHandler}`);
    if (!hasHandler) {
      throw new Error(`No API provider registered for api: ${realModel.api} (model "${ref}" is registered but its extension never registered a stream handler)`);
    }
```

Dieses Gate war die konkrete Stelle, an der HINTs auf `claude-bridge/*` abgebrochen
sind. Es lieferte False Negatives und hat in 0.82.1 keine Grundlage mehr.

### 4c — Den Stream-Aufruf ersetzen

Letzte Zeile von `tryStream`, aktuell ca. Zeile 1494:

```ts
    return { stream: piStreamSimple(realModel, context, streamOpts), ref };
```

wird zu:

```ts
    const stream = hostStreamSimple(realModel, context, streamOpts);
    if (!stream) {
      throw new Error(
        `No stream handler available for "${ref}" (provider=${realModel.provider}, api=${realModel.api})`
      );
    }
    routerLog(`[diag] tryStream streaming "${ref}" via host runtime`);
    return { stream, ref };
```

### 4d — Verhaltensänderung beachten, nichts dagegen unternehmen

`ModelRuntime.streamSimple` verpackt die Ausführung in `lazyStream`. Fehler kommen
dadurch **nicht mehr synchron als Throw**, sondern als Error-Event im Stream.
`consumeWithDetection` behandelt Error-Events bereits als Soft Failure und schaltet
auf den nächsten Kandidaten weiter — die Fallback-Kaskade bleibt also intakt, nur der
Weg dorthin ändert sich. **Keine Anpassung nötig.** Nicht versuchen, das synchrone
Throw-Verhalten wiederherzustellen.

---

## Schritt 5 — Versions-Skew-Diagnose einbauen

Damit dieses Problem nie wieder tagelang unentdeckt bleibt: in `pi.on('session_start')`,
direkt nach `setProjectLogDir(ctx.cwd)`, einfügen:

```ts
    try {
      const piAiPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'));
      const providerIds = (ctx.modelRegistry as any).getRegisteredProviderIds?.() ?? [];
      routerLog(`[diag] pi-ai resolved from: ${piAiPath}`);
      routerLog(`[diag] registered providers visible to router: ${[...providerIds].join(', ') || '(none)'}`);
    } catch (e) {
      routerLog('[diag] version diagnostics failed:', e);
    }
```

Erwartung nach der Migration: der Pfad zeigt unter `~/.npm-global/...` (Host-Kopie,
via Symlink), und `claude-bridge` steht in der Providerliste. Zeigt der Pfad ins
Repo-`node_modules`, ist Schritt 2 nicht wirksam.

---

## Schritt 6 — Bauen und Typprüfung

```bash
cd /Users/anierbeck/git/pi-model-router-fork
npm run build
```

**Verifikation:** `tsc` läuft ohne Fehler durch, und im Bundle darf keine der
entfernten Bindings mehr vorkommen:

```bash
grep -n "getApiProvider\|piStreamSimple" dist/index.js   # muss leer sein
```

---

## Schritt 7 — Tests

```bash
npm test
```

Fehlschlagende Tests, die auf `getApiProvider` oder `streamSimple` aus pi-ai mocken,
auf `hostStreamSimple` umstellen: statt der pi-ai-Exports ein `sessionCtx.modelRegistry`
mit `runtime.streamSimple` bzw. `getProvider()` stubben.

Keine Tests löschen, um sie grün zu bekommen.

---

## Schritt 8 — Funktionaler Test des HINT-Mechanismus

`pi` in diesem Projektverzeichnis neu starten, dann in einer frischen Session:

```
HINT: use claude-sonnet-5
```

**Erwartetes Ergebnis in `~/.pi/logs/router.log`:**

```
HINT: claude-sonnet-5  claude-bridge/claude-sonnet-5  "..."
[diag] tryStream resolved "claude-bridge/claude-sonnet-5" -> provider=claude-bridge id=claude-sonnet-5 api=claude-bridge
[diag] tryStream streaming "claude-bridge/claude-sonnet-5" via host runtime
```

**Kein** `getApiProvider(...) registered: false` mehr, und **kein** Durchfallen auf
`mistral/*`. Antwortet weiterhin ein Mistral-Modell, ist die Migration nicht wirksam —
dann Schritt 5 im Log prüfen, um zu sehen, welche pi-ai-Instanz geladen wurde.

Zusätzlich gegentesten, dass nichts anderes kaputtgegangen ist:

```
HINT: use group tactical
```

sowie ein normaler Prompt ohne HINT über die `dynamic`-Gruppe.

---

## Abschluss

Änderungen an `package.json` (devDependencies) und `index.ts` gehören ins Commit.
Die Symlinks aus Schritt 2 sind lokales Dev-Setup und liegen ohnehin in `node_modules`.

Laut `feedback_release_process`: kein Einzel-Release für diesen Fix — auf `main`
sammeln, Review und lokaler PI-Test vor dem Taggen.
