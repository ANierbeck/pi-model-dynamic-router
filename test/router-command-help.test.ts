// The /router command description is the one place a user sees the subcommand
// list (Pi's command palette). It must name every subcommand the handler
// accepts, otherwise the help silently drifts from the behaviour (docs sync
// 2026-11-14: `compaction on|off` was missing from the description).

import { describe, it, expect } from 'vitest';
import { createCommands } from '../src/commands.ts';

function routerDescription(): string {
  let description = '';
  const rt = {
    pi: {
      registerCommand: (_name: string, def: { description?: string }) => {
        description = def.description ?? '';
      },
    },
  };
  createCommands(rt as never);
  return description;
}

const description = routerDescription();

describe('/router command description', () => {
  it('is registered with a description', () => {
    expect(description).toMatch(/Usage: \/router/);
  });

  it.each(['classifier [days]', 'blocklist [clear [ref]]'])(
    'names the top-level %s subcommand',
    (entry) => {
      expect(description).toContain(`|${entry}|`);
    }
  );

  // The entries inside `config [a|b|…]`, so a name that only appears as a
  // top-level subcommand (`classifier [days]`) cannot satisfy the check.
  const configEntries = description.match(/\|config \[([^\]]+)\]/)?.[1].split('|') ?? [];

  it.each(['show', 'set', 'unset', 'classifier', 'integrations', 'exclude', 'compaction'])(
    'names the config %s subcommand',
    (name) => {
      expect(configEntries).toContain(name);
    }
  );
});

// One subcommand list drives the description, the completion list, the
// footer of the bare /router overview and the unknown-subcommand reply
// (owner report 2026-11-14: `/router rescan` silently showed the overview,
// and the overview footer named only 4 of the subcommands).
type Handler = (args: string, ctx: unknown) => Promise<void>;

function routerCommand(): {
  handler: Handler;
  complete: (prefix: string) => Array<{ value: string }> | null;
} {
  let def: { handler: Handler; getArgumentCompletions: (p: string) => never } | undefined;
  const rt = {
    pi: { registerCommand: (name: string, d: never) => name === 'router' && (def = d) },
    load: () => {},
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    cfg: { model_groups: { simple: { method: 'tiered' } } },
    cache: {},
    resolve: () => null,
    rateLimitManager: { getLimits: () => new Map() },
    isLimited: () => false,
    getTopModels: () => ({ models: [], total: 0 }),
    allDiscoveredRefs: () => [],
  };
  createCommands(rt as never);
  return { handler: def!.handler, complete: def!.getArgumentCompletions };
}

async function routerReply(args: string): Promise<string> {
  const notes: string[] = [];
  await routerCommand().handler(args, { ui: { notify: (m: string) => notes.push(m) } });
  return notes.join('\n');
}

const SUBCOMMANDS = [
  'scan',
  'cost',
  'classifier',
  'errors',
  'blocklist',
  'cooldowns',
  'fresh',
  'config',
];

describe('/router subcommand list', () => {
  it('an unknown subcommand is reported, with a suggestion, instead of showing the overview', async () => {
    const reply = await routerReply('rescan');
    expect(reply).toContain('Unknown /router subcommand "rescan"');
    expect(reply).toContain('did you mean "scan"');
    expect(reply).not.toContain('Model Router');
  });

  it('an unknown second word of a known subcommand is reported too', async () => {
    const reply = await routerReply('blocklist purge');
    expect(reply).toContain('Unknown /router subcommand "blocklist purge"');
  });

  it('a group name still shows the group', async () => {
    expect(await routerReply('simple')).toContain('simple | tiered');
  });

  it('the bare overview lists every subcommand', async () => {
    const reply = await routerReply('');
    expect(reply).toContain('Model Router');
    for (const sub of SUBCOMMANDS) expect(reply).toContain(`/router ${sub}`);
  });

  it('the completion list and the description name every subcommand', () => {
    const values = (routerCommand().complete('') ?? []).map((c) => c.value);
    for (const sub of SUBCOMMANDS) {
      expect(values).toContain(sub);
      expect(description).toContain(sub);
    }
  });
});

describe('/router config subcommands (config plan Phase 3)', () => {
  // Owner report 2026-11-15: nine config entries at two lines each made the
  // footer the longest part of the overview. The footer now names the
  // subcommands in ONE line under the single `/router config` entry; the
  // usage forms live in `/router config` itself (next test).
  it('the bare overview names the config subcommands in one line, not one entry each', async () => {
    const reply = await routerReply('');
    // Only the footer: the Integrations section names `/router config
    // integration laya on` as the switch, which is not a footer entry.
    const footer = reply.split('\n').slice(reply.split('\n').findIndex((l) => l === 'Commands:'));
    const configLines = footer.filter((line) => line.includes('/router config'));
    expect(configLines).toHaveLength(1);
    expect(configLines[0]).toMatch(/^\s*\/router config\s*$/);
    const names = footer.find((line) => line.includes('Subcommands:'));
    expect(names, 'no Subcommands: line').toBeDefined();
    // The parent is the entry above; repeating it here would read
    // "config · show · set · …".
    expect(names).toMatch(/Subcommands: show/);
    for (const name of [
      'show',
      'set',
      'unset',
      'classifier',
      'integrations',
      'exclude',
      'unexclude',
      'integration',
      'compaction',
    ]) {
      expect(names).toContain(name);
    }
    expect(reply).not.toContain('/router config set <path> <value>');
  });

  it('the completion list offers the config subcommands the usage names', () => {
    const values = routerCommand()
      .complete('config ')!
      .map((c) => c.value);
    for (const sub of ['config set', 'config unset', 'config classifier', 'config integrations']) {
      expect(values).toContain(sub);
    }
  });
});
