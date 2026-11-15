// Config plan 2026-11-14, item 15 (owner decision 2026-11-15): when Laya is
// switched on but no weights are installed under the default models root, the
// reply points at the installer. The menu itself never downloads anything.

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useConfigCommandHarness } from './helpers/config-command-harness.ts';

const harness = useConfigCommandHarness('integration-hint');
const { setup } = harness;

beforeEach(() => {
  harness.writeShipped({
    model_groups: { dynamic: { method: 'dynamic' } },
    integrations: { laya: { enabled: false, checkpoint: 'router@1.0.0', mode: 'shadow' } },
  });
});

/** Creates a fake install record under <agentDir>/laya-models/<model>/<version>/. */
function installWeights(model = 'router', version = '1.0.0'): void {
  const dir = path.join(harness.paths.agentDir, 'laya-models', model, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      schema_version: 1,
      model,
      version,
      backend: 'onnx',
      files: [],
      head_file: { path: 'head.json', format: 'head-json' },
    })
  );
}

describe('config integration laya on — the installer hint when no weights are installed', () => {
  it('points at pi-laya-model and the install skill when the models root has no install', async () => {
    const { run } = setup();
    const out = await run('config integration laya on');
    expect(out).toMatch(/laya is on/);
    expect(out).toContain('pi-laya-model');
    expect(out).toContain('router-laya-install');
  });

  it('does not point at the installer when an install record exists', async () => {
    installWeights();
    const { run } = setup();
    const out = await run('config integration laya on');
    expect(out).toMatch(/laya is on/);
    expect(out).not.toContain('pi-laya-model');
  });

  it('does not point at the installer when laya is switched off', async () => {
    const { run } = setup();
    const out = await run('config integration laya off');
    expect(out).not.toContain('pi-laya-model');
  });
});
