// Shared harness for the config-loader tests: a temp extension dir with the
// shipped router-config.json, and a temp project dir that receives one
// `.pi/router-config.json` layer per load. `loadWithGlobalLayer` writes the
// user layer into a temp PI_CODING_AGENT_DIR instead. The warnings are read
// from the mocked logger, so each test file must mock '../src/logger.ts'
// (warnLog).

import { beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadLayeredConfig } from '../../src/config-loader.ts';
import * as loggerModule from '../../src/logger.ts';
import { rmTmpDir } from './router-env.ts';

export const SHIPPED_CONFIG = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  'router-config.json'
);

/** Registers the per-test temp dirs; returns the loader and the warning reader. */
export function useConfigLayers(tag: string): {
  /**
   * Temp dirs of the current test: `ext` holds the shipped copy, `cwd` the
   * project, `agent` the user layer's PI_CODING_AGENT_DIR.
   */
  paths: { tmp: string; ext: string; cwd: string; agent: string };
  loadWithProjectLayer: (layer: unknown) => ReturnType<typeof loadLayeredConfig>;
  loadWithGlobalLayer: (layer: unknown) => ReturnType<typeof loadLayeredConfig>;
  loadShipped: () => ReturnType<typeof loadLayeredConfig>;
  warnings: () => string[];
} {
  const dirs = { tmp: '', ext: '', cwd: '', agent: '' };
  let agentDirStubbed = false;

  beforeEach(() => {
    vi.clearAllMocks();
    dirs.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `router-${tag}-`));
    dirs.ext = path.join(dirs.tmp, 'ext');
    dirs.cwd = path.join(dirs.tmp, 'project');
    dirs.agent = path.join(dirs.tmp, 'agent');
    fs.mkdirSync(dirs.ext, { recursive: true });
    fs.mkdirSync(dirs.cwd, { recursive: true });
    fs.copyFileSync(SHIPPED_CONFIG, path.join(dirs.ext, 'router-config.json'));
  });

  afterEach(() => {
    if (agentDirStubbed) {
      vi.unstubAllEnvs();
      agentDirStubbed = false;
    }
    if (dirs.tmp) rmTmpDir(dirs.tmp);
  });

  return {
    paths: dirs,
    loadWithProjectLayer: (layer: unknown) => {
      fs.mkdirSync(path.join(dirs.cwd, '.pi'), { recursive: true });
      fs.writeFileSync(path.join(dirs.cwd, '.pi', 'router-config.json'), JSON.stringify(layer));
      return loadLayeredConfig(dirs.ext, dirs.cwd);
    },
    loadWithGlobalLayer: (layer: unknown) => {
      fs.mkdirSync(dirs.agent, { recursive: true });
      fs.writeFileSync(path.join(dirs.agent, 'router-config.user.json'), JSON.stringify(layer));
      vi.stubEnv('PI_CODING_AGENT_DIR', dirs.agent);
      agentDirStubbed = true;
      return loadLayeredConfig(dirs.ext, dirs.cwd);
    },
    loadShipped: () => loadLayeredConfig(dirs.ext, dirs.cwd),
    warnings: () => vi.mocked(loggerModule.warnLog).mock.calls.map((c) => String(c[0])),
  };
}
