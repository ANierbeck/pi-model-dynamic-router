// test/sandbox-scripts.test.ts
//
// Regression pins for sandbox/pi-router (the container used to try the router
// against a pinned pi). The scripts themselves need Docker, so what is pinned
// here is the part that broke, in the way it broke:
//
//  - the test asset server answered 200 for a Range request, so every resumed
//    Laya download started over;
//  - run.sh mutated Docker state before honouring --dry-run and before checking
//    whether a session was already running;
//  - `--fresh` swallowed a failed volume removal and ran on old data;
//  - the entrypoint reported a different key list than run.sh forwarded;
//  - the image user had a fixed UID, so a bind-mounted workspace was not
//    writable for the account that owned it.
//
// The shell assertions read the scripts; they are coarse on purpose, but each
// one fails against the version of the file that had the defect.

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseRange } from '../sandbox/pi-router/asset-server.mjs';

const dir = path.join(import.meta.dirname, '..', 'sandbox', 'pi-router');
const read = (name: string): string => fs.readFileSync(path.join(dir, name), 'utf-8');

describe('the test asset server answers Range requests', () => {
  // This is what the installer asks for when it resumes: `bytes=<offset>-`.
  it('serves the tail from an offset instead of restarting the file', () => {
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    // Clamped: a client may ask past the end and still gets a valid range.
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
  });

  it('understands the suffix form and rejects what it cannot serve', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    // No header (or a form it does not implement) means the whole file.
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('items=0-5', 100)).toBeNull();
  });

  it('writes 206 with a Content-Range, not 200', () => {
    const src = read('asset-server.mjs');
    expect(src).toMatch(/206/);
    expect(src).toMatch(/content-range/i);
    expect(src).toMatch(/accept-ranges/i);
  });
});

describe('run.sh changes no Docker state it did not announce', () => {
  const src = read('run.sh');

  it('checks for a running session before removing a container', () => {
    const guard = src.indexOf('grep -qx "$CONTAINER_NAME"');
    const remove = src.indexOf(`docker rm "$CONTAINER_NAME"`);
    expect(guard).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(guard);
    // `docker rm -f` would stop a session that is in use (the comment above it
    // quotes the old form, so only an actual command line counts).
    expect(src).not.toMatch(/^\s*docker rm -f/m);
  });

  it('treats a dry run as a report: the run happens only after the exit', () => {
    const dryExit = src.lastIndexOf('dry run:');
    expect(dryExit).toBeGreaterThan(-1);
    expect(src.indexOf('"${cmd[@]}"', dryExit)).toBeGreaterThan(dryExit);
    // The volume and container mutations must be behind that exit.
    expect(src.indexOf('docker volume rm')).toBeLessThan(dryExit);
    expect(src.indexOf(`docker rm "$CONTAINER_NAME"`)).toBeLessThan(dryExit);
  });

  it('stops when --fresh cannot remove the volume', () => {
    const fresh = src.slice(src.indexOf('if [ "$fresh" -eq 1 ]'));
    expect(fresh).toMatch(/docker volume rm/);
    expect(fresh).toMatch(/exit 1/);
    // The old code hid the failure with `|| true`.
    expect(fresh.slice(0, fresh.indexOf('fi\nfi') + 1)).not.toMatch(/volume rm [^\n]*\|\| true/);
  });

  it('mounts the project state into the volume instead of the workspace', () => {
    expect(src).toMatch(/\/workspace\/\.pi/);
    expect(src).toMatch(/PROJECT_VOLUME/);
  });
});

describe('the entrypoint and run.sh agree on the key list', () => {
  const vars = read('provider-vars.txt')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

  it('lists the provider variables once, for both scripts', () => {
    expect(vars.length).toBeGreaterThan(10);
    expect(new Set(vars).size).toBe(vars.length);
    expect(read('run.sh')).toMatch(/provider-vars\.txt/);
    expect(read('entrypoint.sh')).toMatch(/provider-vars\.txt/);
    // Neither script may keep its own list again.
    expect(read('run.sh')).not.toMatch(/PROVIDER_VARS=\(\s*\n\s*ANTHROPIC_API_KEY/);
    expect(read('entrypoint.sh')).not.toMatch(/for var in ANTHROPIC_API_KEY/);
  });

  it('ships the list into the image', () => {
    expect(read('Dockerfile')).toMatch(/provider-vars\.txt/);
    expect(read('build-context.sh')).toMatch(/provider-vars\.txt/);
  });
});

describe('the image user matches the account that runs it', () => {
  it('is built with the host ids', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/ARG PI_UID/);
    expect(dockerfile).toMatch(/useradd[^\n]*-u "\$PI_UID"/);
    expect(read('build-context.sh')).toMatch(/PI_UID=\$\(id -u\)/);
    expect(read('run.sh')).toMatch(/pi\.uid/);
  });
});

describe('the entrypoint leaves no half-written file behind', () => {
  it('writes settings and the seeded config through a rename', () => {
    const src = read('entrypoint.sh');
    expect(src).toMatch(/mv "\$SETTINGS\.tmp" "\$SETTINGS"/);
    expect(src).toMatch(/mv "\$SEED_TARGET\.tmp" "\$SEED_TARGET"/);
    expect(src).not.toMatch(/cat > "\$SETTINGS" <</);
  });
});

describe('build-context.sh uses a private context', () => {
  it('packs into a fresh temporary directory', () => {
    const src = read('build-context.sh');
    expect(src).toMatch(/mktemp -d/);
    expect(src).toMatch(/trap 'rm -rf "\$CONTEXT"' EXIT/);
    expect(src).not.toMatch(/CONTEXT="\$HERE\/context"/);
  });
});
