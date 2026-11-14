// /router config — guided menu (config plan 2026-11-14, Phase 4). In TUI mode a
// bare `/router config` opens the menu; print and RPC mode never open a dialog
// and say why. The menu offers only table keys marked `wizard`, validates every
// answer with the same code as `/router config set`, and writes only the user
// layer. Driven through the real /router handler on the shared harness, with
// the dialogs scripted.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useConfigCommandHarness } from './helpers/config-command-harness.ts';

const harness = useConfigCommandHarness('config-wizard');
const { setup } = harness;

const SHIPPED = new URL('../router-config.json', import.meta.url);

beforeEach(() => {
  fs.mkdirSync(path.join(harness.paths.cwd, '.pi'), { recursive: true });
  harness.writeShipped(JSON.parse(fs.readFileSync(SHIPPED, 'utf-8')));
});

const userFileExists = (): boolean => fs.existsSync(harness.paths.userFile);
const readUser = (): Record<string, any> => harness.readUser();

/** The menu option that starts with the given key path. */
const optionFor = (options: string[], keyPath: string): string => {
  const found = options.find((o) => o.startsWith(keyPath));
  if (!found) throw new Error(`no menu option for ${keyPath}`);
  return found;
};

describe('/router config — the guided menu in TUI mode', () => {
  it('opens a select with the wizard keys, and not the overview', async () => {
    const { run, ui } = setup({ mode: 'tui' });
    const out = await run('config');
    expect(ui.select).toHaveBeenCalledTimes(1);
    const options = ui.select.mock.calls[0][1] as string[];
    for (const key of [
      'classifier.cloud.enabled',
      'classifier.cloud.candidates',
      'integrations.laya.enabled',
      'integrations.laya.mode',
    ]) {
      expect(
        options.some((o) => o.startsWith(key)),
        key
      ).toBe(true);
    }
    expect(options.some((o) => o.startsWith('classifier.log.store_text'))).toBe(false);
    expect(out).not.toMatch(/Classifier chain:/);
  });

  it('a cancelled menu writes nothing and asks nothing more', async () => {
    const { run, ui } = setup({ mode: 'tui' });
    await run('config');
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
    expect(userFileExists()).toBe(false);
  });

  it('lists the hand-edited keys with their meaning, and writes nothing', async () => {
    const { run, ui } = setup({ mode: 'tui' });
    ui.select
      .mockResolvedValueOnce('Hand-edited keys (file only)')
      .mockResolvedValueOnce(undefined);
    const out = await run('config');
    expect(out).toContain('classifier.log.store_text');
    expect(out).toMatch(/How much prompt text/);
    expect(userFileExists()).toBe(false);
  });

  it('a switch asks for confirmation, and writes the opposite value on yes', async () => {
    const { run, ui } = setup({ mode: 'tui', confirm: async () => true });
    ui.select
      .mockImplementationOnce(async (_t: string, opts: string[]) =>
        optionFor(opts, 'classifier.cloud.enabled')
      )
      .mockResolvedValueOnce(undefined);
    const out = await run('config');
    expect(ui.confirm.mock.calls[0][1]).toMatch(/to off/);
    expect(readUser()).toEqual({ classifier: { cloud: { enabled: false } } });
    expect(out).toMatch(/classifier\.cloud\.enabled is off/);
  });

  it('a switch answered no writes nothing', async () => {
    const { run, ui } = setup({ mode: 'tui', confirm: async () => false });
    ui.select
      .mockImplementationOnce(async (_t: string, opts: string[]) =>
        optionFor(opts, 'classifier.cloud.enabled')
      )
      .mockResolvedValueOnce(undefined);
    await run('config');
    expect(userFileExists()).toBe(false);
  });

  it('an enumeration offers its values and writes the choice', async () => {
    const { run, ui } = setup({ mode: 'tui' });
    ui.select
      .mockImplementationOnce(async (_t: string, opts: string[]) =>
        optionFor(opts, 'integrations.laya.mode')
      )
      .mockImplementationOnce(async (_t: string, values: string[]) => {
        expect(values).toEqual(['active', 'shadow']);
        return 'active';
      })
      .mockResolvedValueOnce(undefined);
    await run('config');
    expect(readUser().integrations.laya.mode).toBe('active');
  });

  it('a candidate list pi does not know is refused, and nothing is written', async () => {
    const { run, ui } = setup({ mode: 'tui', knownModels: [] });
    ui.select
      .mockImplementationOnce(async (_t: string, opts: string[]) =>
        optionFor(opts, 'classifier.cloud.candidates')
      )
      .mockResolvedValueOnce(undefined);
    ui.input.mockResolvedValueOnce('acme/gone');
    const out = await run('config');
    expect(out).toMatch(/pi does not know the model "acme\/gone"/);
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining('Not written'), 'warning');
    expect(userFileExists()).toBe(false);
  });

  it('a candidate list pi knows is written, validated like /router config set', async () => {
    const { run, ui } = setup({ mode: 'tui', knownModels: ['acme/a', 'acme/b'] });
    ui.select
      .mockImplementationOnce(async (_t: string, opts: string[]) =>
        optionFor(opts, 'classifier.cloud.candidates')
      )
      .mockResolvedValueOnce(undefined);
    ui.input.mockResolvedValueOnce('acme/a, acme/b');
    await run('config');
    expect(readUser()).toEqual({ classifier: { cloud: { candidates: ['acme/a', 'acme/b'] } } });
  });

  it('an empty answer to a text question changes nothing', async () => {
    const { run, ui } = setup({ mode: 'tui', knownModels: ['acme/a'] });
    ui.select
      .mockImplementationOnce(async (_t: string, opts: string[]) =>
        optionFor(opts, 'classifier.cloud.candidates')
      )
      .mockResolvedValueOnce(undefined);
    ui.input.mockResolvedValueOnce('');
    await run('config');
    expect(userFileExists()).toBe(false);
  });
});

describe('/router config — outside the terminal', () => {
  it.each(['print', 'rpc'] as const)(
    'in %s mode the bare command prints the overview and says why, and opens no dialog',
    async (mode) => {
      const { run, ui } = setup({ mode });
      const out = await run('config');
      expect(ui.select).not.toHaveBeenCalled();
      expect(ui.confirm).not.toHaveBeenCalled();
      expect(ui.input).not.toHaveBeenCalled();
      expect(out).toContain('Classifier chain:');
      expect(out).toMatch(/needs the terminal/);
      expect(out).toMatch(/config set <path> <value>/);
    }
  );

  it('show prints the overview in every mode, without the note', async () => {
    const { run, ui } = setup({ mode: 'tui' });
    const out = await run('config show');
    expect(ui.select).not.toHaveBeenCalled();
    expect(out).toContain('Classifier chain:');
    expect(out).not.toMatch(/needs the terminal/);
  });
});
