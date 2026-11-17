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
import { join, normalize, sep } from 'node:path';

const dir = process.argv[2];
const port = Number(process.argv[3] ?? 8899);
if (!dir) {
  console.error('usage: asset-server.mjs <dir> [port]');
  process.exit(2);
}

const server = createServer((req, res) => {
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
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(size),
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(path).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`asset-server: serving ${dir} on http://127.0.0.1:${port}/`);
});
