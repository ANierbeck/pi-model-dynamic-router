// Shared set-up for tests that drive the real `/router` command handler
// (createCommands) against a minimal runtime stub. Before this helper the
// same stub — a registerCommand that captures the `router` definition plus
// load/sessionCtx/router/cfg/cache — was spelled out per file.

import { createCommands } from '../../src/commands.ts';

/** The `/router` command definition Pi receives from registerCommand. */
export interface RouterCommandDef {
  handler: (args: string, ctx: any) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
  description?: string;
}

/**
 * Register the commands against a minimal runtime and return the `/router`
 * definition. `overrides` replaces or adds runtime fields (cache,
 * cacheManager, lookupPrice, ...).
 */
export function registerRouterCommand(overrides: Record<string, unknown> = {}): RouterCommandDef {
  let def: RouterCommandDef | undefined;
  const rt: any = {
    pi: {
      registerCommand: (name: string, d: RouterCommandDef) => {
        if (name === 'router') def = d;
      },
    },
    load: () => {},
    sessionCtx: undefined,
    router: { setSessionCtx: () => {} },
    cfg: { model_groups: {} },
    cache: {},
    ...overrides,
  };
  createCommands(rt);
  if (!def) throw new Error('createCommands registered no /router command');
  return def;
}

/** Run `/router <args>` and collect what it notified. */
export async function runRouterCommand(
  def: RouterCommandDef,
  args: string,
  ctx: Record<string, unknown> = {}
): Promise<string[]> {
  const notes: string[] = [];
  await def.handler(args, { ui: { notify: (m: string) => notes.push(m) }, ...ctx });
  return notes;
}
