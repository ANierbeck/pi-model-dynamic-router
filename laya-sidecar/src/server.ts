#!/usr/bin/env node
// Laya sidecar: serves one installed model directory over the router's replay contract
//   POST /classify  {"prompt": "...", "context"?: {previousUserMessage?, lastAssistantSnippet?}}
//                   -> {"category", "confidence", "probabilities", "ms"}
//   GET  /health    -> identity fields plus the answering pid (see identity.ts)
// Listens on 127.0.0.1 only. Nothing is downloaded (plan step 7).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healthPayload, healthResponse, servedHead } from './identity.js';
import { openClassifier, type ClassifyContext } from './classify.js';
import { useRuntime } from './runtime.js';

export const DEFAULT_PORT = 8089;

export interface ServeOptions {
  modelDir: string;
  port: number;
  headJson: string | null;
  /**
   * Directory whose node_modules holds the ONNX runtime (`pi-laya-model runtime install`).
   * null: the runtime is resolved like any dependency, which is the development package.
   */
  runtimeDir: string | null;
}

export function parseArgs(argv: string[]): ServeOptions {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const modelDir = get('model-dir');
  if (!modelDir)
    throw new Error(
      'usage: laya-sidecar --model-dir <install dir> [--port 8089] [--head-json <file>] [--runtime-dir <dir>]'
    );
  const port = Number(get('port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`--port ${get('port')}: not a port`);
  return { modelDir, port, headJson: get('head-json'), runtimeDir: get('runtime-dir') };
}

/** Starts the sidecar; resolves with the listening server. */
export async function serve(args: ServeOptions): Promise<Server> {
  if (!existsSync(args.modelDir))
    throw new Error(`model directory ${args.modelDir} does not exist`);
  // Before the model: a missing runtime is the cheap problem, and no model file is read for it.
  if (args.runtimeDir) useRuntime(args.runtimeDir);
  const headText = args.headJson ? readFileSync(args.headJson, 'utf8') : null;
  const served = servedHead(args.modelDir, headText);
  if (!served) {
    throw new Error(
      'no head: pass --head-json or use a directory whose install record names a head file'
    );
  }
  const health = healthResponse(healthPayload(args.modelDir, served), process.pid);
  const classifier = await openClassifier(args.modelDir, served.head);

  // Reads the whole request body; resolves with the UTF-8 text at end of input.
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });

  const handleClassify = async (
    req: IncomingMessage,
    send: (code: number, body: string) => void
  ): Promise<void> => {
    try {
      const body = JSON.parse(await readBody(req)) as {
        prompt: unknown;
        context?: ClassifyContext | null;
      };
      if (typeof body.prompt !== 'string') return send(400, '{"error":"prompt must be a string"}');
      const out = await classifier.classify(body.prompt, body.context);
      send(200, JSON.stringify(out));
    } catch (e) {
      send(500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const server = createServer((req, res) => {
    const send = (code: number, body: string): void => {
      res.writeHead(code, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, health);
    if (req.method !== 'POST' || req.url !== '/classify') return send(404, '{"error":"not found"}');
    void handleClassify(req, send);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, '127.0.0.1', () => {
      console.log(`laya sidecar on 127.0.0.1:${args.port} (${served.source} head)`);
      resolve(server);
    });
  });
}

/**
 * Is this module the entry point? realpath first: an npm `bin` link is a symlink, and comparing
 * import.meta.url with the unresolved argv[1] made the sidecar exit 0 and serve nothing
 * (found 2026-11-16). scripts/lib/cli.ts has the same helper; the sidecar is its own build tree
 * and must not import from the router's src/.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return pathResolve(entry) === pathResolve(self);
  }
}

if (invokedDirectly()) {
  serve(parseArgs(process.argv.slice(2))).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
