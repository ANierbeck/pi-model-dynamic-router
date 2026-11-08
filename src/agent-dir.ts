// src/agent-dir.ts
//
// Pi's agent directory, in a module of its own: the pi-laya-model installer
// needs it and must not bundle the config loader (which imports the router).

import * as path from 'node:path';
import { homedir } from 'node:os';

/**
 * Pi's agent directory: follows Pi's own PI_CODING_AGENT_DIR (e.g. a separate
 * work profile in ~/.pi-work/agent) and defaults to ~/.pi/agent. A leading ~
 * is expanded like Pi's getAgentDir() does, because node:fs never expands it
 * and a value set without a shell (.env file, programmatic setter) would
 * otherwise silently hide Pi's auth file and the user config. Resolved per
 * call so a profile switch or a test stub is always observed.
 */
export function piAgentDir(): string {
  const dir = process.env.PI_CODING_AGENT_DIR;
  if (!dir) return path.join(homedir(), '.pi', 'agent');
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return path.join(homedir(), dir.slice(2));
  return dir;
}
