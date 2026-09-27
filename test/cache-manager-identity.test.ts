// test/cache-manager-identity.test.ts
// Review 2026-09-27: index.ts held a separately parsed cache object while
// CacheManager wrote its own copy (updateCache even replaced it). A manager
// write (setLastScanTimestamp, scan-sanity refusal) then overwrote fresh scan
// data on disk, and the next saveCache(cache) dropped the manager's field.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CacheManager } from '../src/cache.ts';

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-identity-'));
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cache', 'scan-cache.json'), JSON.stringify({ available_models: [] }));
  return { cm: new CacheManager(dir), file: path.join(dir, '.cache', 'scan-cache.json') };
}

describe('CacheManager shares one cache object with its callers', () => {
  it('loadCache returns the object the manager writes', () => {
    const { cm } = manager();
    expect(cm.loadCache()).toBe(cm.getCache());
  });

  it('a reload keeps unsaved in-memory state when no other process wrote', () => {
    // The router saves only every 10 turns: rate-limit cooldowns, model health,
    // watchdog state and Tier-2 streaks live in memory until then. Every
    // session_start (subagents, /new) reloads the cache in the same process.
    const { cm } = manager();
    const held = cm.loadCache();
    held.exhausted_keys = { 'mistral/k1': Date.now() + 60_000 };
    expect(cm.loadCache()).toBe(held);
    expect(held.exhausted_keys).toHaveProperty(['mistral/k1']);
  });

  it('a reload after another process wrote merges its additions into the same object', () => {
    const { cm, file } = manager();
    const held = cm.loadCache();
    held.model_blocklist = { 'mine/blocked': { reason: 'r', code: 404, signature: 's', first_seen: 1, last_seen: 1, occurrences: 1 } };
    cm.saveCache(held);
    held.exhausted_keys = { 'mistral/k1': 42 }; // unsaved
    // Another Pi process adds its own block and saves the file.
    const external = JSON.parse(fs.readFileSync(file, 'utf-8'));
    external.model_blocklist['other/blocked'] = { ...external.model_blocklist['mine/blocked'] };
    external.gdpval_scraped = true;
    fs.writeFileSync(file, JSON.stringify(external));
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);

    expect(cm.loadCache()).toBe(held);
    expect(Object.keys(held.model_blocklist!).sort()).toEqual(['mine/blocked', 'other/blocked']);
    expect(held.gdpval_scraped).toBe(true);
    expect(held.exhausted_keys).toEqual({ 'mistral/k1': 42 });
  });

  it('updateCache and setLastScanTimestamp mutate that object in place', () => {
    const { cm, file } = manager();
    const cache = cm.loadCache();
    cache.classifier_fallback_models = ['fresh/model'];
    cm.setLastScanTimestamp(1234);
    cm.updateCache({ scan_sanity_refusal: { survivors: 3, previous: 37, at: 1 } });
    expect(cache.lastScanTimestamp).toBe(1234);
    expect(cache.scan_sanity_refusal).toMatchObject({ survivors: 3 });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(onDisk.classifier_fallback_models).toEqual(['fresh/model']);
    expect(onDisk.lastScanTimestamp).toBe(1234);
  });

  it('a manager rebuilt on reload adopts the caller\'s in-memory object', () => {
    const { cm } = manager();
    const live = cm.loadCache();
    live.classifier_fallback_models = ['unsaved/in-memory'];
    const rebuilt = new CacheManager(path.dirname(path.dirname(manager().file)), live);
    expect(rebuilt.getCache()).toBe(live);
  });
});
