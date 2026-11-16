// src/format.ts
//
// The three formatting helpers the Laya installer, the runtime installer and
// scripts/release-rehearsal.ts all need. Their own module, and deliberately
// plain: scripts run under Node's type stripping, which cannot load a module
// that uses TypeScript parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX),
// so the helpers cannot live next to the error classes that do.

/** Bytes as a short human string: one decimal below 10 MB, none above. */
export function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}

/** The message of an unknown thrown value. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The last `lines` lines of a command's output: the error, without the noise above it. */
export function tail(text: string, lines = 12): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}
