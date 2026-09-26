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
