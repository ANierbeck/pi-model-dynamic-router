// Plan step 7: the sidecar reads an install directory and never downloads (ADR-0021 rule for the
// router, applied here too). Static check on the sidecar's own code, plus a runtime check that an
// incomplete directory is refused before the runtime loads anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const OWN_SOURCES = ['identity.ts', 'classify.ts', 'server.ts'];

test("the sidecar's own code has no network calls and no Hugging Face fallback", () => {
  for (const f of OWN_SOURCES) {
    const text = readFileSync(join(pkg, 'src', f), 'utf8');
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${f} calls fetch`);
    assert.doesNotMatch(text, /huggingface/i, `${f} names huggingface`);
    // Listening (node:http createServer) is allowed; outbound modules and calls are not.
    assert.doesNotMatch(
      text,
      /from ['"]node:(https|net|tls|dns|dgram)['"]/,
      `${f} imports an outbound network module`
    );
    assert.doesNotMatch(text, /\bhttp\.(request|get)\s*\(/, `${f} makes an outbound http call`);
  }
});

test('an incomplete model directory is refused before anything is loaded or downloaded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'incomplete-'));
  writeFileSync(
    join(dir, 'head.json'),
    JSON.stringify({ instructions: 'x', categories: ['simple'] })
  );
  const r = spawnSync(
    process.execPath,
    [
      join(pkg, 'dist', 'server.js'),
      '--model-dir',
      dir,
      '--head-json',
      join(dir, 'head.json'),
      '--port',
      '18999',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GLOBAL_AGENT_HTTPS_PROXY: 'http://127.0.0.1:9' },
      timeout: 60_000,
    }
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /incomplete: encoder\.onnx missing \(nothing is downloaded\)/);
});

test('a server without any head refuses to start instead of serving a built-in prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nohead-'));
  const r = spawnSync(
    process.execPath,
    [join(pkg, 'dist', 'server.js'), '--model-dir', dir, '--port', '18998'],
    {
      encoding: 'utf8',
      timeout: 60_000,
    }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no head/);
});
