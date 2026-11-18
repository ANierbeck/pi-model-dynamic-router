// /health carries the pid of the process that answers (Sourcery PR #190). The
// router's `/router laya stop` signals a recorded pid only when the sidecar that
// answers on the endpoint IS that pid; an answer alone proves only that some
// sidecar listens, and after a crash the recorded number may belong to an
// unrelated process. The pid is a process fact, not part of the install
// identity, so it is added next to healthPayload and leaves the cross-language
// identity parity (identity-parity.test.mjs) untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthResponse } from '../dist/identity.js';

test('the /health body adds the answering pid to the identity fields', () => {
  const body = JSON.parse(healthResponse({ status: 'ok', model: 'router' }, 4242));
  assert.deepEqual(body, { status: 'ok', model: 'router', pid: 4242 });
});

test('the pid is a JSON number, so the router can compare it without parsing text', () => {
  const body = JSON.parse(healthResponse({ status: 'ok' }, process.pid));
  assert.equal(typeof body.pid, 'number');
  assert.equal(body.pid, process.pid);
});
