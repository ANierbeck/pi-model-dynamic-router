// GET /health payload of the sidecar. TypeScript mirror of spikes/laya-http/identity.py,
// which is the specification (plan docs/plans/2026-11-08-laya-model-artifact.md, solution 5).
// Both hashes must equal the Python output byte for byte; test/identity-parity.test.mjs pins it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const INSTALL_RECORD = 'manifest.json';

export interface Head {
  instructions: string;
  categories: string[];
}

export interface InstallRecord {
  schema_version: 1;
  model?: unknown;
  version?: unknown;
  backend?: unknown;
  files: { path: string; sha256: string }[];
  head_file: { path: string; format: string };
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 of the canonical JSON {instructions, categories}; equals Python's json.dumps(separators=(",",":"), ensure_ascii=False). */
export function headSha256(head: Head): string {
  return sha256(JSON.stringify({ instructions: head.instructions, categories: head.categories }));
}

/** sha256 of one `sha256  path` line per file, sorted by path (paths are ASCII by the manifest's safe-path rule). */
export function artifactSha256(files: { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.sha256}  ${f.path}\n`)
    .join('');
  return sha256(lines);
}

/** Mirror of head_from_text in identity.py; null = not a readable head. */
export function headFromText(format: string, text: string): Head | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  let src: unknown = raw;
  if (format === 'laya-questions') {
    const cat = (raw as { category?: { instructions?: unknown; criteria?: unknown } } | null)
      ?.category;
    src =
      cat && typeof cat === 'object'
        ? { instructions: cat.instructions, categories: cat.criteria }
        : null;
  }
  if (!src || typeof src !== 'object') return null;
  const { instructions, categories } = src as { instructions?: unknown; categories?: unknown };
  if (typeof instructions !== 'string' || !Array.isArray(categories) || categories.length === 0)
    return null;
  if (!categories.every((c) => typeof c === 'string')) return null;
  return { instructions, categories: [...categories] };
}

/** The install record, or null when absent, unreadable or of another schema (mirror of read_record). */
export function readRecord(modelDir: string): InstallRecord | null {
  let rec: unknown;
  try {
    rec = JSON.parse(readFileSync(join(modelDir, INSTALL_RECORD), 'utf8'));
  } catch {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Partial<InstallRecord>;
  if (r.schema_version !== 1) return null;
  if (!Array.isArray(r.files) || !r.head_file || typeof r.head_file !== 'object') return null;
  return r as InstallRecord;
}

/**
 * The head the sidecar serves: --head-json wins, else the head file the install record names.
 * Returns null when neither exists. Unlike server.py the sidecar does not fall back to a built-in
 * prompt: serving a head the artifact was not trained on would hide a train/serve mismatch.
 */
export function servedHead(
  modelDir: string,
  headJsonText: string | null
): { head: Head; source: 'head-json' | 'record' } | null {
  if (headJsonText !== null) {
    const head = headFromText('head-json', headJsonText);
    if (!head) throw new Error('--head-json: not a head ({instructions, categories})');
    return { head, source: 'head-json' };
  }
  const rec = readRecord(modelDir);
  if (!rec) return null;
  // Defence in depth, mirroring the installer's `inside()` check: the record
  // is written only by the hash-verifying installer, but a head_file.path that
  // leaves the install directory is refused like an unreadable file.
  const modelRoot = resolve(modelDir);
  const headPath = resolve(modelDir, String(rec.head_file.path));
  if (!headPath.startsWith(modelRoot + sep)) return null;
  let text: string;
  try {
    text = readFileSync(headPath, 'utf8');
  } catch {
    return null;
  }
  const head = headFromText(String(rec.head_file.format), text);
  return head ? { head, source: 'record' } : null;
}

/**
 * The GET /health body: the identity fields plus the pid of the answering
 * process. The router's `/router laya stop` signals a recorded pid only when the
 * sidecar that answers is that pid — an answer alone proves only that SOME
 * sidecar listens, and after a crash the recorded number may belong to an
 * unrelated process. The pid is a process fact, not part of the install
 * identity, so it stays out of healthPayload and its identity.py parity.
 */
export function healthResponse(payload: Record<string, string>, pid: number): string {
  return JSON.stringify({ ...payload, pid });
}

/** Same field set and order rules as health_payload in identity.py. */
export function healthPayload(
  modelDir: string,
  served: { head: Head; source: string } | null
): Record<string, string> {
  const out: Record<string, string> = { status: 'ok' };
  const rec = readRecord(modelDir);
  if (rec) {
    for (const key of ['model', 'version', 'backend'] as const) {
      const v = rec[key];
      if (typeof v === 'string') out[key] = v;
    }
    // identity.py skips the hash when a file entry is malformed; the router treats it as optional.
    const wellFormed = rec.files.every(
      (f) => typeof f?.path === 'string' && typeof f?.sha256 === 'string'
    );
    if (wellFormed) out.artifact_sha256 = artifactSha256(rec.files);
  }
  if (served) {
    out.head_sha256 = headSha256(served.head);
    out.served_head = served.source;
  }
  return out;
}
