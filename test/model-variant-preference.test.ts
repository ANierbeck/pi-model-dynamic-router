// test/model-variant-preference.test.ts — nightly R1 triage (2026-10-07),
// routing.ts same-model variant selection: modelVariantPreference,
// isBetterModelVariant, dedupByModelIdentity and
// pickSlugClusterRepresentatives. These decide WHICH spelling of one model
// the router keeps (canonical id > dated snapshot > explicit version >
// rolling -latest) — a wrong pick routes to a moving alias or hides the
// honest registry-priced twin. The nightly found the regex anchors/classes,
// the tie rule, the 3-variant replacement bookkeeping and the canonical
// check unpinned.
//
// Private methods are called through `as any` to pin the preference ladder
// number by number; dedup/representative selection are asserted through
// their observable result.

import { describe, it, expect, beforeAll } from 'vitest';
import { Router, pickSlugClusterRepresentatives } from '../src/routing.ts';
import * as metricsModule from '../src/metrics.ts';
import type { Config, Cache } from '../src/types.ts';

const cfg = { model_groups: {}, model_metrics: {}, providers: {} } as any as Config;
const cache = { available_models: [] } as any as Cache;

beforeAll(() => {
  metricsModule.setConfig(cfg);
  metricsModule.setCache(cache);
  metricsModule.setGdpval({ 'foo-3-5': 900, bar: 800 });
  metricsModule.setModelMap(
    {
      'foo-latest': 'foo-3-5',
      'foo-2604': 'foo-3-5',
      'foo-20260412': 'foo-3-5',
      'foo-3-5': 'foo-3-5',
      'bar-latest': 'bar',
      'bar-preview': 'bar',
    },
    [],
  );
});

const router = () => new Router(cfg, cache, new Map());
const pref = (id: string, slug: string | null) => (router() as any).modelVariantPreference(id, slug) as number;

describe('modelVariantPreference — the ladder, number by number', () => {
  it('canonical (normalized id equals the slug) is 4, even spelled with dots', () => {
    expect(pref('foo-3-5', 'foo-3-5')).toBe(4);
    expect(pref('foo-3.5', 'foo-3-5')).toBe(4);
  });

  it('a rolling alias (-latest / -preview, case-insensitive, at the END) is 1', () => {
    expect(pref('foo-latest', 'bar')).toBe(1);
    expect(pref('foo-preview', 'bar')).toBe(1);
    expect(pref('foo-LATEST', 'bar')).toBe(1);
    // not at the end → not an alias marker; no digit either → unmarked
    expect(pref('foo-latest-x', 'bar')).toBe(0);
  });

  it('a dated snapshot (-YYMM, -YYMMDD, -YYYYMMDD) is 3', () => {
    expect(pref('foo-2604', 'bar')).toBe(3);
    expect(pref('foo-260412', 'bar')).toBe(3);
    expect(pref('foo-20260412', 'bar')).toBe(3);
  });

  it('digits that are not a date stay an explicit version (2): short, odd length, not at the end', () => {
    expect(pref('foo-5', 'bar')).toBe(2);
    expect(pref('foo-123', 'bar')).toBe(2);
    expect(pref('foo-12345', 'bar')).toBe(2);
    expect(pref('foo-2604-x', 'bar')).toBe(2);
  });

  it('letters after the dash are never a date', () => {
    expect(pref('foo-abcd', 'bar')).toBe(0);
    expect(pref('foo-abcdef', 'bar')).toBe(0);
    expect(pref('foo-abcdefgh', 'bar')).toBe(0);
  });

  it('a dash- or dot-introduced digit is a version (2); a bare digit or dash+letter is unmarked (0)', () => {
    expect(pref('foo-5', null)).toBe(2);
    expect(pref('foo.5', null)).toBe(2);
    expect(pref('foo5', null)).toBe(0);
    expect(pref('foo-x', null)).toBe(0);
  });

  it('an unmatched ref (no slug) cannot be canonical', () => {
    expect(pref('foo-3-5', null)).toBe(2);
  });
});

describe('isBetterModelVariant', () => {
  const better = (ref: string, than: string) => (router() as any).isBetterModelVariant(ref, than) as boolean;

  it('judges the model id, not the provider-qualified ref (canonical beats dated)', () => {
    expect(better('mistral/foo-3-5', 'mistral/foo-2604')).toBe(true);
    expect(better('mistral/foo-2604', 'mistral/foo-3-5')).toBe(false);
  });

  it('a tie is NOT better — the earlier (higher-ranked) variant keeps its place', () => {
    expect(better('mistral/bar-latest', 'mistral/bar-preview')).toBe(false);
    expect(better('mistral/bar-preview', 'mistral/bar-latest')).toBe(false);
  });
});

describe('dedupByModelIdentity — three variants of one model', () => {
  const dedup = (refs: string[]) => (router() as any).dedupByModelIdentity(refs) as string[];

  it('keeps the best variant even when it only shows up third (stale-existing bookkeeping)', () => {
    expect(dedup(['mistral/foo-latest', 'mistral/foo-2604', 'mistral/foo-3-5'])).toEqual(['mistral/foo-3-5']);
  });

  it('replaces in place when the incumbent sits at a later index', () => {
    expect(dedup(['mistral/bar-latest', 'mistral/foo-latest', 'mistral/foo-2604'])).toEqual([
      'mistral/bar-latest',
      'mistral/foo-2604',
    ]);
  });

  it('a worse later variant never displaces the incumbent', () => {
    expect(dedup(['mistral/foo-3-5', 'mistral/foo-latest'])).toEqual(['mistral/foo-3-5']);
  });

  it('the same slug under DIFFERENT providers is not a duplicate', () => {
    expect(dedup(['mistral/foo-latest', 'openrouter/foo-latest'])).toEqual(['mistral/foo-latest', 'openrouter/foo-latest']);
  });
});

describe('pickSlugClusterRepresentatives', () => {
  const never = () => false;

  it('canonical beats alias when both are available', () => {
    expect(pickSlugClusterRepresentatives(['mistral/foo-latest', 'mistral/foo-3-5'], never)).toEqual(['mistral/foo-3-5']);
  });

  it('an available alias beats a LIMITED canonical (availability outranks canonicity)', () => {
    const limited = (r: string) => r === 'mistral/foo-3-5';
    expect(pickSlugClusterRepresentatives(['mistral/foo-latest', 'mistral/foo-3-5'], limited)).toEqual(['mistral/foo-latest']);
  });

  it('an available later ref beats a limited earlier one', () => {
    const limited = (r: string) => r === 'mistral/foo-latest';
    expect(pickSlugClusterRepresentatives(['mistral/foo-latest', 'mistral/foo-2604'], limited)).toEqual(['mistral/foo-2604']);
  });
});
