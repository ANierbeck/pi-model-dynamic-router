// SDK driver for router-shape-probe.ts (plan
// docs/plans/2026-11-21-virtual-models-migration.md, step 1). Runs every
// scenario against the installed Pi in-process, with an isolated agent dir
// (no user settings, no credentials), and prints one line per check.
//
//   node spikes/virtual-models/router-shape-run.ts
//
// Needs fake-server.mjs on $SPIKE_PORT (run-router-shape.sh starts it).
import { mkdirSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  resolveCliModel,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = join(here, 'router-shape-probe.ts');
const OUT = process.env.SPIKE_OUT ?? '/tmp/vm-spike';
const LOG = join(OUT, 'shape.jsonl');
const root = mkdtempSync(join(tmpdir(), 'vm-shape-'));
const cwd = join(root, 'project');
const agentDir = join(root, 'agent');
const sessionDir = join(root, 'sessions');
for (const d of [cwd, agentDir, sessionDir]) mkdirSync(d, { recursive: true });

const results: string[] = [];
function check(id: string, ok: boolean | null, what: string, detail: unknown = ''): void {
  const tag = ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL';
  const line = `${tag}  ${id.padEnd(5)} ${what}${detail === '' ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`;
  results.push(line);
  console.log(line);
}

let logOffset = 0;
const events: string[] = [];
/** Retry and compaction events since the last call. */
function newEvents(): string[] {
  return events.splice(0);
}
/** Probe rows written since the last call. */
function newRows(): any[] {
  if (!existsSync(LOG)) return [];
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const rows = lines.slice(logOffset).map((l) => JSON.parse(l));
  logOffset = lines.length;
  return rows;
}
const routes = (rows: any[]): any[] => rows.filter((r) => r.at === 'route');
const ref = (m: any): string | null => (m ? `${m.provider}/${m.id}` : null);

async function runtime(env: Record<string, string> = {}): Promise<any> {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 100 },
      // Small enough that a short spike session can be compacted.
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 20 },
      cacheWarming: 'off',
    } as any),
    resourceLoaderOptions: {
      noExtensions: true,
      additionalExtensionPaths: [PROBE],
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
    },
  });
}

async function open(services: any, sessionManager: any, model?: any): Promise<any> {
  const { session, modelFallbackMessage } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    tools: ['pin_group'],
  });
  await session.bindExtensions({});
  session.subscribe((ev: any) => {
    if (/retry|compaction/.test(ev.type))
      events.push(
        ev.type +
          (ev.reason ? `(${ev.reason})` : '') +
          ('willRetry' in ev ? ` willRetry=${ev.willRetry}` : '') +
          (ev.errorMessage ? ` err=${String(ev.errorMessage).slice(0, 160)}` : '')
      );
  });
  return { session, modelFallbackMessage };
}

function lastAssistant(session: any): any {
  const msgs = session.messages ?? session.agent.state.messages;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return msgs[i];
  return undefined;
}

/** Id of the latest assistant entry on the branch (a tree/fork target). */
function lastAssistantEntryId(session: any): string {
  const branch = session.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === 'message' && e.message.role === 'assistant') return e.id;
  }
  throw new Error('no assistant entry');
}

async function main(): Promise<void> {
  console.log(`# router-shape spike — work dir ${root}\n`);
  newRows();

  // ── A. Hidden group provider ────────────────────────────────────────────
  const services = await runtime();
  const mr = services.modelRuntime;
  const virtual = mr.getModel('router', 'dynamic');
  const snapshotGroups = mr.getAvailableSnapshot().filter((m: any) => m.provider === 'rgrp');
  check('A1', snapshotGroups.length === 0, 'groups absent from the first availability snapshot', snapshotGroups.map(ref));
  const refreshed = await mr.getAvailable();
  check('A2', !refreshed.some((m: any) => m.provider === 'rgrp'), 'groups absent after an availability refresh');
  check('A3', refreshed.some((m: any) => ref(m) === 'router/dynamic'), 'router/dynamic is available');
  check('A4', Boolean(mr.getModel('rgrp', 'planning')), 'getModel still finds a hidden group model (route() target, find())');
  check('A5', mr.hasConfiguredAuth('rgrp') === true, 'hidden group provider counts as configured (route() requires it)');
  const cliGroup = resolveCliModel({ cliModel: 'rgrp/code_complex', modelRuntime: mr });
  check('A6', null, '--model rgrp/code_complex (CLI and pi-subagents resolver, full catalog)', cliGroup.error ?? ref(cliGroup.model));
  const cliVirtual = resolveCliModel({ cliModel: 'router/dynamic', modelRuntime: mr });
  check('A7', ref(cliVirtual.model) === 'router/dynamic', '--model router/dynamic resolves', cliVirtual.error ?? '');
  const scope = await resolveModelScopeWithDiagnostics(['rgrp/*'], mr);
  check('A8', scope.scopedModels.length === 0, 'scoped models (enabledModels: rgrp/*) cannot pick a hidden group', scope.scopedModels.map((s: any) => ref(s.model)));

  // ── B. Two-layer turns in one persisted session ─────────────────────────
  const sm = SessionManager.create(cwd, sessionDir);
  const { session } = await open(services, sm, virtual);
  newRows();
  await session.prompt('please do planning');
  let rows = newRows();
  let r = routes(rows);
  check('B1', r.length === 1 && r[0].reason === 'user' && r[0].group === 'planning', 'user turn routes through route() to the planning group', r.map((x) => `${x.reason}:${x.group}`));
  check('B2', `${lastAssistant(session).provider}/${lastAssistant(session).model}` === 'spike/plan-c', 'assistant message names the physical model', `${lastAssistant(session).provider}/${lastAssistant(session).model}`);
  check('B3', ref(session.model) === 'router/dynamic', 'the selection stays router/dynamic after the turn', ref(session.model));
  const turnEnd = rows.find((x) => x.at === 'turn_end');
  check('B4', turnEnd?.selection === 'router/dynamic' && turnEnd?.served === 'spike/plan-c', 'turn_end: ctx.model is the selection, the message the served model (footer data)', turnEnd);
  const afterPlanning = lastAssistantEntryId(session);

  await session.prompt('HINT: code_complex refactor this');
  r = routes(newRows());
  check('B5', r[0]?.group === 'code_complex' && r[0]?.stateIn?.runGroup === 'planning', 'HINT: picks the group; state carries the previous run group', r.map((x) => ({ g: x.group, in: x.stateIn })));

  // ── C. pin_group (replacement of set_model_from_group) ──────────────────
  await session.prompt('CALL:pin_group:{"group":"planning"}');
  r = routes(newRows());
  const cont = r.find((x) => x.reason === 'continuation');
  check('C1', cont?.group === 'planning' && cont?.stateOut?.pin === 'planning', 'tool follow-up (continuation) applies the pin and stores it in the branch state', r.map((x) => `${x.reason}:${x.group}:${JSON.stringify(x.stateOut)}`));
  await session.prompt('just say hello');
  r = routes(newRows());
  check('C2', r[0]?.group === 'planning', 'the next user turn stays on the pinned group', r[0]?.group);
  await session.prompt('CALL:pin_group:{"group":"none"}');
  newRows();
  await session.prompt('just say hello again');
  r = routes(newRows());
  check('C3', r[0]?.group === 'simple' && r[0]?.stateIn?.pin === null, 'releasing the pin returns to classification', r.map((x) => ({ g: x.group, in: x.stateIn })));

  // ── D. Failures through the two layers ──────────────────────────────────
  await session.prompt('failing please');
  rows = newRows();
  r = routes(rows);
  const retry = r.find((x) => x.reason === 'retry');
  check('D1', null, 'router-built error naming the group model: does Pi retry, and what does route() get as failed?', r.map((x) => `${x.reason}:${x.group}${x.failed ? ` failed=${x.failed}` : ''}`));
  check('D2', null, 'last message after the failing turn', `${lastAssistant(session).provider}/${lastAssistant(session).model} ${lastAssistant(session).stopReason}`);
  void retry;
  check('D1e', null, 'events of the failing turn', newEvents());

  await session.prompt('failing429 please');
  r = routes(newRows());
  check('D1b', null, 'router-built error worded as a retryable 429: retry routes', r.map((x) => `${x.reason}:${x.group}${x.failed ? ` failed=${x.failed}` : ''}`));
  check('D1c', null, 'events and last message of that turn', { events: newEvents(), last: `${lastAssistant(session).provider}/${lastAssistant(session).model} ${lastAssistant(session).stopReason}` });

  await session.prompt('overflow please');
  rows = newRows();
  r = routes(rows);
  check('D3e', null, 'events of the overflow turn', newEvents());
  check('D3', null, 'context overflow on the physical model: compaction (direct) and retry routes', r.map((x) => `${x.reason}:${x.group}${x.failed ? ` failed=${x.failed}` : ''}`));
  check('D4', null, 'last message after the overflow turn', `${lastAssistant(session).provider}/${lastAssistant(session).model} ${lastAssistant(session).stopReason}`);

  const stalled = session.prompt('stall please');
  await new Promise((res) => setTimeout(res, 1500));
  await session.abort();
  await stalled.catch(() => undefined);
  rows = newRows();
  const aborted = lastAssistant(session);
  check('D5', aborted?.stopReason === 'aborted', 'abort during the stalled physical stream ends the turn as aborted', `${aborted?.provider}/${aborted?.model} ${aborted?.stopReason}`);
  check('D6', ref(session.model) === 'router/dynamic', 'the selection survives the abort', ref(session.model));
  await session.prompt('after the abort');
  r = routes(newRows());
  check('D7', r[0]?.reason === 'user', 'the next prompt routes normally', r.map((x) => `${x.reason}:${x.group} prev=${x.previous}`));

  // ── E. Stats, compaction, tree ──────────────────────────────────────────
  const stats = session.getSessionStats();
  check('E1', null, '/session stats under a virtual selection', { assistant: stats.assistantMessages, cost: stats.cost, tokens: stats.tokens.total });
  const beforeCompact = routes(newRows());
  void beforeCompact;
  try {
    await session.compact();
    r = routes(newRows());
    check('E2', r.some((x) => x.reason === 'direct' && x.group === 'simple'), 'manual compaction routes its summary as direct to the fixed group', r.map((x) => `${x.reason}:${x.group}`));
  } catch (err) {
    check('E2', false, 'manual compaction', String(err).slice(0, 200));
  }
  await session.prompt('after compaction');
  r = routes(newRows());
  check('E3', (r[0]?.stateIn?.turns ?? 0) > 1, 'route state survives compaction', r[0]?.stateIn);
  const stateAtLeaf = r[0]?.stateOut;

  await session.navigateTree(afterPlanning, { summarize: false } as any);
  await session.prompt('after tree navigation');
  r = routes(newRows());
  check('E4', r[0]?.stateIn?.turns === 1 && r[0]?.stateIn?.runGroup === 'planning', '/tree: route() sees the state of the branch it navigated to', r[0]?.stateIn);
  const sessionFile = session.sessionFile;
  const leafAfterTree = session.sessionManager.getLeafId();
  session.dispose();
  void stateAtLeaf;

  // ── F. Resume, fork, subagent-style children ────────────────────────────
  const s2 = await runtime();
  const resumed = await open(s2, SessionManager.open(sessionFile, sessionDir));
  rows = newRows();
  check('F1', ref(resumed.session.model) === 'router/dynamic', 'resume (--continue path) restores router/dynamic', ref(resumed.session.model) + (resumed.modelFallbackMessage ? ` (${resumed.modelFallbackMessage})` : ''));
  await resumed.session.prompt('after resume');
  r = routes(newRows());
  check('F2', r[0]?.stateIn?.turns === 2, 'resume: state comes from the restored branch (in-memory state would be empty)', r[0]?.stateIn);
  const resumedFile = resumed.session.sessionFile;
  resumed.session.dispose();

  const s3 = await runtime();
  const source = SessionManager.open(sessionFile, sessionDir);
  const forkFile = source.createBranchedSession(afterPlanning);
  const forked = await open(s3, SessionManager.open(forkFile!, sessionDir));
  newRows();
  check('F3', ref(forked.session.model) === 'router/dynamic', 'fork restores router/dynamic', ref(forked.session.model));
  await forked.session.prompt('in the fork');
  r = routes(newRows());
  check('F4', r[0]?.stateIn?.turns === 1, 'fork: state of the forked entry', r[0]?.stateIn);
  forked.session.dispose();

  // pi-subagents: fork the parent's branch, resolve the child model with
  // resolveCliModel, start the child headless with that model.
  const s4 = await runtime();
  const parentSource = SessionManager.open(resumedFile, sessionDir);
  const childFile = parentSource.createBranchedSession(parentSource.getLeafId()!);
  const childModel = resolveCliModel({ cliModel: 'router/dynamic', modelRuntime: s4.modelRuntime }).model;
  const child = await open(s4, SessionManager.open(childFile!, sessionDir), childModel);
  newRows();
  await child.session.prompt('child task');
  r = routes(newRows());
  check('F5', ref(child.session.model) === 'router/dynamic' && r.length > 0, 'subagent child on router/dynamic routes on its own (forked) branch', r.map((x) => ({ g: x.group, in: x.stateIn })));
  child.session.dispose();

  const s5 = await runtime();
  const delegated = resolveCliModel({ cliModel: 'rgrp/code_complex', modelRuntime: s5.modelRuntime }).model;
  const dchild = await open(s5, SessionManager.inMemory(cwd), delegated);
  rows = newRows();
  await dchild.session.prompt('delegated task');
  rows = newRows();
  check('F6', ref(dchild.session.model) === 'rgrp/code_complex' && rows.some((x) => x.at === 'group-stream' && x.group === 'code_complex'), 'delegation naming a hidden category group still reaches it', { model: ref(dchild.session.model), rows: rows.map((x) => x.at + ':' + (x.group ?? '')) });
  dchild.session.dispose();

  // Pre-migration session: the selection was a group model, not the virtual one.
  const s6 = await runtime();
  const oldSm = SessionManager.create(cwd, sessionDir);
  const old = await open(s6, oldSm, s6.modelRuntime.getModel('rgrp', 'code_complex'));
  await old.session.prompt('old style session');
  const oldFile = old.session.sessionFile;
  old.session.dispose();
  const s7 = await runtime();
  const oldResumed = await open(s7, SessionManager.open(oldFile, sessionDir));
  newRows();
  check('F7', null, 'resume of a pre-migration session whose selection is a (now hidden) group model', ref(oldResumed.session.model));
  oldResumed.session.dispose();

  // ── G. Re-registration at session_start (the router does it) ────────────
  const s8 = await runtime({ SPIKE_REREGISTER: '1' });
  const rr = await open(s8, SessionManager.inMemory(cwd), s8.modelRuntime.getModel('router', 'dynamic'));
  rows = newRows();
  check('G1', null, 'groups in the availability snapshot after a re-registration at session_start (tick 0, tick 1)', rows.filter((x) => x.at === 'after-reregister').map((x) => x.availableGroups));
  const snap = s8.modelRuntime.getAvailableSnapshot().filter((m: any) => m.provider === 'rgrp');
  check('G1b', snap.length === 0, 'snapshot after bindExtensions returned (what /model shows first)', snap.map(ref));
  await new Promise((res) => setTimeout(res, 500));
  const settled = s8.modelRuntime.getAvailableSnapshot().filter((m: any) => m.provider === 'rgrp');
  check('G1c', settled.length === 0, 'snapshot 500 ms later, without an explicit refresh (the queued refresh landed)', settled.map(ref));
  const later = (await s8.modelRuntime.getAvailable()).filter((m: any) => m.provider === 'rgrp');
  check('G2', later.length === 0, 'hidden again after the next availability refresh', later.map(ref));
  rr.session.dispose();
  process.env.SPIKE_REREGISTER = '0';

  console.log(`\nsessions: ${sessionDir}\nleaf after tree: ${leafAfterTree}`);
  const fails = results.filter((l) => l.startsWith('FAIL')).length;
  console.log(`\n${results.length} checks, ${fails} FAIL`);
  // Host-upgrade gate (AGENTS §10): a failed check must block the upgrade,
  // so the runner exits nonzero — the caller relies on the exit status.
  if (fails > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
