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

describe('/router command description', () => {
  const description = routerDescription();

  it('is registered with a description', () => {
    expect(description).toMatch(/Usage: \/router/);
  });

  it.each([
    ['classifier [days]', 'classifier [days]'],
    ['config compaction on|off', 'compaction on|off'],
    ['config integration <name> on|off|<mode>', 'integration <name> on|off|<mode>'],
    ['config exclude', 'exclude'],
    ['blocklist clear', 'blocklist [clear [ref]]'],
  ])('names the %s subcommand', (_label, needle) => {
    expect(description).toContain(needle);
  });
});
