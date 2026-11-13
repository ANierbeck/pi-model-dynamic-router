#!/usr/bin/env node
// Laya sidecar: serves one installed model directory over the router's replay contract
//   POST /classify  {"prompt": "...", "context"?: {previousUserMessage?, lastAssistantSnippet?}}
//                   -> {"category", "confidence", "probabilities", "ms"}
//   GET  /health    -> identity fields (see identity.ts)
// Listens on 127.0.0.1 only. Nothing is downloaded (plan step 7).
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { healthPayload, servedHead } from './identity.js';
import { openClassifier, type ClassifyContext } from './classify.js';

export const DEFAULT_PORT = 8089;

interface Args {
  modelDir: string;
  port: number;
  headJson: string | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const modelDir = get('model-dir');
  if (!modelDir)
    throw new Error(
      'usage: laya-sidecar --model-dir <install dir> [--port 8089] [--head-json <file>]'
    );
  const port = Number(get('port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`--port ${get('port')}: not a port`);
  return { modelDir, port, headJson: get('head-json') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.modelDir))
    throw new Error(`model directory ${args.modelDir} does not exist`);
  const headText = args.headJson ? readFileSync(args.headJson, 'utf8') : null;
  const served = servedHead(args.modelDir, headText);
  if (!served) {
    throw new Error(
      'no head: pass --head-json or use a directory whose install record names a head file'
    );
  }
  const health = JSON.stringify(healthPayload(args.modelDir, served));
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
  server.listen(args.port, '127.0.0.1', () => {
    console.log(`laya sidecar on 127.0.0.1:${args.port} (${served.source} head)`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
