// /router laya (status) and /router laya install (confirmed-step wizard).
// Plan: docs/plans/2026-11-17-router-laya-install-command.md
//
// The wizard is tested with injected fakes: the real installer cannot download
// an unpublished release, and a test must never touch the network. The handler
// tests run through the real /router path with the shipped manifest, which is
// unpublished, so they prove the refusal without any download.

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  platformVerdict,
  latestOffer,
  mergeLayaBlock,
  layaStatus,
  runLayaInstall,
  writeLayaConfigBlock,
  type LayaInstallDeps,
  type LayaUi,
} from '../src/laya-install-command.ts';
import { LayaInstallError } from '../src/laya-model-install.ts';
import { sidecarPaths } from '../src/laya-sidecar-supervisor.ts';
import type { LayaManifest, LayaModelVersion } from '../src/laya-model-manifest.ts';
import { useConfigCommandHarness } from './helpers/config-command-harness.ts';

const ONNX = {
  head_file: { path: 'head.json', format: 'head-json' as const },
  files: [
    {
      path: 'model.onnx',
      asset: 'model.onnx',
      bytes: 1_300_000_000,
      sha256: 'a'.repeat(64),
    },
  ],
};

function version(v: string, published: boolean, model = 'router'): LayaModelVersion {
  return {
    model,
    version: v,
    tag: `laya-${model}-v${v}`,
    published,
    base_url: 'https://example.invalid/',
    head: { sha256: 'b'.repeat(64), categories: ['simple'] },
    backends: { onnx: ONNX },
  };
}

function manifest(...versions: LayaModelVersion[]): LayaManifest {
  return { schema_version: 1, models: versions };
}

interface Fakes {
  deps: LayaInstallDeps;
  ui: LayaUi & { confirm: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
  installModel: ReturnType<typeof vi.fn>;
  installRuntime: ReturnType<typeof vi.fn>;
  writeLayaBlock: ReturnType<typeof vi.fn>;
  verifyInstall: ReturnType<typeof vi.fn>;
}

/** A healthy-looking world: published router@1.0.0, nothing installed yet, runtime present. */
function fakes(
  over: {
    platform?: string;
    arch?: string;
    manifest?: LayaManifest;
    installed?: boolean;
    verifies?: { ok: boolean; problems: string[] };
    runtimeOk?: boolean;
    confirm?: (title: string, message: string) => boolean;
    installError?: unknown;
    postVerify?: { ok: boolean; problems: string[] };
    layaBlock?: Record<string, unknown>;
    /** A recorded sidecar pid; absent means "nothing is recorded". */
    pid?: number;
    /** What /health answers when a sidecar is recorded. */
    probe?: Record<string, unknown> | null;
    endpoint?: string;
    probeProblem?: () => string | null;
  } = {}
): Fakes {
  const installed = over.installed ?? false;
  const verifies = over.verifies ?? { ok: true, problems: [] };
  const confirmAnswer = over.confirm ?? (() => true);
  const confirm = vi.fn(async (title: string, message: string) => confirmAnswer(title, message));
  const notify = vi.fn();
  const installModel = vi.fn(async () => {
    if (over.installError) throw over.installError;
    return {
      dir: '/x/router/1.0.0',
      artifact_sha256: 'c'.repeat(64),
      bytesDownloaded: 1,
      resumed: [],
    };
  });
  // The wizard verifies at most twice: a pre-check of an existing install (only
  // when one is there), then the check after a download. The first call is the
  // pre-check when installed, and the post-download check otherwise.
  const postVerify = over.postVerify ?? { ok: true, problems: [] };
  const verifyInstall = vi
    .fn()
    .mockResolvedValueOnce(installed ? verifies : postVerify)
    .mockResolvedValue(postVerify);
  const installRuntime = vi.fn(async () => ({
    dir: '/x/runtime',
    version: '1.0.0',
    installed: true,
  }));
  const writeLayaBlock = vi.fn(() => ({
    ok: true as const,
    written: '/x/router-config.user.json',
  }));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-cmd-state-'));
  const health = vi.fn(async () => over.probe ?? null);
  const deps: LayaInstallDeps = {
    platform: over.platform ?? 'darwin',
    arch: over.arch ?? 'arm64',
    root: '/x/laya-models',
    runtimeDir: '/x/laya-runtime',
    runtimeSpecDir: '/x/spec',
    loadManifest: async () => over.manifest ?? manifest(version('1.0.0', true)),
    listInstalls: async () =>
      installed ? [{ model: 'router', version: '1.0.0', backend: 'onnx' }] : [],
    verifyInstall,
    installModel: installModel as unknown as LayaInstallDeps['installModel'],
    verifyRuntime: () =>
      over.runtimeOk === false
        ? { ok: false, problems: ['the ONNX runtime is not installed'] }
        : { ok: true, problems: [], version: '1.0.0' },
    installRuntime: installRuntime as unknown as LayaInstallDeps['installRuntime'],
    readLayaBlock: () => over.layaBlock,
    writeLayaBlock: writeLayaBlock as unknown as LayaInstallDeps['writeLayaBlock'],
    // A real state dir: the sidecar record lives in it, and a fake path would hide
    // the difference between "nothing recorded" and "record unreadable".
    stateDir,
    supervisor: {
      execPath: '/usr/local/bin/node',
      cliPath: '/x/dist/laya-model-install.js',
      spawn: (() => ({ pid: 4242, unref: () => {}, on: () => {} })) as never,
      isPidAlive: () => over.pid !== undefined,
      kill: () => {},
      sleep: async () => {},
      now: () => 0,
    },
    health,
    endpoint: over.endpoint ?? 'http://127.0.0.1:8089',
    ...(over.probeProblem ? { probeProblem: over.probeProblem } : {}),
  };
  if (over.pid !== undefined) fs.writeFileSync(sidecarPaths(stateDir).pidFile, String(over.pid));
  return {
    deps,
    stateDir,
    health,
    ui: { confirm, notify },
    installModel,
    installRuntime,
    writeLayaBlock,
    verifyInstall,
  };
}

describe('platformVerdict', () => {
  it('Apple Silicon is the tested platform', () => {
    expect(platformVerdict('darwin', 'arm64')).toBe('tested');
  });

  it('Linux and Windows on x64 or arm64 work but are untested', () => {
    expect(platformVerdict('linux', 'x64')).toBe('untested');
    expect(platformVerdict('linux', 'arm64')).toBe('untested');
    expect(platformVerdict('win32', 'x64')).toBe('untested');
  });

  it('Intel Macs and anything else are unsupported (no ONNX Runtime binding)', () => {
    expect(platformVerdict('darwin', 'x64')).toBe('unsupported');
    expect(platformVerdict('freebsd', 'x64')).toBe('unsupported');
  });
});

describe('latestOffer', () => {
  it('picks the highest published router version, comparing numerically', () => {
    const offer = latestOffer(
      manifest(version('1.9.0', true), version('1.10.0', true), version('1.11.0', false))
    );
    expect(offer).toMatchObject({ model: 'router', version: '1.10.0', published: true });
  });

  it('falls back to the highest unpublished version so status can say why it is not installable', () => {
    const offer = latestOffer(manifest(version('1.0.0', false)));
    expect(offer).toMatchObject({ version: '1.0.0', published: false });
  });

  it('ignores other models and returns null when the manifest has no router', () => {
    expect(latestOffer(manifest(version('2.0.0', true, 'other')))).toBeNull();
  });

  it('reports the ONNX size, which is what the confirmation shows', () => {
    expect(latestOffer(manifest(version('1.0.0', true)))).toMatchObject({
      bytes: 1_300_000_000,
      files: 1,
    });
  });
});

describe('mergeLayaBlock', () => {
  it('a fresh block is shadow mode on the default endpoint', () => {
    expect(mergeLayaBlock(undefined, 'router@1.0.0')).toEqual({
      enabled: true,
      mode: 'shadow',
      checkpoint: 'router@1.0.0',
      endpoint: 'http://127.0.0.1:8089',
    });
  });

  it('keeps the user keys (mode, endpoint, timeout) and moves enabled and checkpoint', () => {
    expect(
      mergeLayaBlock(
        {
          enabled: false,
          mode: 'active',
          endpoint: 'http://127.0.0.1:9000',
          timeout_ms: 5000,
          checkpoint: 'router@0.9.0',
        },
        'router@1.0.0'
      )
    ).toEqual({
      enabled: true,
      mode: 'active',
      endpoint: 'http://127.0.0.1:9000',
      timeout_ms: 5000,
      checkpoint: 'router@1.0.0',
    });
  });
});

describe('runLayaInstall', () => {
  it('stops on Intel Macs before anything is downloaded or asked', async () => {
    const f = fakes({ platform: 'darwin', arch: 'x64' });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(out).toMatch(/not supported/);
    expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(f.installModel).not.toHaveBeenCalled();
  });

  it('stops at an unpublished version: no download, and no override path exists', async () => {
    const f = fakes({ manifest: manifest(version('1.0.0', false)) });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(out).toMatch(/not published yet/);
    expect(out).toMatch(/owner/);
    expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(f.installModel).not.toHaveBeenCalled();
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
  });

  it('asks before the download, with version, size and target, and stops on no', async () => {
    const f = fakes({ confirm: () => false });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(f.ui.confirm).toHaveBeenCalledTimes(1);
    const message = String(f.ui.confirm.mock.calls[0]?.[1]);
    expect(message).toMatch(/router@1\.0\.0/);
    expect(message).toMatch(/1[.,]2\d* GB|1[.,]2\d* MB|1[.,]3\d* MB|1[.,]3\d* GB/);
    expect(message).toContain('/x/laya-models/router/1.0.0');
    expect(f.installModel).not.toHaveBeenCalled();
    expect(out).toMatch(/nothing was downloaded/);
  });

  it('installs with the onnx backend, never forced and never unpublished', async () => {
    const f = fakes();
    await runLayaInstall(f.ui, f.deps);
    expect(f.installModel).toHaveBeenCalledTimes(1);
    expect(f.installModel).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'router',
        version: '1.0.0',
        backend: 'onnx',
        root: '/x/laya-models',
        force: false,
      })
    );
    expect(f.installModel.mock.calls[0]?.[0]).not.toHaveProperty('allowUnpublished', true);
  });

  it('an install that does not verify afterwards writes no config', async () => {
    const f = fakes({ postVerify: { ok: false, problems: ['model.onnx: sha256 mismatch'] } });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(out).toMatch(/sha256 mismatch/);
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
  });

  it('an install that is already there and verifies skips the download', async () => {
    const f = fakes({ installed: true, verifies: { ok: true, problems: [] } });
    await runLayaInstall(f.ui, f.deps);
    expect(f.installModel).not.toHaveBeenCalled();
    // Only the config question remains.
    expect(f.ui.confirm).toHaveBeenCalledTimes(1);
  });

  it('a broken install is shown with its problems, and a reinstall needs a yes', async () => {
    const f = fakes({
      installed: true,
      verifies: { ok: false, problems: ['model.onnx: missing'] },
      confirm: () => false,
    });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(out).toMatch(/model\.onnx: missing/);
    expect(f.installModel).not.toHaveBeenCalled();
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
  });

  it('a broken install that the user agrees to replace is reinstalled with force', async () => {
    const f = fakes({
      installed: true,
      verifies: { ok: false, problems: ['model.onnx: missing'] },
      confirm: (_t, m) => !m.includes('Write'),
    });
    await runLayaInstall(f.ui, f.deps);
    expect(f.installModel).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });

  it('a failing download reports the error code and writes no config', async () => {
    const f = fakes({ installError: new LayaInstallError('unpublished', 'not published') });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(out).toMatch(/Install failed \(unpublished\)/);
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
  });

  it('asks before the ~115 MB runtime, and stops without writing config on no', async () => {
    const f = fakes({
      runtimeOk: false,
      confirm: (_t, m) => !m.includes('ONNX runtime'),
    });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(f.ui.confirm.mock.calls.some((c) => String(c[1]).includes('115 MB'))).toBe(true);
    expect(f.installRuntime).not.toHaveBeenCalled();
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
    expect(out).toMatch(/runtime/);
  });

  it('installs the runtime on yes, then asks about the config', async () => {
    const f = fakes({ runtimeOk: false });
    await runLayaInstall(f.ui, f.deps);
    expect(f.installRuntime).toHaveBeenCalledTimes(1);
    expect(f.writeLayaBlock).toHaveBeenCalledTimes(1);
  });

  it('shows the config block and writes it on yes, keeping the user keys', async () => {
    const f = fakes({ installed: true, layaBlock: { mode: 'active', timeout_ms: 5000 } });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(f.writeLayaBlock).toHaveBeenCalledWith({
      enabled: true,
      mode: 'active',
      timeout_ms: 5000,
      checkpoint: 'router@1.0.0',
      endpoint: 'http://127.0.0.1:8089',
    });
    expect(out).toMatch(/pi-laya-model|laya-model-install\.js/);
    expect(out).toMatch(/serve router@1\.0\.0/);
  });

  it('a config write that fails is reported, and the wizard does not claim success', async () => {
    // The first real run in the container ended with "Not written — \
    // "integrations.laya" is not a key /router config can set" followed by
    // "Laya is set up": the wizard ignored the failure and told the user the
    // opposite of what happened.
    const f = fakes({ installed: true });
    f.writeLayaBlock.mockReturnValue({
      ok: false as const,
      error: 'Not written — disk is read-only',
    });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(out).toMatch(/Not written — disk is read-only/);
    expect(out).not.toMatch(/Laya is set up/);
  });

  it('config declined: nothing is written and the user is told so', async () => {
    const f = fakes({ confirm: (_t, m) => !m.includes('Write') });
    const out = await runLayaInstall(f.ui, f.deps);
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
    expect(out).toMatch(/Config not written/);
  });
});

describe('writeLayaConfigBlock (real user-config store)', () => {
  it('persists the block, including the keys /router config set cannot write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-cfg-'));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const block = {
        enabled: true,
        mode: 'shadow',
        checkpoint: 'router@1.0.0',
        endpoint: 'http://127.0.0.1:8089',
        timeout_ms: 5000,
      };
      const res = writeLayaConfigBlock(block);
      expect(res.ok).toBe(true);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'router-config.user.json'), 'utf8'));
      expect(saved.integrations.laya).toEqual(block);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the other keys and other integrations the user already has', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-cfg2-'));
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      fs.writeFileSync(
        path.join(dir, 'router-config.user.json'),
        JSON.stringify({
          log_level: 'debug',
          integrations: { laya: { mode: 'active', timeout_ms: 5000 }, other: { enabled: false } },
        })
      );
      expect(writeLayaConfigBlock({ enabled: true, mode: 'active', timeout_ms: 5000 }).ok).toBe(
        true
      );
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'router-config.user.json'), 'utf8'));
      expect(saved.log_level).toBe('debug');
      expect(saved.integrations.other).toEqual({ enabled: false });
      expect(saved.integrations.laya).toMatchObject({
        enabled: true,
        mode: 'active',
        timeout_ms: 5000,
      });
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('layaStatus', () => {
  it('reports offer, installed state, runtime and config, and changes nothing', async () => {
    const f = fakes({
      installed: true,
      layaBlock: { enabled: true, mode: 'shadow', checkpoint: 'router@1.0.0' },
    });
    const lines = await layaStatus(f.deps);
    const text = lines.join('\n');
    // Each assertion names its line: a bare /installed/ also matched
    // "not installed", so the test could not fail for the wrong report.
    expect(text).toMatch(/offer: router@1\.0\.0 — published/);
    expect(text).toMatch(/install: router@1\.0\.0 installed/);
    expect(text).toMatch(/ONNX runtime: installed/);
    expect(text).toMatch(/config: integrations\.laya — enabled on, mode shadow/);
    expect(text).toMatch(/sidecar: not running/);
    expect(text).toMatch(/next: \/router laya serve/);
    expect(f.ui.confirm).not.toHaveBeenCalled();
    expect(f.installModel).not.toHaveBeenCalled();
    expect(f.writeLayaBlock).not.toHaveBeenCalled();
  });

  it('an unpublished offer says it is not installable yet, with the reason', async () => {
    const f = fakes({
      manifest: manifest(version('1.0.0', false)),
      installed: false,
      runtimeOk: false,
      layaBlock: undefined,
    });
    const text = (await layaStatus(f.deps)).join('\n');
    expect(text).toMatch(/offer: router@1\.0\.0 — NOT published yet/);
    expect(text).toMatch(/install: router@1\.0\.0 not installed/);
    expect(text).toMatch(/ONNX runtime: not installed/);
    expect(text).toMatch(/config: not configured/);
    // An unpublished offer is the reason, not "run install": naming the wrong
    // next step sends the user into a wizard that can only refuse.
    expect(text).toMatch(/next: router@1\.0\.0 cannot be installed until it is published/);
  });

  it('reports a running sidecar together with the identity /health proves', async () => {
    const block = { enabled: true, mode: 'active', checkpoint: 'router@1.0.0' };
    const matching = fakes({ installed: true, layaBlock: block, pid: 4242 });
    // The fingerprint the configured checkpoint should answer with, taken from the
    // same manifest the status reads: a literal would silently stop matching.
    const matchingOffer = latestOffer(await matching.deps.loadManifest()) as {
      artifactSha256: string;
    };
    const sha = matchingOffer.artifactSha256;
    matching.deps.health = async () => ({ artifact_sha256: sha });
    expect((await layaStatus(matching.deps)).join('\n')).toMatch(
      /sidecar: running \(pid 4242\) — \/health ok, same artifact as router@1\.0\.0/
    );

    expect(sha).not.toBe('b'.repeat(64));
    const other = fakes({
      installed: true,
      layaBlock: block,
      pid: 4242,
      probe: { artifact_sha256: 'b'.repeat(64) },
    });
    expect((await layaStatus(other.deps)).join('\n')).toMatch(/serving a DIFFERENT model/);

    // /health answering without a fingerprint proves nothing about identity.
    const mute = fakes({ installed: true, layaBlock: block, pid: 4242, probe: {} });
    expect((await layaStatus(mute.deps)).join('\n')).toMatch(/identity unknown/);

    const silent = fakes({ installed: true, layaBlock: block, pid: 4242, probe: null });
    const silentText = (await layaStatus(silent.deps)).join('\n');
    expect(silentText).toMatch(/\/health does not answer/);
    expect(silentText).toMatch(/next: \/router laya stop, then \/router laya serve/);
  });

  it('reports a sidecar on an endpoint it will not probe, and why', async () => {
    const f = fakes({
      installed: true,
      layaBlock: { enabled: true, checkpoint: 'router@1.0.0' },
      pid: 4242,
      endpoint: 'http://10.0.0.5:8089',
      probeProblem: () => 'the endpoint is not on this machine',
    });
    const text = (await layaStatus(f.deps)).join('\n');
    expect(text).toMatch(/not probed: the endpoint is not on this machine/);
    // A probe that could not be interpreted is not worth a request.
    expect(f.health).not.toHaveBeenCalled();
  });

  it('says the router will not use Laya when integrations.laya.enabled is off', async () => {
    const f = fakes({ installed: true, layaBlock: { enabled: false, checkpoint: 'router@1.0.0' } });
    expect((await layaStatus(f.deps)).join('\n')).toMatch(
      /next: nothing to start — integrations\.laya\.enabled is off/
    );
  });
});

describe('/router laya through the real handler', () => {
  const harness = useConfigCommandHarness('laya-cmd');
  const { setup } = harness;

  it('/router laya prints the status and creates no install directory', async () => {
    const out = await setup({ mode: 'print' }).run('laya');
    expect(out).toMatch(/Laya/);
    expect(out).toMatch(/router@1\.0\.0/);
    expect(fs.existsSync(path.join(harness.paths.agentDir, 'laya-models'))).toBe(false);
  });

  it('rpc mode may run the wizard: it has dialogs, so the step questions work', async () => {
    // ctx.mode is "rpc" and ctx.hasUI is true there (pi docs, rpc-extension-ui):
    // confirm/select/input arrive as extension_ui_request and are answered by the
    // client. Refusing rpc would block every non-terminal client. The shipped
    // manifest is unpublished, so the wizard stops at the offer — which proves the
    // guard let it through (a refused run would say "interactive"/"TUI").
    const h = setup({ mode: 'rpc', confirm: async () => true });
    const out = await h.run('laya install');
    expect(out).not.toMatch(/interactive|TUI/);
    expect(out).toMatch(/not published yet|Download|nothing was downloaded/i);
    expect(fs.existsSync(path.join(harness.paths.agentDir, 'laya-models'))).toBe(false);
  });

  it('print mode refuses: it has no dialogs to answer the steps', async () => {
    const h = setup({ mode: 'print' });
    const out = await h.run('laya install');
    expect(out).toMatch(/interactive/);
    expect(h.ui.confirm).not.toHaveBeenCalled();
  });

  // The declining paths (download, runtime, config) are pinned against fakes above.
  // This test uses the REAL deps and the shipped manifest, so it can only prove one
  // thing: whatever the wizard decides, nothing lands in the agent dir. Naming it
  // after the "no" path would promise coverage it does not have while the shipped
  // manifest stays unpublished.
  it('/router laya install in the TUI leaves the agent dir untouched', async () => {
    const h = setup({ mode: 'tui', confirm: async () => false });
    const out = await h.run('laya install');
    expect(out).toMatch(/not published yet|nothing was downloaded|does not verify/);
    if (/not published yet/.test(out)) {
      // The release guard fires before the first dialog: a wizard that asks and
      // then refuses teaches the user to click through without reading.
      expect(h.ui.confirm).not.toHaveBeenCalled();
    }
    expect(fs.existsSync(path.join(harness.paths.agentDir, 'laya-models'))).toBe(false);
    expect(fs.existsSync(path.join(harness.paths.agentDir, 'laya-runtime'))).toBe(false);
  });

  it('an unknown laya subcommand shows the usage', async () => {
    const out = await setup({ mode: 'print' }).run('laya bogus');
    expect(out).toMatch(/Usage: \/router laya \[install\|serve\|stop\]/);
  });

  it('starts no sidecar on its own: /router laya only reports', async () => {
    // The rule the owner kept: nothing starts silently. Status must stay passive,
    // so no pid file may appear in the state dir.
    const stateDir = path.join(harness.paths.agentDir, 'state');
    process.env.PI_ROUTER_STATE_DIR = stateDir;
    try {
      const out = await setup({ mode: 'print' }).run('laya');
      expect(out).toMatch(/sidecar/i);
      expect(fs.existsSync(path.join(stateDir, 'laya-sidecar.pid'))).toBe(false);
    } finally {
      delete process.env.PI_ROUTER_STATE_DIR;
    }
  });

  it('serve without a configured checkpoint refuses and names the two ways out', async () => {
    const out = await setup({ mode: 'rpc' }).run('laya serve');
    // The branch matters: /router laya install appears in several messages, so the
    // assertion names the one that means "nothing is configured yet".
    expect(out).toMatch(/No checkpoint is configured/);
    expect(out).toMatch(/integrations\.laya\.checkpoint/);
    expect(out).not.toMatch(/does not verify/);
  });

  it('serve with a configured checkpoint that does not verify refuses before spawning', async () => {
    // Written before setup(): the harness loads the layered config once.
    fs.writeFileSync(
      harness.paths.userFile,
      JSON.stringify({ integrations: { laya: { enabled: true, checkpoint: 'router@1.0.0' } } })
    );
    const h = setup({ mode: 'rpc' });
    const out = await h.run('laya serve');
    expect(out).toMatch(/The configured router@1\.0\.0 does not verify/);
    expect(out).toMatch(/Run \/router laya install to reinstall it/);
    // Nothing was spawned, so no record may exist in any of the candidate dirs.
    for (const dir of [harness.paths.extDir, harness.paths.agentDir]) {
      expect(fs.existsSync(path.join(dir, 'laya-sidecar.pid'))).toBe(false);
    }
  });

  it('reads integrations.laya from the project layer, not only from the user file', async () => {
    // The classifier uses the layered config, so a project layer that configures
    // Laya must be what status and serve act on. Reading the user file here made
    // /router laya describe a different setup than the one running.
    // Layer 3 is <cwd>/.pi/router-config.json (config-loader), not <cwd>/router-config.json.
    fs.mkdirSync(path.join(harness.paths.cwd, '.pi'), { recursive: true });
    fs.writeFileSync(
      path.join(harness.paths.cwd, '.pi', 'router-config.json'),
      JSON.stringify({ integrations: { laya: { enabled: true, checkpoint: 'router@9.9.9' } } })
    );
    const out = await setup({ mode: 'print' }).run('laya');
    expect(out).toMatch(/config: integrations\.laya — enabled on/);
    expect(out).toMatch(/checkpoint router@9\.9\.9/);
  });

  it('stop without a recorded sidecar says so', async () => {
    const out = await setup({ mode: 'rpc' }).run('laya stop');
    expect(out).toMatch(/no sidecar/i);
  });
});
