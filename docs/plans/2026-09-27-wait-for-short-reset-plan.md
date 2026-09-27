# Plan: Bounded Wait-for-Short-Reset (ADR-0017)

## Ziel
Der Router soll bei Rate-Limits mit **bekanntem, nahem Reset** warten und das Modell neu versuchen, statt die komplette Kandidatenkette durchzubrennen. Der Total-Cooldown-Collapse darf nicht mehr in bekannte, nicht abgelaufene Cooldowns force-retryen (Selbstvergiftung). Sofort-Entlastung für künftige Vorfälle: `/router cooldowns [clear]`.

## Hintergrund (Vorfall 2026-09-27, 12:36–12:44 UTC)
Vollständige Rekonstruktion in ADR-0017. Kurz: 60s-TPM-Fenster wurde ignoriert → Kette brannte durch → jede Folgerequest wiederholte das → Collapse-Zweig force-retried in eigene, laufende Cooldowns → Cooldowns eskalierten über die reale Provider-Erholung hinaus → Router minutenlang tot, während die API längst ging (Beweis: Hard-Set auf zai-glm-5-3 funktionierte sofort).

## Umgesetzt (Stand 2026-09-27)

### 1. Config-Plumbing
- [x] `rate_limit_wait_max_ms` (Default 120s, 0 = aus): router-defaults.yaml, types.ts (Defaults + Config), index.ts (`getRateLimitWaitMaxMs()`), stream-orchestrator ctx
- [x] `backoff_minutes` / `soft_backoff_ms` sind jetzt **cfg-backed** (fielen vorher nur aus den YAML-Defaults) — ops-tunbar ohne Rebuild, und in Integrationstests verkleinerbar
- [x] **Dynamic-Config-Whitelist erweitert**: `stall_timeout_ms`, `rate_limit_wait_max_ms`, `backoff_minutes`, `soft_backoff_ms` werden jetzt wie `exclude`/empty-timeouts aus staticCfg re-synced — ohne das hätten stale dynamic-Dateien (existiert nach jedem Scan!) die User-Overrides still überschattet. `stall_timeout_ms` fehlte bereits in der Whitelist (gleicher Bug-Fund, Boyscout)

### 2. Wait-for-Short-Reset (driveStream, rate_limit-Branch)
- [x] Bei `rate_limit_exceeded` mit `resetAtMs` in (0, `rate_limit_wait_max_ms`]: Narration "waiting Ns, then retrying…", Schlaf bis Reset+2s, **gleiche Modell 1× neu versuchen**; Erfolg → fertig; erneuter Fail → record + "still failing" → normale Kaskade
- [x] Maximal **ein** Wait pro driveStream-Aufruf (`rateLimitWaitUsed`) — keine Livelocks
- [x] Key-Rotation (`rotated`) überspringt den Wait (kein Cooldown auf dem Ref)

### 3. Collapse-Zweig-Reparatur
- [x] `bestSecs * 1000 ≤ rate_limit_wait_max_ms` → **warten** (bestSecs+2s), dann erst retryen — kein Force-Retry mehr in bekannte, laufende Cooldowns
- [x] Lange Restzeiten: alte Immediate-Retry-Semantik unverändert
- [x] Collapse-Narration von `pushRouterInfo` (unsichtbar im router.log!) auf `pushRouterInfoLogged` umgestellt

### 4. `/router cooldowns [clear]`
- [x] `RateLimitManager.listLimits()` — aktive Cooldowns (kürzeste zuerst, Hits, Provider-Reset) 
- [x] `RateLimitManager.clearAllLimits()` — alle In-Memory-Cooldowns
- [x] Handler: `cooldowns` zeigt Cooldowns + model_health-Streaks; `cooldowns clear` löscht Cooldowns + `cache.model_health` (persistiert!) + saveCache — **ohne pi-Neustart**

### 5. Tests
- [x] `test/rate-limit-wait.test.ts` (4 Tests): Wait-Retry ohne Ketten-Burn (Healthy wird NIE angerührt), Far-Reset → keine Wait → normale Kaskade, Collapse-Wait (kürzester Cooldown wird abgewartet, dann Erfolg), listLimits/clearAllLimits
- [x] 13 betroffene Legacy-Tests: explizites `rate_limit_wait_max_ms: 0` (sie testen bewusst die Non-Wait-Pfade)
- [x] `npx tsc --noEmit` clean · Suite **1026 passed** (+4)

### 6. Build & Rollout
- [x] `npm run build`
- [ ] pi-Neustart (lädt neuen Bundle); danach ist Hard-Set auf zai-glm-5-3 nicht mehr nötig — Routing wieder nutzbar; notfalls `/router cooldowns clear`

## Offen (separat)
- ADR-0018 HINT-Reparatur (eigene Runde; MHINT-Verhalten im Vorfallfenster fiel auf — als Input für die Analyse notiert)
- mistral-small-latest-Demotion (C-Schritt) — Decision nach erster neuer StopReason-Evidenz
