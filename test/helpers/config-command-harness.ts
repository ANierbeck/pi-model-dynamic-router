// Shared harness for `/router config …` tests, driven through the real /router
// handler. Isolation: the user layer lives in a temp PI_CODING_AGENT_DIR, the
// shipped layer in a temp extDir, the project layer in a temp cwd. Hooks are
// registered when the helper is called (inside a describe block), so the
// directories exist before a test file's own beforeEach runs.

import { beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCommands } from '../../src/commands.ts';
import { loadLayeredConfig } from '../../src/config-loader.ts';
import { Router } from '../../src/routing.ts';
import * as metricsModule from '../../src/metrics.ts';
import type { Cache, Config } from '../../src/types.ts';
import { emptyCache } from './stream-fixtures.ts';

export interface ConfigCommandPaths {
  extDir: string;
  agentDir: string;
  cwd: string;
  userFile: string;
}

export interface ConfigCommandHarness {
  paths: ConfigCommandPaths;
  /** Writes the shipped layer; the default is a minimal, valid config. */
  writeShipped: (config?: Record<string, unknown>) => void;
  readUser: () => Record<string, any>;
  /**
   * Builds the /router handler and runs it with `args`. `knownModels` are the
   * refs pi's registry knows (`find` returns a model for them).
   */
  setup: (opts?: { knownModels?: string[] }) => {
    rt: any;
    run: (args: string) => Promise<string>;
  };
}

const DEFAULT_SHIPPED = {
  model_groups: {
    trivial: { description: 'Trivial', method: 'roundrobin', fallback_groups: [] },
  },
  providers: {},
  model_metrics: {},
  gdpval_builtin: {},
  integrations: { laya: { enabled: false } },
};

export function useConfigCommandHarness(tag: string): ConfigCommandHarness {
  const paths: ConfigCommandPaths = { extDir: '', agentDir: '', cwd: '', userFile: '' };
  let prevAgentDir: string | undefined;

  const writeShipped = (config: Record<string, unknown> = DEFAULT_SHIPPED): void => {
    fs.writeFileSync(path.join(paths.extDir, 'router-config.json'), JSON.stringify(config));
  };

  beforeEach(() => {
    paths.extDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-ext-`));
    paths.agentDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-agent-`));
    paths.cwd = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-cwd-`));
    paths.userFile = path.join(paths.agentDir, 'router-config.user.json');
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = paths.agentDir;
    vi.spyOn(process, 'cwd').mockReturnValue(paths.cwd);
    writeShipped();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });

  const setup = (opts: { knownModels?: string[] } = {}) => {
    const known = new Set(opts.knownModels ?? []);
    const cache: Cache = { ...emptyCache(), models_cached: '' } as any;
    let cfg!: Config;
    let router!: Router;
    const load = vi.fn(() => {
      cfg = loadLayeredConfig(paths.extDir, paths.cwd).config;
      router = new Router(cfg, cache, new Map());
      router.setSessionCtx(rt.sessionCtx);
      metricsModule.setConfig(cfg);
      metricsModule.setCache(cache);
      metricsModule.setModelMap({}, []);
    });
    let handler!: (args: string, ctx: any) => Promise<void>;
    const rt: any = {
      get cfg() {
        return cfg;
      },
      get router() {
        return router;
      },
      cache,
      cfgPath: path.join(paths.extDir, 'router-config.json'),
      load,
      sessionCtx: null as any,
      rateLimitManager: { getLimits: () => new Map(), listLimits: () => [] },
      allDiscoveredRefs: () => router.allDiscoveredRefs(),
      getTopModels: () => ({ models: [], total: 0 }),
      resolve: (name: string) => router.resolve(name),
      pi: {
        registerCommand: (_name: string, def: any) => {
          handler = def.handler;
        },
      },
    };
    createCommands(rt);
    const notify = vi.fn();
    const ctx = {
      modelRegistry: {
        find: (provider: string, id: string) =>
          known.has(`${provider}/${id}`) ? { provider, id } : undefined,
        getAvailable: () => [],
      },
      ui: { notify },
    };
    rt.sessionCtx = ctx;
    load();
    const run = async (args: string): Promise<string> => {
      notify.mockClear();
      await handler(args, ctx);
      return notify.mock.calls.map((c) => String(c[0])).join('\n');
    };
    return { rt, run };
  };

  return {
    paths,
    writeShipped,
    readUser: () => JSON.parse(fs.readFileSync(paths.userFile, 'utf-8')),
    setup,
  };
}
