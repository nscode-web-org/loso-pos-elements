// A tiny static server for the demo, so `npm run demo` needs no extra dependency.
//
// It serves the repository root — the demo page at /demo/index.html reaches the built
// bundle at ../dist and the SDK at ../node_modules, so both must be under the served root.
// Assumes `npm run build` has produced dist/ (the demo script runs it first).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const port = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
    if (pathname === '/' || pathname === '/demo' || pathname === '/demo/') pathname = '/demo/index.html';

    // Contain the path to the served root — no `..` escape out of the repo.
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`\n  loso-pos-elements demo → http://localhost:${port}/demo/\n`);
});
