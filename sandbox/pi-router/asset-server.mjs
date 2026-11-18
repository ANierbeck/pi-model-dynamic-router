// Static file server for a locally staged Laya release, so the installer can be
// exercised before the real release exists (plan
// docs/plans/2026-11-17-router-laya-install-command.md, test path).
//
//   node asset-server.mjs <dir> [port]     default port 8899
//
// Serves the directory flat, which is what a GitHub release looks like: no
// subdirectories, the asset name is the file name. Read-only and localhost-only;
// it never writes anything.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join, normalize, sep } from 'node:path';

// Filled in the main branch below; a plain empty string keeps the import side
// effect free (the test imports parseRange from this file).
let dir = '';

/**
 * `bytes=start-end` / `bytes=start-` / `bytes=-suffix`, per RFC 9110.
 * Returns null when the request asks for the whole file, and 'unsatisfiable'
 * when the range starts beyond the end.
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const length = Number(rawEnd);
    if (length === 0) return 'unsatisfiable';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'unsatisfiable';
  }
  return { start, end };
}

function handle(req, res) {
  const name = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/').replace(/^\/+/, '');
  // Reject anything that could escape the asset directory.
  const path = normalize(join(dir, name));
  if (name === '' || !path.startsWith(dir + sep)) {
    res.writeHead(404).end();
    return;
  }
  let size;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    res.writeHead(404).end();
    return;
  }
  // Range support is not a nicety here: the installer resumes an interrupted
  // download with `Range: bytes=<offset>-` and treats a 200 as "start over", so a
  // server that always answers 200 makes every retry restart the asset.
  const range = parseRange(req.headers.range, size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    return;
  }
  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
  };
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': String(range.end - range.start + 1),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(path, { start: range.start, end: range.end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': String(size) });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
}

// Only listen when started as a program: the test imports parseRange from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dir = process.argv[2] ?? '';
  const port = Number(process.argv[3] ?? 8899);
  if (!dir) {
    console.error('usage: asset-server.mjs <dir> [port]');
    process.exit(2);
  }
  const server = createServer(handle);
  server.listen(port, '127.0.0.1', () => {
    console.log(`asset-server: serving ${dir} on http://127.0.0.1:${port}/`);
  });
}
