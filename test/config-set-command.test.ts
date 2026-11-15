// /router config set <path> <value> and /router config unset <path> (config
// plan 2026-11-14, Phase 2): validated against the description table, refused
// with a reason when the table does not allow the write, and the reply states
// what is in effect afterwards. Driven through the real /router handler.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useConfigCommandHarness } from './helpers/config-command-harness.ts';

const harness = useConfigCommandHarness('config-set');
const { setup, readUser } = harness;

beforeEach(() => {
  fs.mkdirSync(path.join(harness.paths.cwd, '.pi'), { recursive: true });
});

const userFile = (): string => harness.paths.userFile;
const projectFile = (): string => path.join(harness.paths.cwd, '.pi', 'router-config.json');

describe('/router config set — writes through the table', () => {
  it('sets a boolean switch and says what is in effect', async () => {
    const out = await setup().run('config set classifier.cloud.enabled off');
    expect(readUser()).toEqual({ classifier: { cloud: { enabled: false } } });
    expect(out).toMatch(/classifier\.cloud\.enabled is off — saved to .*router-config\.user\.json/);
  });

  it('keeps the other user settings when it writes one key', async () => {
    fs.writeFileSync(
      userFile(),
      JSON.stringify({ log_level: 'debug', classifier: { local: { fallback: 'ollama/b:1b' } } })
    );
    await setup().run('config set classifier.cloud.enabled on');
    expect(readUser()).toEqual({
      log_level: 'debug',
      classifier: { local: { fallback: 'ollama/b:1b' }, cloud: { enabled: true } },
    });
  });

  it('accepts a local model in the ollama/<name> form and refuses any other form', async () => {
    const ok = await setup().run('config set classifier.local.model ollama/judge:1b');
    expect(ok).toMatch(/classifier\.local\.model is ollama\/judge:1b/);
    expect(readUser()).toEqual({ classifier: { local: { model: 'ollama/judge:1b' } } });
    const bad = await setup().run('config set classifier.local.model judge');
    expect(bad).toMatch(/Not written/);
    expect(readUser()).toEqual({ classifier: { local: { model: 'ollama/judge:1b' } } });
  });

  it('accepts a pi ref whose id holds a slash, and a namespaced ollama name', async () => {
    const cloud = await setup({ knownModels: ['openrouter/openrouter/free'] }).run(
      'config set classifier.cloud.model openrouter/openrouter/free'
    );
    expect(cloud).toMatch(/classifier\.cloud\.model is openrouter\/openrouter\/free/);
    expect(readUser()).toEqual({ classifier: { cloud: { model: 'openrouter/openrouter/free' } } });

    const local = await setup().run(
      'config set classifier.local.model ollama/hf.co/user/model:tag'
    );
    expect(local).toMatch(/classifier\.local\.model is ollama\/hf\.co\/user\/model:tag/);
    expect(readUser().classifier.local).toEqual({ model: 'ollama/hf.co/user/model:tag' });
  });

  it('writes a candidate list only when pi knows every model in it', async () => {
    const refused = await setup({ knownModels: ['acme/a'] }).run(
      'config set classifier.cloud.candidates acme/a,acme/gone'
    );
    expect(refused).toMatch(/Not written: pi does not know the model "acme\/gone"/);
    expect(fs.existsSync(userFile())).toBe(false);

    const written = await setup({ knownModels: ['acme/a', 'acme/b'] }).run(
      'config set classifier.cloud.candidates acme/a,acme/b'
    );
    expect(readUser()).toEqual({
      classifier: { cloud: { candidates: ['acme/a', 'acme/b'] } },
    });
    expect(written).toMatch(/classifier\.cloud\.candidates is acme\/a, acme\/b/);
  });

  it('refuses a cloud model pi does not know, and one that is not provider/id', async () => {
    const unknown = await setup({ knownModels: [] }).run(
      'config set classifier.cloud.model acme/ghost'
    );
    expect(unknown).toMatch(/pi does not know the model "acme\/ghost"/);
    const shape = await setup({ knownModels: [] }).run('config set classifier.cloud.model ghost');
    expect(shape).toMatch(/Not written: .*provider\/id/);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('refuses a misspelt key and suggests the table key it most likely means', async () => {
    const out = await setup().run('config set classifier.cloud.enable off');
    expect(out).toMatch(/Not written/);
    expect(out).toMatch(/did you mean "classifier\.cloud\.enabled"/);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('refuses a value the key does not allow, and lists the allowed words', async () => {
    const out = await setup().run('config set classifier.cloud.enabled maybe');
    expect(out).toMatch(/Not written: .*on or off/);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('points an integration key at its alias and writes nothing', async () => {
    const out = await setup().run('config set integrations.laya.enabled on');
    expect(out).toMatch(/config integration laya on\|off/);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('says a hand-edited key is file-only and writes nothing', async () => {
    const out = await setup().run('config set classifier.log.store_text full');
    expect(out).toMatch(/hand-edit/);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it('refuses a missing value', async () => {
    const out = await setup().run('config set classifier.cloud.enabled');
    expect(out).toMatch(/Usage: \/router config set/);
    expect(fs.existsSync(userFile())).toBe(false);
  });
});

describe('/router config unset', () => {
  it('removes the key from the user layer', async () => {
    fs.writeFileSync(userFile(), JSON.stringify({ classifier: { cloud: { model: 'acme/c' } } }));
    const out = await setup().run('config unset classifier.cloud.model');
    expect(readUser()).toEqual({});
    expect(out).toMatch(/classifier\.cloud\.model is unset/);
  });

  it('names the project layer when its pre-2.0 key still sets the removed value', async () => {
    fs.writeFileSync(userFile(), JSON.stringify({ classifier: { cloud: { model: 'acme/c' } } }));
    fs.writeFileSync(
      projectFile(),
      JSON.stringify({ model_groups: { dynamic: { classifier_cloud_model: 'acme/p' } } })
    );
    const out = await setup().run('config unset classifier.cloud.model');
    expect(readUser()).toEqual({});
    expect(out).toMatch(/classifier\.cloud\.model is still acme\/p/);
    expect(out).toContain(projectFile());
  });
});

describe('/router config set — the reply states what is in effect', () => {
  it('names the project layer when it overrides the value just written', async () => {
    fs.writeFileSync(projectFile(), JSON.stringify({ classifier: { cloud: { enabled: false } } }));
    const out = await setup().run('config set classifier.cloud.enabled on');
    expect(readUser()).toEqual({ classifier: { cloud: { enabled: true } } });
    expect(out).toMatch(/still off/);
    expect(out).toMatch(/router-config\.json/);
  });

  it('does not claim an override when the project layer holds the same list', async () => {
    fs.writeFileSync(
      projectFile(),
      JSON.stringify({ classifier: { cloud: { candidates: ['acme/a', 'acme/b'] } } })
    );
    const out = await setup({ knownModels: ['acme/a', 'acme/b'] }).run(
      'config set classifier.cloud.candidates acme/a,acme/b'
    );
    expect(out).not.toMatch(/overrides/);
    expect(out).toMatch(/classifier\.cloud\.candidates is acme\/a, acme\/b — saved to/);
  });

  it('names the project layer when it overrides through a pre-2.0 key', async () => {
    fs.writeFileSync(
      projectFile(),
      JSON.stringify({ model_groups: { dynamic: { classifier_cloud_chain: false } } })
    );
    const out = await setup().run('config set classifier.cloud.enabled on');
    expect(readUser()).toEqual({ classifier: { cloud: { enabled: true } } });
    expect(out).toMatch(/classifier\.cloud\.enabled is still off/);
    expect(out).toContain(projectFile());
  });

  it('ends with the classifier chain the new config produces', async () => {
    const out = await setup().run('config set classifier.cloud.enabled off');
    expect(out).toMatch(/Chain:/);
    expect(out).toMatch(/Laya[^\n]*off/);
    expect(out).toMatch(/Cloud[^\n]*off/);
  });

  it('refuses a corrupt user file instead of overwriting it', async () => {
    fs.writeFileSync(userFile(), '{ not json');
    const out = await setup().run('config set classifier.cloud.enabled off');
    expect(out).toMatch(/Not written/);
    expect(fs.readFileSync(userFile(), 'utf-8')).toBe('{ not json');
  });
});
