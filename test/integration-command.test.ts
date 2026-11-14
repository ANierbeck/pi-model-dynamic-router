// /router config integration <name> on|off|<mode> (plan
// 2026-11-08-optional-integrations-config.md, open step). Driven through the
// real /router handler; the harness is shared with the other /router config
// tests (test/helpers/config-command-harness.ts).

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCommands } from '../src/commands.ts';
import { useConfigCommandHarness } from './helpers/config-command-harness.ts';

const harness = useConfigCommandHarness('integ-cmd');
const { setup } = harness;
const readUser = (): Record<string, any> => harness.readUser();

let cwd: string;
let userFile: string;

const INTEGRATION_SHIPPED = {
  model_groups: {
    trivial: { description: 'Trivial', method: 'roundrobin', fallback_groups: [] },
  },
  providers: {},
  model_metrics: {},
  gdpval_builtin: {},
  integrations: { laya: { enabled: false } },
};

beforeEach(() => {
  ({ cwd, userFile } = harness.paths);
  harness.writeShipped(INTEGRATION_SHIPPED);
});

describe('/router config integration', () => {
  it('lists the known integrations and the usage when given no name', async () => {
    const out = await setup().run('config integration');
    expect(out).toContain('laya: off');
    expect(out).toMatch(/config integration <name> on\|off\|<mode>/);
  });

  it('"laya on" keeps every other key the user layer already has for Laya', async () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        log_level: 'debug',
        integrations: {
          laya: { enabled: false, checkpoint: 'r2@1.0.0', endpoint: 'http://127.0.0.1:8089' },
        },
      })
    );
    const { rt, run } = setup();
    await run('config integration laya on');
    expect(readUser()).toEqual({
      log_level: 'debug',
      integrations: {
        laya: { enabled: true, checkpoint: 'r2@1.0.0', endpoint: 'http://127.0.0.1:8089' },
      },
    });
    expect(rt.cfg.integrations.laya.enabled).toBe(true); // live, no restart
  });

  it('"laya off" switches it off in the user layer and live', async () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({ integrations: { laya: { enabled: true, checkpoint: 'r2@1.0.0' } } })
    );
    const { rt, run } = setup();
    const out = await run('config integration laya off');
    expect(readUser().integrations.laya.enabled).toBe(false);
    expect(rt.cfg.integrations.laya.enabled).toBe(false);
    expect(out).toMatch(/off/);
  });

  it('a mode implies on: "laya shadow" sets the mode and enables the stage', async () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({ integrations: { laya: { checkpoint: 'r2@1.0.0' } } })
    );
    const { rt, run } = setup();
    await run('config integration laya shadow');
    expect(readUser().integrations.laya).toEqual({
      checkpoint: 'r2@1.0.0',
      enabled: true,
      mode: 'shadow',
    });
    expect(rt.cfg.integrations.laya).toMatchObject({ enabled: true, mode: 'shadow' });
  });

  it('"laya active" sets the mode the spec allows', async () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({ integrations: { laya: { checkpoint: 'r2@1.0.0' } } })
    );
    const { rt, run } = setup();
    await run('config integration laya active');
    expect(rt.cfg.integrations.laya.mode).toBe('active');
  });

  it('says so when "on" does not take effect, because the block is still invalid (no checkpoint)', async () => {
    const { rt, run } = setup();
    const out = await run('config integration laya on');
    expect(readUser().integrations.laya.enabled).toBe(true);
    expect(rt.cfg.integrations.laya.enabled).toBe(false); // the validator disables it, with a warning
    expect(out).toMatch(/still off/i);
    expect(out).toMatch(/log/i); // points to the reason
  });

  it('refuses an unknown integration name, lists the known ones, writes nothing', async () => {
    const out = await setup().run('config integration codexbar on');
    expect(out).toMatch(/not a known integration/i);
    expect(out).toContain('laya');
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('does not treat an inherited Object property as an integration', async () => {
    const out = await setup().run('config integration constructor on');
    expect(out).toMatch(/not a known integration/i);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('refuses a mode the integration does not have, writes nothing', async () => {
    const out = await setup().run('config integration laya yolo');
    expect(out).toContain('yolo');
    expect(out).toMatch(/active|shadow/);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('refuses a corrupt user file instead of overwriting it', async () => {
    fs.writeFileSync(userFile, '{ not json');
    const out = await setup().run('config integration laya on');
    expect(out).toMatch(/Not written/);
    expect(fs.readFileSync(userFile, 'utf-8')).toBe('{ not json');
  });

  it('answers a bare "config integration laya" with the usage, not a write', async () => {
    const out = await setup().run('config integration laya');
    expect(out).toMatch(/on\|off\|<mode>/);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('offers the subcommand in autocompletion', () => {
    const { rt } = setup();
    let completions: any;
    rt.pi.registerCommand = (_n: string, def: any) => {
      completions = def.getArgumentCompletions;
    };
    createCommands(rt);
    expect(completions('config int').map((c: any) => c.value)).toContain('config integration');
  });
});

describe('/router config integration — refusals and overrides', () => {
  it('refuses extra arguments instead of acting on the first two', async () => {
    const out = await setup().run('config integration laya on now');
    expect(out).toMatch(/Not written/);
    expect(fs.existsSync(userFile)).toBe(false);
  });

  it('reports a project-layer setting that overrides the request instead of a success', async () => {
    fs.writeFileSync(
      userFile,
      JSON.stringify({ integrations: { laya: { checkpoint: 'r2@1.0.0' } } })
    );
    fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.pi', 'router-config.json'),
      JSON.stringify({ integrations: { laya: { enabled: false } } })
    );
    const out = await setup().run('config integration laya on');
    expect(out).not.toMatch(/applies now/);
    expect(out).toMatch(/project/);
  });

  it('refuses a user file whose integrations value is not an object, and keeps it', async () => {
    fs.writeFileSync(userFile, JSON.stringify({ integrations: 'oops' }));
    const out = await setup().run('config integration laya on');
    expect(out).toMatch(/Not written/);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf-8'))).toEqual({ integrations: 'oops' });
  });
});
