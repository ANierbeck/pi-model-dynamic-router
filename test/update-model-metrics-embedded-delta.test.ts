/**
 * Final v1.6.0 review finding I1 (Important): the update_model_metrics
 * tool persisted its update with `fs.writeFileSync(cfgPath,
 * JSON.stringify(cfg))`. `cfg` at that point is the layered RUNTIME config
 * (user override → project override →, when present, the regenerated
 * dynamic config with computed groups and the _dynamic marker), while
 * `cfgPath` is the extension's EMBEDDED router-config.json — the shipped
 * defaults. One tool call therefore clobbered the embedded defaults with a
 * snapshot of one machine's runtime state (user-layer overrides, computed
 * model_groups, _dynamic marker).
 *
 * Fix shape: the tool reads the embedded file and persists ONLY the fresh
 * delta — the updated model_metrics entry merged into the embedded
 * structure. This test drives the real tool and captures what is written
 * to the embedded path (the write is stubbed — the repo file is never
 * touched).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const embeddedCfgPath = path.join(repoRoot, 'router-config.json');

// index.ts imports fs as a NAMESPACE (`import * as fs from 'node:fs'`),
// which vi.spyOn from the test file does not intercept for its calls — a
// plain spy let the tool's write go straight to the real repo file. vi.mock
// applies to the whole module graph, so it intercepts index.ts. The mock
// forwards everything to the real fs EXCEPT writes to the embedded config,
// which are recorded only — the repo file is never touched, red or green.
const { embeddedWrites, failEmbeddedRead } = vi.hoisted(() => ({
  embeddedWrites: [] as Array<{ path: string; payload: string }>,
  failEmbeddedRead: { value: false, skip: 0 },
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const guardedWrite: typeof fs.writeFileSync = (p: any, data: any, ...rest: any[]) => {
    if (String(p) === embeddedCfgPath) {
      embeddedWrites.push({ path: String(p), payload: String(data) });
      return;
    }
    return (actual as any).writeFileSync(p, data, ...rest);
  };
  // Roborev review (MEDIUM): the refusal path — when the embedded file
  // cannot be read the tool must NOT write a stub — needs the read to
  // throw for exactly this path, while every other read stays real.
  const guardedRead: typeof fs.readFileSync = (p: any, ...rest: any[]) => {
    if (String(p) === embeddedCfgPath && failEmbeddedRead.value) {
      // The first read(s) after the flag flips still succeed — exactly the
      // transient window the refusal path models (load() reads fine, the
      // tool's own read a moment later does not). `skip: 1` lets
      // execute's own load() (one embedded read) succeed so the failure
      // hits the tool's dedicated read inside its try/catch.
      if (failEmbeddedRead.skip > 0) {
        failEmbeddedRead.skip--;
        return (actual as any).readFileSync(p, ...rest);
      }
      throw new Error('EACCES: permission denied (simulated)');
    }
    return (actual as any).readFileSync(p, ...rest);
  };
  return {
    ...(actual as any),
    writeFileSync: guardedWrite,
    readFileSync: guardedRead,
    default: {
      ...(actual as any).default,
      writeFileSync: guardedWrite,
      readFileSync: guardedRead,
    },
  };
});

describe('update_model_metrics embedded-file delta write (I1)', () => {
  it('persists only the metrics delta into the embedded config, not the layered runtime cfg', async () => {
    // Baseline: the real embedded file (read-only) — the written payload must
    // preserve its structure and values.
    const embeddedBefore = JSON.parse(fs.readFileSync(embeddedCfgPath, 'utf-8'));
    expect(embeddedBefore.model_groups).toBeTruthy();

    // User layer marker: a value that ONLY exists in the layered runtime cfg.
    // If the tool wrote JSON.stringify(cfg), this leaks into the embedded file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-i1-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.pi', 'router-config.json'),
      JSON.stringify({ empty_response_timeout_ms: 777 })
    );
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);



    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const tools: Record<string, any> = {};
      const pi: any = {
        registerTool: vi.fn((t: any) => {
          tools[t.name] = t;
        }),
        registerCommand: vi.fn(),
        registerProvider: vi.fn(),
        setModel: vi.fn(async () => true),
        on: vi.fn(),
      };
      mod.default(pi);
      expect(tools['update_model_metrics']).toBeTruthy();

      const res = await tools['update_model_metrics'].execute(
        'call-1',
        { model_ref: 'test-provider/test-model', gdpval: 900, throughput_tps: 42 },
        undefined,
        undefined,
        { cwd: tmpDir } as any
      );
      expect(res.content[0].type).toBe('text');

      const embeddedWrite = embeddedWrites[embeddedWrites.length - 1];
      expect(embeddedWrite).toBeTruthy();
      const written = JSON.parse(embeddedWrite!.payload);

      // The fresh delta landed …
      expect(written.model_metrics['test-provider/test-model']).toEqual({
        gdpval: 900,
        throughput_tps: 42,
      });
      // … while the embedded structure and defaults are preserved intact …
      expect(Object.keys(written).sort()).toEqual(Object.keys(embeddedBefore).sort());
      expect(written.model_groups).toEqual(embeddedBefore.model_groups);
      expect(written.empty_response_timeout_ms).toBe(embeddedBefore.empty_response_timeout_ms);
      // … and the user-layer override did NOT leak into the embedded file.
      expect(written.empty_response_timeout_ms).not.toBe(777);
      // … and other embedded metrics entries survive the merge.
      expect(Object.keys(written.model_metrics).length).toBeGreaterThanOrEqual(
        Object.keys(embeddedBefore.model_metrics ?? {}).length
      );
      for (const [ref, m] of Object.entries(embeddedBefore.model_metrics ?? {})) {
        expect(written.model_metrics[ref]).toEqual(m);
      }
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('refuses to write when the embedded config is unreadable (no stub clobber)', async () => {
    // Roborev review (MEDIUM): the original fix fell through to a
    // delta-only stub write when the embedded read failed — persisting
    // `{ model_metrics: { … } }` and nothing else, replacing the shipped
    // defaults (providers, model_groups, …) and breaking every future
    // load(). Refusing the persist strictly dominates: one ephemeral
    // metrics update is lost, the shipped config survives.
    const writesBefore = embeddedWrites.length;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-i1-refuse-'));
    fs.mkdirSync(path.join(tmpDir, '.pi'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pi', 'router-config.json'), JSON.stringify({}));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

    try {
      vi.resetModules();
      const mod = await import('../index.ts');
      const tools: Record<string, any> = {};
      const pi: any = {
        registerTool: vi.fn((t: any) => {
          tools[t.name] = t;
        }),
        registerCommand: vi.fn(),
        registerProvider: vi.fn(),
        setModel: vi.fn(async () => true),
        on: vi.fn(),
      };
      mod.default(pi);

      // Flip AFTER module init (its load() must succeed) — the next
      // embedded read is execute's own load() (allowed via skip: 1), the
      // one after is the tool's dedicated read, which must throw.
      failEmbeddedRead.value = true;
      failEmbeddedRead.skip = 1;

      const res = await tools['update_model_metrics'].execute(
        'call-1',
        { model_ref: 'test-provider/test-model', gdpval: 900 },
        undefined,
        undefined,
        { cwd: tmpDir } as any
      );

      // NO write to the embedded path — a stub write would clobber the
      // shipped defaults with an empty base layer.
      expect(embeddedWrites.length).toBe(writesBefore);
      // The refusal is surfaced to the caller, not swallowed.
      expect(res.content[0].text).toContain('NOT persisted');
    } finally {
      failEmbeddedRead.value = false;
      failEmbeddedRead.skip = 0;
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
