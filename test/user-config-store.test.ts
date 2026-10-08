// /router config, C1 — the user-layer config store (plan 2026-10-06,
// D1/D2/D5). The store is the ONLY writer the command has: it persists a
// delta into <agentDir>/router-config.user.json and never the layered
// runtime config (final v1.6.0 review I1 hazard, see
// update-model-metrics-embedded-delta.test.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openUserConfigStore,
  readConfigLayers,
  validateExcludePattern,
} from '../src/user-config-store.ts';

const repoRoot = path.resolve(__dirname, '..');

let agentDir: string;
let userFile: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-user-cfg-'));
  userFile = path.join(agentDir, 'router-config.user.json');
});

describe('UserConfigStore.applyDelta', () => {
  it('writes the exclude delta and keeps every other key of the existing user file', () => {
    const existing = {
      log_level: 'debug',
      model_metrics: { 'x/y': { gdpval: 7 } },
      exclude: { providers: ['somewhere'], models: ['old/*'] },
    };
    fs.writeFileSync(userFile, JSON.stringify(existing));

    const res = openUserConfigStore({ agentDir }).applyDelta({ exclude: { models: ['old/*', 'new/*'] } });

    expect(res).toEqual({ ok: true, written: userFile });
    const after = JSON.parse(fs.readFileSync(userFile, 'utf-8'));
    expect(after.log_level).toBe('debug');
    expect(after.model_metrics).toEqual({ 'x/y': { gdpval: 7 } });
    expect(after.exclude.providers).toEqual(['somewhere']);
    // The delta's list REPLACES the user file's own list (single source for
    // un-exclude); the union with other layers happens at load time.
    expect(after.exclude.models).toEqual(['old/*', 'new/*']);
  });

  it('creates the user file (and the agent dir) when none exists yet', () => {
    const fresh = path.join(agentDir, 'nested', 'agent');
    const res = openUserConfigStore({ agentDir: fresh }).applyDelta({ exclude: { models: ['a/b'] } });
    expect(res.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(fresh, 'router-config.user.json'), 'utf-8'))).toEqual({
      exclude: { models: ['a/b'] },
    });
  });

  it('writes pretty (2-space) JSON and leaves no temp file behind', () => {
    openUserConfigStore({ agentDir }).applyDelta({ exclude: { models: ['a/b'] } });
    expect(fs.readFileSync(userFile, 'utf-8')).toBe(JSON.stringify({ exclude: { models: ['a/b'] } }, null, 2));
    expect(fs.readdirSync(agentDir).sort()).toEqual(['router-config.user.json']);
  });

  it('never touches the shipped router-config.json', () => {
    const shippedPath = path.join(repoRoot, 'router-config.json');
    const before = fs.readFileSync(shippedPath);
    openUserConfigStore({ agentDir }).applyDelta({ exclude: { models: ['a/b'] } });
    expect(fs.readFileSync(shippedPath).equals(before)).toBe(true);
  });

  it('refuses to write when the existing file is not parseable JSON', () => {
    fs.writeFileSync(userFile, '{ not json');
    const res = openUserConfigStore({ agentDir }).applyDelta({ exclude: { models: ['a/b'] } });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe('{ not json');
    expect(fs.existsSync(`${userFile}.bak`)).toBe(false);
  });

  it('refuses to write when the existing file is valid JSON but not an object', () => {
    fs.writeFileSync(userFile, '[1,2]');
    const res = openUserConfigStore({ agentDir }).applyDelta({ exclude: { models: ['a/b'] } });
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe('[1,2]');
  });

  it('backs up the previous file to .bak on the first write and keeps that backup afterwards', () => {
    fs.writeFileSync(userFile, JSON.stringify({ log_level: 'warn' }));
    const store = openUserConfigStore({ agentDir });
    store.applyDelta({ exclude: { models: ['a/b'] } });
    expect(JSON.parse(fs.readFileSync(`${userFile}.bak`, 'utf-8'))).toEqual({ log_level: 'warn' });

    // A second write must not replace the backup with the already-edited file.
    store.applyDelta({ exclude: { models: ['a/b', 'c/d'] } });
    expect(JSON.parse(fs.readFileSync(`${userFile}.bak`, 'utf-8'))).toEqual({ log_level: 'warn' });
  });

  it('rejects junk patterns without writing', () => {
    fs.writeFileSync(userFile, JSON.stringify({ log_level: 'warn' }));
    const res = openUserConfigStore({ agentDir }).applyDelta({ exclude: { models: ['ok/model', 'has space'] } });
    expect(res.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8'))).toEqual({ log_level: 'warn' });
  });
});

describe('UserConfigStore.read', () => {
  it('reports a missing file as no config and no error', () => {
    expect(openUserConfigStore({ agentDir }).read()).toEqual({ config: undefined });
  });

  it('returns the parsed object', () => {
    fs.writeFileSync(userFile, JSON.stringify({ log_level: 'warn' }));
    expect(openUserConfigStore({ agentDir }).read()).toEqual({ config: { log_level: 'warn' } });
  });

  it('surfaces an error for a corrupt file', () => {
    fs.writeFileSync(userFile, '{ nope');
    const r = openUserConfigStore({ agentDir }).read();
    expect(r.config).toBeUndefined();
    expect(r.error).toMatch(/router-config\.user\.json/);
  });

  it('defaults to piAgentDir() (PI_CODING_AGENT_DIR-aware)', () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      fs.writeFileSync(userFile, JSON.stringify({ log_level: 'error' }));
      expect(openUserConfigStore().read().config).toEqual({ log_level: 'error' });
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });
});

describe('UserConfigStore.applyDelta — exclude.providers', () => {
  it('persists provider names next to models without touching other keys', () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-store-prov-'));
    fs.writeFileSync(path.join(agentDir, 'router-config.user.json'), JSON.stringify({ log_level: 'debug', exclude: { models: ['m/*'] } }));
    const res = openUserConfigStore({ agentDir }).applyDelta({ exclude: { providers: ['openrouter'] } });
    expect(res.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(agentDir, 'router-config.user.json'), 'utf-8'));
    expect(after).toEqual({ log_level: 'debug', exclude: { models: ['m/*'], providers: ['openrouter'] } });
  });

  it.each(['', 'has space', 'a/b', '/x', 'semi;colon'])('rejects the provider name %j without writing', (name) => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-store-prov-'));
    const res = openUserConfigStore({ agentDir }).applyDelta({ exclude: { providers: [name] } });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(agentDir, 'router-config.user.json'))).toBe(false);
  });
});

describe('validateExcludePattern', () => {
  it.each(['openrouter', 'openrouter/*', 'mistral/model-1.2', 'openrouter/vendor/model:free', '*opus*', 'a/b*c'])(
    'accepts %s',
    (p) => expect(validateExcludePattern(p)).toBeUndefined()
  );

  it.each(['', ' ', 'has space', '/leading', 'a//b', 'a/b/', 'semi;colon', 'quote"d', 'a\nb'])(
    'rejects %j',
    (p) => expect(validateExcludePattern(p)).toEqual(expect.any(String))
  );
});

describe('readConfigLayers (origin view)', () => {
  it('reads the three layer files directly and labels each with its origin', () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ext-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cwd-'));
    fs.mkdirSync(path.join(cwd, '.pi'));
    fs.writeFileSync(path.join(extDir, 'router-config.json'), JSON.stringify({ exclude: { models: ['shipped/*'] } }));
    fs.writeFileSync(userFile, JSON.stringify({ exclude: { models: ['user/*'], providers: ['up'] } }));
    fs.writeFileSync(path.join(cwd, '.pi', 'router-config.json'), JSON.stringify({ exclude: { paid_models_from: ['pp'] } }));

    const layers = readConfigLayers({ extDir, cwd, agentDir });

    expect(layers.map((l) => l.origin)).toEqual(['shipped', 'user', 'project']);
    expect(layers[0]).toMatchObject({ path: path.join(extDir, 'router-config.json'), present: true });
    expect(layers[0].exclude.models).toEqual(['shipped/*']);
    expect(layers[1]).toMatchObject({ path: userFile, present: true });
    expect(layers[1].exclude).toMatchObject({ models: ['user/*'], providers: ['up'] });
    expect(layers[2]).toMatchObject({ path: path.join(cwd, '.pi', 'router-config.json'), present: true });
    expect(layers[2].exclude.paid_models_from).toEqual(['pp']);
  });

  it('marks absent layers as not present (empty rules) and tolerates a corrupt one', () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-ext-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cwd-'));
    fs.writeFileSync(path.join(extDir, 'router-config.json'), '{}');
    fs.writeFileSync(userFile, '{ corrupt');

    const layers = readConfigLayers({ extDir, cwd, agentDir });

    expect(layers.find((l) => l.origin === 'project')).toMatchObject({ present: false, exclude: {} });
    expect(layers.find((l) => l.origin === 'user')).toMatchObject({ present: true, exclude: {}, error: expect.any(String) });
  });
});
