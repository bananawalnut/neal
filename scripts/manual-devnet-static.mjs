import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
]);

const parseCli = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1]) throw new Error('Static server arguments must be --name value pairs');
    values[argv[index].slice(2)] = argv[index + 1];
  }
  if (!values.root || !values.port) throw new Error('Static server requires --root and --port');
  return values;
};

const options = parseCli(process.argv.slice(2));
const root = path.resolve(options.root);
const port = Number(options.port);
if (!Number.isSafeInteger(port) || port !== 4281) throw new Error('Manual static server is restricted to port 4281');
const metadata = await fs.lstat(root);
if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Manual static root is unsafe');

const server = http.createServer(async (request, response) => {
  try {
    if (request.headers.host !== '127.0.0.1:4281' || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(request.headers.host === '127.0.0.1:4281' ? 405 : 421).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1:4281').pathname);
    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (relative.endsWith('/')) relative += 'index.html';
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    const targetMetadata = await fs.lstat(target);
    if (!targetMetadata.isFile() || targetMetadata.isSymbolicLink()) {
      response.writeHead(404).end();
      return;
    }
    const body = await fs.readFile(target);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
      'Content-Type': MIME.get(path.extname(target).toLowerCase()) ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
});

server.on('clientError', (_error, socket) => socket.destroy());
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
