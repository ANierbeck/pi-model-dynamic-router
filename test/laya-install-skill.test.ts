// test/laya-install-skill.test.ts
//
// The router-laya-install skill (plan 2026-11-08-laya-model-artifact.md, step 7)
// is instructions, not code, so these pins check that its instructions agree
// with the code they drive: every pi-laya-model command, flag and error code it
// names exists, the config snippet it tells the user to write loads as an
// enabled shadow-mode Laya stage, and it never copies --allow-unpublished into
// an install command.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadLayeredConfig } from '../src/config-loader.ts';
import { main, type CliIo } from '../src/laya-model-install.ts';
import { rmTmpDir } from './helpers/router-env.ts';

const repoRoot = path.resolve(__dirname, '..');
const SKILL_PATH = path.join(repoRoot, 'skills', 'router-laya-install', 'SKILL.md');
const skill = fs.existsSync(SKILL_PATH) ? fs.readFileSync(SKILL_PATH, 'utf8') : '';

/** The CLI's own usage text, from the same entry point a user would hit with no command. */
async function cliUsage(): Promise<string> {
  let err = '';
  const io: CliIo = { out: () => {}, err: (s) => (err += s) };
  await main([], io);
  return err;
}

describe('router-laya-install SKILL.md', () => {
  it('exists, names itself like its directory, and says when to use it', () => {
    expect(fs.existsSync(SKILL_PATH)).toBe(true);
    expect(skill).toMatch(/^name: router-laya-install$/m);
    expect(skill).toMatch(/^description: .*(install|set up).*Laya/im);
  });

  it('names only pi-laya-model commands the CLI has', async () => {
    const usage = await cliUsage();
    const known = new Set(
      [...usage.matchAll(/^\s{2}(install|verify|list|remove|models)\b/gm)].map((m) => m[1])
    );
    const named = new Set([...skill.matchAll(/pi-laya-model\s+([a-z]+)/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThan(0);
    for (const cmd of named) expect(known.has(cmd), `command ${cmd}`).toBe(true);
  });

  it('names only flags the CLI accepts', async () => {
    const usage = await cliUsage();
    const flags = new Set([...usage.matchAll(/(--[a-z-]+)/g)].map((m) => m[1]!));
    // Only lines that drive pi-laya-model: the sidecar's own flags (--port, …) are not the installer's.
    const cliLines = skill.split('\n').filter((l) => l.includes('pi-laya-model'));
    const named = new Set(
      cliLines.flatMap((l) => [...l.matchAll(/(--[a-z][a-z-]*)/g)].map((m) => m[1]!))
    );
    expect(named.size).toBeGreaterThan(0);
    for (const f of named) expect(flags.has(f), `flag ${f}`).toBe(true);
  });

  it('names only error codes the installer can raise', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src', 'laya-model-install.ts'), 'utf8');
    const union = src.match(/export type InstallErrorCode =([\s\S]*?);/)![1]!;
    const codes = new Set([...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!));
    const section = skill.slice(skill.indexOf('## Error codes'));
    const named = [...section.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
    expect(named.length).toBeGreaterThanOrEqual(6);
    for (const c of named) expect(codes.has(c), `code ${c}`).toBe(true);
  });

  it('never puts --allow-unpublished into an install command a user would copy', () => {
    const installLines = skill.split('\n').filter((l) => /pi-laya-model\s+install/.test(l));
    expect(installLines.length).toBeGreaterThan(0);
    for (const line of installLines) expect(line).not.toContain('--allow-unpublished');
  });

  it('does not start a sidecar itself and names no router-side start command', () => {
    // The skill hands the sidecar over to the user; the router never starts one.
    expect(skill).toMatch(/The skill does not start a sidecar/);
    expect(skill).not.toMatch(/pi-laya-model\s+serve|pi-laya-model\s+start/);
  });

  it('offers the ONNX backend only: MLX is not an installer target', () => {
    expect(skill).not.toMatch(/mlx/i);
  });

  it('no longer says the sidecar is not packaged (plan step 9)', () => {
    expect(skill).not.toMatch(/not packaged yet|not yet packaged/i);
  });

  it('says the sidecar ships with release 2.0.0 and is not published before it', () => {
    expect(skill).toMatch(/@anierbeck\/laya-sidecar/);
    expect(skill).toMatch(/2\.0\.0/);
    expect(skill).toMatch(/not published/i);
  });

  it('gives the ONNX install with the CUDA skip flag and the start command with the head', () => {
    expect(skill).toMatch(/ONNXRUNTIME_NODE_INSTALL=skip npm install -g @anierbeck\/laya-sidecar/);
    expect(skill).toMatch(/laya-sidecar\s+--model-dir\s+\S+\s+--head-json\s+\S+head\.json/);
  });

  it('refuses Intel Macs and marks the non-Apple platforms as untested (D5, D6)', () => {
    expect(skill).toMatch(/Intel[^\n]*not supported/i);
    expect(skill).toMatch(/Linux[^\n]*not tested|not tested[^\n]*Linux/i);
    expect(skill).toMatch(/Windows[^\n]*not tested|not tested[^\n]*Windows/i);
  });
});

describe('the config snippet the skill writes', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-skill-'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmTmpDir(tmp);
  });

  function snippet(): Record<string, unknown> {
    const m = skill.match(/<!-- laya-config-snippet -->\s*```json\n([\s\S]*?)```/);
    expect(m, 'the skill marks its config snippet').not.toBeNull();
    return JSON.parse(m![1]!) as Record<string, unknown>;
  }

  it('loads as an enabled shadow-mode Laya stage on the installed model label', () => {
    const agentDir = path.join(tmp, 'agent');
    const cwd = path.join(tmp, 'project');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'router-config.user.json'), JSON.stringify(snippet()));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    const { config } = loadLayeredConfig(repoRoot, cwd);
    expect(config.integrations?.laya).toMatchObject({
      enabled: true,
      mode: 'shadow',
      checkpoint: 'router@1.0.0',
      endpoint: 'http://127.0.0.1:8089',
    });
  });

  it('writes shadow mode: the first run only observes, the owner switches to active later', () => {
    expect(snippet()).toMatchObject({ integrations: { laya: { mode: 'shadow' } } });
  });
});
