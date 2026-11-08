// src/laya-model-manifest.ts
//
// The Laya model manifest: which model versions a router release was verified
// against, and the exact files (size + sha256) of every backend artifact set
// (docs/plans/2026-11-08-laya-model-artifact.md, Solution 1).
//
// The manifest is the contract, the release assets are the payload. Checksums
// detect corruption and mix-ups; they are NOT a signature — whoever can change
// the manifest can change the hashes.
//
// Dependency-free on purpose (node:crypto only, no router imports): the
// pi-laya-model installer bundles this module and must run without Pi.

import { createHash } from 'node:crypto';

export const MANIFEST_SCHEMA_VERSION = 1;

/** Backends an artifact set can target (owner decision 3 of the plan). */
export const LAYA_BACKENDS = ['onnx', 'mlx'] as const;
export type LayaBackend = (typeof LAYA_BACKENDS)[number];

/**
 * Where the trained head lives inside an artifact set:
 * - `head-json`: `{ "instructions": str, "categories": [str] }` (ONNX export);
 * - `laya-questions`: the `questions.json` of a laya-train checkpoint
 *   (`{ "category": { "instructions": str, "criteria": [str] } }`).
 */
export const HEAD_FILE_FORMATS = ['head-json', 'laya-questions'] as const;
export type HeadFileFormat = (typeof HEAD_FILE_FORMATS)[number];

/** The name the installer writes its own install record under. */
export const INSTALL_RECORD = 'manifest.json';

export interface LayaHead {
  instructions: string;
  /** The trained choice-head order: choice index → category by position. */
  categories: string[];
}

export interface LayaArtifactFile {
  /** Relative POSIX path inside the install directory. */
  path: string;
  /** Release asset name (flat; GitHub assets have no directories). */
  asset: string;
  bytes: number;
  /** Lower-case hex sha256 of the file. */
  sha256: string;
}

export interface LayaArtifactSet {
  head_file: { path: string; format: HeadFileFormat };
  files: LayaArtifactFile[];
}

export interface LayaModelVersion {
  model: string;
  version: string;
  /** Git tag of the release that carries the assets (`laya-<model>-v<version>`). */
  tag: string;
  /** False until the release assets exist; the installer refuses unpublished versions by default. */
  published: boolean;
  /** Asset base URL, ending in `/`; an asset URL is `base_url + asset`. */
  base_url: string;
  head: { sha256: string; categories: string[] };
  backends: Partial<Record<LayaBackend, LayaArtifactSet>>;
}

export interface LayaManifest {
  schema_version: number;
  models: LayaModelVersion[];
}

/**
 * The head hash: sha256 over the compact JSON `{"instructions":…,"categories":[…]}`
 * (keys in this order, no whitespace). The sidecar reports the same value in
 * `/health`, so router and sidecar can compare heads without shipping the text.
 */
export function headSha256(head: LayaHead): string {
  const canonical = JSON.stringify({
    instructions: head.instructions,
    categories: head.categories,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Fingerprint of an artifact set: sha256 over one `<sha256>  <path>\n` line
 * per file (the `sha256sum` line format), sorted by path. Cheap to report —
 * a sidecar computes it from the install record without re-reading 1.3 GB —
 * and it changes with every file hash or path, not with asset names. It
 * fingerprints what the record CLAIMS; `pi-laya-model verify` checks that
 * the bytes still match.
 */
export function artifactSha256(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .join('');
  return createHash('sha256').update(lines, 'utf8').digest('hex');
}

/** Parses a head file of the given format; null when it is not a readable head. */
export function headFromFile(format: HeadFileFormat, text: string): LayaHead | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  let src: unknown = raw;
  if (format === 'laya-questions') {
    const category = isObject(raw) ? raw.category : undefined;
    src = isObject(category)
      ? { instructions: category.instructions, categories: category.criteria }
      : undefined;
  }
  if (!isObject(src)) return null;
  const { instructions, categories } = src;
  if (typeof instructions !== 'string' || !isStringArray(categories) || categories.length === 0) {
    return null;
  }
  return { instructions, categories: [...categories] };
}

/**
 * The parity gate: every model in the manifest must have been trained on
 * exactly the head the router builds. Returns one problem per offending
 * model version; empty means every model matches.
 */
export function checkHeadParity(manifest: LayaManifest, codeHead: LayaHead): string[] {
  const want = headSha256(codeHead);
  const problems: string[] = [];
  for (const m of manifest.models) {
    const id = `${m.model}@${m.version}`;
    if (m.head.sha256 !== want) {
      problems.push(`${id}: head sha256 ${m.head.sha256} ≠ the router's head ${want}`);
    } else if (JSON.stringify(m.head.categories) !== JSON.stringify(codeHead.categories)) {
      problems.push(`${id}: head categories ${m.head.categories.join(',')} disagree with its hash`);
    }
  }
  return problems;
}

/** A model or version name: one safe path segment. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** One segment of a relative artifact path (no `.`/`..`, no hidden files). */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSafeName(name: unknown): name is string {
  return typeof name === 'string' && SAFE_NAME.test(name);
}

function isSafeRelativePath(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.split('/').every((s) => SAFE_SEGMENT.test(s));
}

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/** https anywhere; file: and plain http only for local testing (http only on loopback). */
function baseUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'base_url must be a string';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `base_url ${JSON.stringify(raw)} is not a URL`;
  }
  if (!raw.endsWith('/')) return `base_url ${JSON.stringify(raw)} must end with '/'`;
  if (u.protocol === 'https:' || u.protocol === 'file:') return null;
  if (u.protocol === 'http:' && LOOPBACK.test(u.hostname)) return null;
  return `base_url ${JSON.stringify(raw)}: only https (or file:/loopback http for testing)`;
}

/**
 * Validates a parsed manifest. Never throws: returns every problem found, so
 * a broken manifest is reported in one pass. Empty array = valid.
 */
export function validateManifest(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(raw)) return ['manifest is not an object'];
  if (raw.schema_version !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    errors.push('models must be a non-empty array');
    return errors;
  }
  const seen = new Set<string>();
  raw.models.forEach((m: unknown, i: number) => {
    if (!isObject(m)) {
      errors.push(`models[${i}] is not an object`);
      return;
    }
    const id = `${String(m.model)}@${String(m.version)}`;
    const at = `models[${i}] (${id})`;
    if (!isSafeName(m.model)) errors.push(`${at}: model must be a safe name`);
    if (!isSafeName(m.version)) errors.push(`${at}: version must be a safe name`);
    if (seen.has(id)) errors.push(`${at}: duplicate model@version`);
    seen.add(id);
    if (typeof m.tag !== 'string' || m.tag.length === 0) errors.push(`${at}: tag is required`);
    if (typeof m.published !== 'boolean') errors.push(`${at}: published must be a boolean`);
    const urlProblem = baseUrlProblem(m.base_url);
    if (urlProblem) errors.push(`${at}: ${urlProblem}`);
    const head = m.head;
    if (
      !isObject(head) ||
      typeof head.sha256 !== 'string' ||
      !SHA256_HEX.test(head.sha256) ||
      !isStringArray(head.categories) ||
      head.categories.length === 0
    ) {
      errors.push(`${at}: head needs a sha256 and a non-empty categories list`);
    }
    errors.push(...validateBackends(m.backends, at));
  });
  return errors;
}

function validateBackends(raw: unknown, at: string): string[] {
  if (!isObject(raw) || Object.keys(raw).length === 0) return [`${at}: no backend`];
  const errors: string[] = [];
  /** Asset name → identity, across all backends of one model version. */
  const assets = new Map<string, string>();
  for (const [name, set] of Object.entries(raw)) {
    const where = `${at} backend ${name}`;
    if (!(LAYA_BACKENDS as readonly string[]).includes(name)) {
      errors.push(`${where}: unknown backend (known: ${LAYA_BACKENDS.join(', ')})`);
      continue;
    }
    if (!isObject(set) || !Array.isArray(set.files) || set.files.length === 0) {
      errors.push(`${where}: files must be a non-empty array`);
      continue;
    }
    const paths = new Set<string>();
    set.files.forEach((f: unknown, j: number) => {
      const fat = `${where} files[${j}]`;
      if (!isObject(f)) {
        errors.push(`${fat}: not an object`);
        return;
      }
      if (!isSafeRelativePath(f.path)) {
        errors.push(`${fat}: path ${JSON.stringify(f.path)} must be a safe relative path`);
      } else {
        // Case-insensitive: macOS and Windows file systems would merge them.
        const key = f.path.toLowerCase();
        if (key === INSTALL_RECORD) errors.push(`${fat}: path ${INSTALL_RECORD} is reserved`);
        if (paths.has(key)) errors.push(`${fat}: duplicate path ${f.path}`);
        paths.add(key);
      }
      if (typeof f.sha256 !== 'string' || !SHA256_HEX.test(f.sha256)) {
        errors.push(`${fat}: sha256 must be 64 lower-case hex digits`);
      }
      if (typeof f.bytes !== 'number' || !Number.isSafeInteger(f.bytes) || f.bytes <= 0) {
        errors.push(`${fat}: bytes must be a positive integer`);
      }
      if (typeof f.asset !== 'string' || !SAFE_SEGMENT.test(f.asset)) {
        errors.push(`${fat}: asset ${JSON.stringify(f.asset)} must be a flat file name`);
      } else {
        const identity = `${String(f.sha256)}:${String(f.bytes)}`;
        const prior = assets.get(f.asset);
        if (prior !== undefined && prior !== identity) {
          errors.push(`${fat}: asset ${f.asset} names two different files`);
        }
        assets.set(f.asset, identity);
      }
    });
    const hf = set.head_file;
    if (
      !isObject(hf) ||
      typeof hf.path !== 'string' ||
      !paths.has(hf.path.toLowerCase()) ||
      !(HEAD_FILE_FORMATS as readonly string[]).includes(String(hf.format))
    ) {
      errors.push(
        `${where}: head_file must name one of the files and a format (${HEAD_FILE_FORMATS.join(', ')})`
      );
    }
  }
  return errors;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
