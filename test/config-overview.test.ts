// /router config overview and block views (config plan 2026-11-14, Phase 3):
// the overview shows the classifier chain and one line per integration; a block
// view shows every table key of the block with the value in effect, the shipped
// default and the way to change it. Driven through the real /router handler on
// the shared harness.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCommands } from '../src/commands.ts';
import { CONFIG_KEYS } from '../src/config-keys.ts';
import { useConfigCommandHarness } from './helpers/config-command-harness.ts';

const harness = useConfigCommandHarness('config-overview');
const { setup } = harness;

// The shipped layer is the real router-config.json: the chain and the defaults
// the tests assert on are the ones a user actually gets.
const SHIPPED = new URL('../router-config.json', import.meta.url);

beforeEach(() => {
  fs.mkdirSync(path.join(harness.paths.cwd, '.pi'), { recursive: true });
  harness.writeShipped(JSON.parse(fs.readFileSync(SHIPPED, 'utf-8')));
});

describe('/router config — overview', () => {
  it('shows the classifier chain the config produces, one line per leg', async () => {
    const out = await setup().run('config');
    expect(out).toMatch(/Classifier chain:/);
    expect(out).toMatch(/Laya: off/);
    expect(out).toMatch(/Local \(Ollama\): on/);
    expect(out).toMatch(/Cloud: on/);
    expect(out).toMatch(/Static rules: off/);
  });

  it('shows one summary line per integration, with the command that switches it', async () => {
    const out = await setup().run('config');
    expect(out).toContain('laya: off — switch on: /router config integration laya on');
  });

  it('names the block views it offers', async () => {
    const out = await setup().run('config');
    expect(out).toMatch(/config classifier/);
    expect(out).toMatch(/config integrations/);
  });
});

describe('/router config <block> — block views', () => {
  it('lists every table key of the classifier block, with the value in effect and the shipped default', async () => {
    const out = await setup().run('config classifier');
    for (const key of CONFIG_KEYS.filter((k) => k.path.startsWith('classifier.'))) {
      expect(out).toContain(key.path);
    }
    expect(out).toMatch(/classifier\.cloud\.enabled\s+on\b/);
    expect(out).toMatch(/shipped: true/);
  });

  it('says how each key is changed: a set command, an alias, or a hand edit', async () => {
    const out = await setup().run('config classifier');
    expect(out).toMatch(/classifier\.cloud\.enabled[^\n]*\/router config set/);
    expect(out).toMatch(/classifier\.log\.store_text[^\n]*hand-edit/);
  });

  it('ends with the chain, as the classifier block is what the chain is made of', async () => {
    const out = await setup().run('config classifier');
    expect(out).toMatch(/Chain:/);
    expect(out).toMatch(/Laya: off/);
  });

  it('shows the integrations block with the Laya keys and the switch command', async () => {
    const out = await setup().run('config integrations');
    expect(out).toContain('integrations.laya.enabled');
    expect(out).toMatch(/integrations\.laya\.enabled[^\n]*config integration laya on\|off/);
    expect(out).toContain('integrations.laya.checkpoint');
  });

  it('reads a block view even when the user layer does not exist yet', async () => {
    const out = await setup().run('config classifier');
    expect(out).not.toMatch(/Unknown config subcommand/);
    expect(fs.existsSync(harness.paths.userFile)).toBe(false);
  });
});

describe('/router config — unknown words and autocompletion', () => {
  it('answers an unknown word with the usage, which names the block views', async () => {
    const out = await setup().run('config nosuch');
    expect(out).toMatch(/Unknown config subcommand: nosuch/);
    expect(out).toMatch(/config classifier/);
    expect(out).toMatch(/config set <path> <value>/);
  });

  it('every completion under "config" is a subcommand the handler answers', async () => {
    const { rt, run } = setup();
    let complete!: (prefix: string) => Array<{ value: string }>;
    rt.pi.registerCommand = (_name: string, def: any) => {
      complete = def.getArgumentCompletions;
    };
    createCommands(rt);
    const values = complete('config ').map((c) => c.value);
    expect(values).toEqual(expect.arrayContaining(['config set', 'config classifier']));
    for (const value of values) {
      const out = await run(value);
      expect(out, value).not.toMatch(/Unknown config subcommand/);
    }
  });
});
