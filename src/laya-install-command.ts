// `/router laya` (status) and `/router laya install` (the confirmed-step wizard):
// the procedure of skills/router-laya-install/SKILL.md, run inside pi.
// Plan: docs/plans/2026-11-17-router-laya-install-command.md
//
// The wizard never downloads, writes or starts anything before a yes, and it has
// no path to an unpublished release: the skill's rule, enforced in code. The
// router never starts the sidecar; the last message tells the user the command.

import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  defaultModelsRoot,
  installModel,
  listInstalls,
  LayaInstallError,
  loadManifest,
  shippedManifestPath,
  verifyInstall,
} from './laya-model-install.ts';
import {
  defaultRuntimeDir,
  installRuntime,
  shippedRuntimeSpecDir,
  verifyRuntime,
} from './laya-runtime-install.ts';
import { artifactSha256, type LayaBackend, type LayaManifest } from './laya-model-manifest.ts';
import { LAYA_DEFAULT_ENDPOINT } from './laya-classifier.ts';
import { openUserConfigStore } from './user-config-store.ts';
import {
  describeSidecar,
  portFromEndpoint,
  startSidecar,
  stopSidecar,
  type SupervisorDeps,
} from './laya-sidecar-supervisor.ts';

/** The model this command installs. The manifest may list others; they are ignored. */
export const LAYA_MODEL = 'router';
const LAYA_BACKEND: LayaBackend = 'onnx';
/** Size of the ONNX runtime download, as the confirmation states it (about). */
const RUNTIME_SIZE_TEXT = 'about 115 MB';

export type PlatformVerdict = 'tested' | 'untested' | 'unsupported';

/**
 * Apple Silicon is the tested platform. Linux and Windows on x64 or arm64 should
 * work but are untested. Intel Macs have no ONNX Runtime binding, so Laya cannot
 * run there at all, and the router keeps its classifier chain.
 */
export function platformVerdict(platform: string, arch: string): PlatformVerdict {
  if (platform === 'darwin') return arch === 'arm64' ? 'tested' : 'unsupported';
  if (platform === 'linux' || platform === 'win32') {
    return arch === 'x64' || arch === 'arm64' ? 'untested' : 'unsupported';
  }
  return 'unsupported';
}

const VERDICT_TEXT: Record<PlatformVerdict, string> = {
  tested: 'tested',
  untested: 'should work, not tested',
  unsupported: 'not supported (no ONNX Runtime binding)',
};

export interface LayaOffer {
  model: string;
  version: string;
  published: boolean;
  /** Total bytes of the ONNX artifact set. */
  bytes: number;
  files: number;
  /** Manifest-derived fingerprint; a healthy sidecar reports the same on /health. */
  artifactSha256: string;
  files_list: { path: string; sha256: string }[];
}

/**
 * The version to offer: the highest published `router` version. When none is
 * published, the highest unpublished one is returned, so status can say why it
 * cannot be installed yet. Null when the manifest has no `router` with an ONNX build.
 */
export function latestOffer(manifest: LayaManifest, model = LAYA_MODEL): LayaOffer | null {
  const candidates = manifest.models.filter((m) => m.model === model && m.backends[LAYA_BACKEND]);
  if (candidates.length === 0) return null;
  const byVersion = (a: { version: string }, b: { version: string }): number =>
    compareVersions(a.version, b.version);
  const published = candidates.filter((m) => m.published).sort(byVersion);
  const pick = published.at(-1) ?? [...candidates].sort(byVersion).at(-1);
  if (!pick) return null;
  const set = pick.backends[LAYA_BACKEND];
  if (!set) return null;
  return {
    model: pick.model,
    version: pick.version,
    published: pick.published,
    bytes: set.files.reduce((sum, f) => sum + f.bytes, 0),
    files: set.files.length,
    artifactSha256: artifactSha256(set.files),
    files_list: set.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
}

/**
 * The `integrations.laya` block the wizard writes. Keys the user already has
 * (mode, endpoint, timeout_ms, …) are kept; `enabled` and `checkpoint` are set
 * to the installed version. A fresh block starts in shadow mode, which logs the
 * answer without changing the route.
 */
export function mergeLayaBlock(
  existing: Record<string, unknown> | undefined,
  checkpoint: string
): Record<string, unknown> {
  return {
    mode: 'shadow',
    endpoint: LAYA_DEFAULT_ENDPOINT,
    ...(existing ?? {}),
    enabled: true,
    checkpoint,
  };
}

export interface LayaUi {
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: 'info' | 'warning' | 'error'): void;
}

export interface LayaInstallDeps {
  platform: string;
  arch: string;
  root: string;
  runtimeDir: string;
  runtimeSpecDir: string;
  loadManifest: () => Promise<LayaManifest>;
  listInstalls: (root: string) => Promise<{ model: string; version: string; backend: string }[]>;
  verifyInstall: (opts: {
    root: string;
    model: string;
    version: string;
  }) => Promise<{ ok: boolean; problems: string[] }>;
  installModel: (opts: {
    manifest: LayaManifest;
    model: string;
    version: string;
    backend: LayaBackend;
    root: string;
    force: boolean;
  }) => Promise<{ dir: string; artifact_sha256: string; bytesDownloaded: number }>;
  verifyRuntime: (target: { dir: string; specDir: string; platform: string; arch: string }) => {
    ok: boolean;
    problems: string[];
    version?: string;
  };
  installRuntime: (target: {
    dir: string;
    specDir: string;
    platform: string;
    arch: string;
  }) => Promise<{ version: string; installed: boolean }>;
  readLayaBlock: () => Record<string, unknown> | undefined;
  writeLayaBlock: (block: Record<string, unknown>) => WriteResult;
  /** Where the pid and log of the sidecar live (`PI_ROUTER_STATE_DIR`). */
  stateDir: string;
  supervisor: SupervisorDeps;
  /** Short local probe of the sidecar's /health; null when it does not answer. */
  health: () => Promise<{ artifact_sha256?: string } | null>;
}

/** Binary units, decimal above a gigabyte: "1.30 GB" for the 1.3 GB artifact set. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

/** What a config write did. The wizard must not report success when this failed. */
export type WriteResult = { ok: true; written: string } | { ok: false; error: string };

/**
 * Writes the `integrations.laya` block into the user layer.
 *
 * Through the `integrations` delta, not through `paths`: `checkpoint`, `endpoint`
 * and `timeout_ms` are not `/router config set` keys, so the paths form refuses
 * them ("is not a key /router config can set") and nothing is written. Found by
 * the first real run in the sandbox container.
 */
export function writeLayaConfigBlock(block: Record<string, unknown>): WriteResult {
  return openUserConfigStore().applyDelta({ integrations: { laya: block } });
}

/** A string config value, or the fallback when the key is absent or not a string. */
function configText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** The sidecar start command, pointing at the installer this package ships. */
export function serveCommand(checkpoint: string): string {
  const cli = fileURLToPath(new URL('./laya-model-install.js', import.meta.url));
  return `node ${cli} serve ${checkpoint}`;
}

/** `/router laya`: what is offered, installed, configured — and the next step. Changes nothing. */
export async function layaStatus(deps: LayaInstallDeps): Promise<string[]> {
  const verdict = platformVerdict(deps.platform, deps.arch);
  const lines = [
    'Laya classifier',
    `  platform: ${deps.platform}/${deps.arch} — ${VERDICT_TEXT[verdict]}`,
  ];
  const offer = latestOffer(await deps.loadManifest());
  if (!offer) {
    lines.push('  offer: the manifest has no router model with an ONNX build');
    return [...lines, '  next: nothing to install from this router version'];
  }
  const ref = `${offer.model}@${offer.version}`;
  lines.push(
    `  offer: ${ref} — ${offer.published ? 'published' : 'NOT published yet (installing needs the owner’s release approval)'}, ` +
      `${formatBytes(offer.bytes)}, ${offer.files} file(s)`
  );

  const installs = (await deps.listInstalls(deps.root)).filter(
    (i) => i.model === offer.model && i.version === offer.version
  );
  const installed = installs.length > 0;
  lines.push(
    installed
      ? `  install: ${ref} installed (${LAYA_BACKEND}) in ${deps.root} — not re-verified here`
      : `  install: ${ref} not installed`
  );

  const runtime = deps.verifyRuntime({
    dir: deps.runtimeDir,
    specDir: deps.runtimeSpecDir,
    platform: deps.platform,
    arch: deps.arch,
  });
  lines.push(
    runtime.ok
      ? `  ONNX runtime: installed (${runtime.version ?? 'pinned'})`
      : '  ONNX runtime: not installed'
  );

  const block = deps.readLayaBlock();
  lines.push(
    block
      ? `  config: integrations.laya — enabled ${block.enabled === true ? 'on' : 'off'}, mode ${configText(block.mode, 'shadow')}, checkpoint ${configText(block.checkpoint, '—')}`
      : '  config: not configured (integrations.laya)'
  );

  const sidecar = describeSidecar(deps.stateDir, deps.supervisor);
  let healthLine = sidecar.running
    ? `  sidecar: running (pid ${String(sidecar.pid)})`
    : '  sidecar: not running';
  if (sidecar.running) {
    const probe = await deps.health();
    if (!probe) healthLine += ' — /health does not answer';
    else if (probe.artifact_sha256 && probe.artifact_sha256 !== offer.artifactSha256)
      healthLine += ` — serving a DIFFERENT model (artifact ${probe.artifact_sha256.slice(0, 12)}… ≠ ${offer.artifactSha256.slice(0, 12)}…)`;
    else healthLine += ' — /health ok, same artifact as the manifest';
  }
  lines.push(healthLine);

  let next: string;
  if (!offer.published)
    next = `${ref} cannot be installed until it is published (owner release decision)`;
  else if (!installed || !runtime.ok || !block) next = '/router laya install';
  else if (!sidecar.running)
    next = `/router laya serve (or in your own terminal: ${serveCommand(ref)})`;
  else next = 'nothing — Laya is ready';
  return [...lines, `  next: ${next}`];
}

/**
 * `/router laya serve`: start the sidecar detached (plan
 * 2026-11-17-laya-sidecar-lifecycle.md). Refuses when the prerequisites are not
 * in place or a sidecar is already recorded; never replaces a running one.
 */
export async function runLayaServe(deps: LayaInstallDeps): Promise<string> {
  const block = deps.readLayaBlock();
  const checkpoint = configText(block?.checkpoint, '');
  if (!checkpoint) {
    return 'No checkpoint is configured: run /router laya install first (or set integrations.laya.checkpoint).';
  }
  const installs = await deps.listInstalls(deps.root);
  const runtime = deps.verifyRuntime({
    dir: deps.runtimeDir,
    specDir: deps.runtimeSpecDir,
    platform: deps.platform,
    arch: deps.arch,
  });
  const res = await startSidecar(
    {
      stateDir: deps.stateDir,
      checkpoint,
      port: portFromEndpoint(configText(block?.endpoint, '')),
      installed: () => installs.some((i) => `${i.model}@${i.version}` === checkpoint),
      runtimeOk: () => runtime.ok,
      healthAnswers: async () => (await deps.health()) !== null,
    },
    deps.supervisor
  );
  if (!res.ok) return res.error;
  return [
    `Laya sidecar started (pid ${res.pid}) for ${checkpoint}, log: ${res.logFile}`,
    `Endpoint: ${configText(block?.endpoint, LAYA_DEFAULT_ENDPOINT)} — /router laya shows whether /health answers.`,
    'It keeps running after pi exits; /router laya stop ends it.',
  ].join('\n');
}

/** `/router laya stop`: end the recorded sidecar. */
export async function runLayaStop(deps: LayaInstallDeps): Promise<string> {
  const res = await stopSidecar(deps.stateDir, deps.supervisor);
  return res.ok ? `Laya sidecar stopped (pid ${res.pid}).` : res.error;
}

/** Stops the wizard with the reason, so the user knows what did and did not change. */
function stop(summary: string[], reason: string): string {
  return [...summary, reason].join('\n');
}

/**
 * `/router laya install`, step by step (SKILL.md steps 1–9). Every step asks
 * before it changes anything; a "no" stops with the state left as it is. The
 * returned text is the final message; intermediate notes go through ui.notify.
 */
export async function runLayaInstall(ui: LayaUi, deps: LayaInstallDeps): Promise<string> {
  const summary: string[] = [];
  const verdict = platformVerdict(deps.platform, deps.arch);
  if (verdict === 'unsupported') {
    return `Laya is ${VERDICT_TEXT.unsupported} on ${deps.platform}/${deps.arch}. The router keeps its classifier chain; nothing was changed.`;
  }
  if (verdict === 'untested') {
    summary.push(`Note: ${deps.platform}/${deps.arch} is not a tested platform; it should work.`);
  }

  const offer = latestOffer(await deps.loadManifest());
  if (!offer) return 'The manifest offers no router model with an ONNX build. Nothing was changed.';
  const ref = `${offer.model}@${offer.version}`;
  if (!offer.published) {
    return `${ref} is not published yet. Installing it needs the owner’s release approval; nothing was downloaded.`;
  }

  const existing = (await deps.listInstalls(deps.root)).some(
    (i) => i.model === offer.model && i.version === offer.version
  );
  const target = `${deps.root}/${offer.model}/${offer.version}`;
  if (existing) {
    const check = await deps.verifyInstall({
      root: deps.root,
      model: offer.model,
      version: offer.version,
    });
    if (check.ok) {
      summary.push(`✓ ${ref} is installed and verifies.`);
    } else {
      summary.push(
        `${ref} is installed but does not verify:`,
        ...check.problems.map((p) => `  - ${p}`)
      );
      const replace = await ui.confirm(
        'Laya',
        `Reinstall ${ref} over the broken copy? Download ${formatBytes(offer.bytes)}.`
      );
      if (!replace) return stop(summary, 'Stopped: the broken install was left as it is.');
      const result = await installSteps(deps, ui, offer, true, summary);
      if (typeof result === 'string') return result;
    }
  } else {
    const go = await ui.confirm(
      'Laya',
      `Download and install ${ref} (${LAYA_BACKEND}, ${formatBytes(offer.bytes)}, ${offer.files} file(s)) into ${target}/ ?`
    );
    if (!go) return stop(summary, 'Stopped: nothing was downloaded.');
    const result = await installSteps(deps, ui, offer, false, summary);
    if (typeof result === 'string') return result;
  }

  const runtime = deps.verifyRuntime({
    dir: deps.runtimeDir,
    specDir: deps.runtimeSpecDir,
    platform: deps.platform,
    arch: deps.arch,
  });
  if (!runtime.ok) {
    const install = await ui.confirm(
      'Laya',
      `Install the ONNX runtime now? It is ${RUNTIME_SIZE_TEXT}, once. It runs npm ci on the lockfile the router ships, with no install scripts.`
    );
    if (!install) {
      return stop(
        summary,
        'Stopped before the config: the ONNX runtime is not installed, so the sidecar cannot serve the model. Run /router laya install again to continue.'
      );
    }
    try {
      ui.notify('Installing the ONNX runtime …', 'info');
      await deps.installRuntime({
        dir: deps.runtimeDir,
        specDir: deps.runtimeSpecDir,
        platform: deps.platform,
        arch: deps.arch,
      });
      summary.push('✓ ONNX runtime installed.');
    } catch (err) {
      return stop(summary, `The ONNX runtime install failed: ${errorText(err)}`);
    }
  } else {
    summary.push('✓ ONNX runtime is installed.');
  }

  const block = mergeLayaBlock(deps.readLayaBlock(), ref);
  const write = await ui.confirm(
    'Laya',
    `Write this integrations.laya block to your user config?\n${JSON.stringify(block, null, 2)}`
  );
  if (!write) {
    return stop(summary, 'Config not written. Run /router laya install again to write it.');
  }
  const saved = deps.writeLayaBlock(block);
  if (!saved.ok) {
    return [
      ...summary,
      '',
      saved.error,
      '',
      'The model and the runtime are installed; only the config is missing. Fix the user config and run /router laya install again.',
    ].join('\n');
  }
  return [
    ...summary,
    '',
    `Saved to ${saved.written}.`,
    '',
    `Laya is set up: ${ref} in ${configText(block.mode, '')} mode (the answer is logged; the route does not change).`,
    'Start the sidecar in your own terminal:',
    `  ${serveCommand(ref)}`,
    `Then check its identity: curl -s ${configText(block.endpoint, '')}/health — artifact_sha256 must be ${offer.artifactSha256}.`,
  ].join('\n');
}

/**
 * Download, then verify. Returns a string when the wizard must stop (the message
 * is the final answer), or undefined when the install is good and the wizard continues.
 */
async function installSteps(
  deps: LayaInstallDeps,
  ui: LayaUi,
  offer: LayaOffer,
  force: boolean,
  summary: string[]
): Promise<string | undefined> {
  const ref = `${offer.model}@${offer.version}`;
  const manifest = await deps.loadManifest();
  try {
    ui.notify(`Downloading ${ref} …`, 'info');
    const result = await deps.installModel({
      manifest,
      model: offer.model,
      version: offer.version,
      backend: LAYA_BACKEND,
      root: deps.root,
      force,
    });
    summary.push(`✓ ${ref} downloaded (${formatBytes(offer.bytes)}) into ${result.dir}.`);
  } catch (err) {
    return stop(summary, `Install failed (${layaErrorCode(err)}): ${errorText(err)}`);
  }
  const check = await deps.verifyInstall({
    root: deps.root,
    model: offer.model,
    version: offer.version,
  });
  if (!check.ok) {
    return stop(
      summary,
      [
        'The download does not verify; no config was written:',
        ...check.problems.map((p) => `  - ${p}`),
      ].join('\n')
    );
  }
  summary.push(`✓ ${ref} verifies (artifact ${offer.artifactSha256.slice(0, 12)}…).`);
  return undefined;
}

function layaErrorCode(err: unknown): string {
  return err instanceof LayaInstallError ? err.code : 'error';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The real dependencies, for the /router handler. */
export function defaultLayaInstallDeps(io: {
  readLayaBlock: () => Record<string, unknown> | undefined;
  writeLayaBlock: (block: Record<string, unknown>) => WriteResult;
  /** Where the pid and log of the sidecar live (`PI_ROUTER_STATE_DIR`). */
  stateDir: string;
  supervisor: SupervisorDeps;
  /** Short local probe of the sidecar's /health; null when it does not answer. */
  health: () => Promise<{ artifact_sha256?: string } | null>;
}): LayaInstallDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    root: defaultModelsRoot(),
    runtimeDir: defaultRuntimeDir(),
    runtimeSpecDir: shippedRuntimeSpecDir(),
    loadManifest: () => loadManifest(shippedManifestPath()),
    listInstalls: (root) => listInstalls(root),
    verifyInstall: (opts) => verifyInstall(opts),
    installModel: (opts) => installModel({ ...opts, allowUnpublished: false }),
    verifyRuntime: (target) => verifyRuntime(target),
    installRuntime: (target) => installRuntime(target),
    readLayaBlock: io.readLayaBlock,
    writeLayaBlock: io.writeLayaBlock,
    stateDir: io.stateDir,
    supervisor: io.supervisor,
    health: io.health,
  };
}
