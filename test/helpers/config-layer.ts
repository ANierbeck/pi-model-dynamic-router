// Shared harness for the config-loader tests: a temp extension dir with the
// shipped router-config.json, and a temp project dir that receives one
// `.pi/router-config.json` layer per load. The warnings are read from the
// mocked logger, so each test file must mock '../src/logger.ts' (warnLog).

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
  /** Temp dirs of the current test: `ext` holds the shipped copy, `cwd` the project. */
  paths: { tmp: string; ext: string; cwd: string };
  loadWithProjectLayer: (layer: unknown) => ReturnType<typeof loadLayeredConfig>;
  loadShipped: () => ReturnType<typeof loadLayeredConfig>;
  warnings: () => string[];
} {
  const dirs = { tmp: '', ext: '', cwd: '' };

  beforeEach(() => {
    vi.clearAllMocks();
    dirs.tmp = fs.mkdtempSync(path.join(os.tmpdir(), `router-${tag}-`));
    dirs.ext = path.join(dirs.tmp, 'ext');
    dirs.cwd = path.join(dirs.tmp, 'project');
    fs.mkdirSync(dirs.ext, { recursive: true });
    fs.mkdirSync(dirs.cwd, { recursive: true });
    fs.copyFileSync(SHIPPED_CONFIG, path.join(dirs.ext, 'router-config.json'));
  });

  afterEach(() => {
    if (dirs.tmp) rmTmpDir(dirs.tmp);
  });

  return {
    paths: dirs,
    loadWithProjectLayer: (layer: unknown) => {
      fs.mkdirSync(path.join(dirs.cwd, '.pi'), { recursive: true });
      fs.writeFileSync(path.join(dirs.cwd, '.pi', 'router-config.json'), JSON.stringify(layer));
      return loadLayeredConfig(dirs.ext, dirs.cwd);
    },
    loadShipped: () => loadLayeredConfig(dirs.ext, dirs.cwd),
    warnings: () => vi.mocked(loggerModule.warnLog).mock.calls.map((c) => String(c[0])),
  };
}
