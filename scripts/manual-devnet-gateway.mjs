import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildManualWalletPolicy, validateManualPublicRuntime } from './manual-devnet-contracts.mjs';
import { loadRpcSetCredential, selectHeliusEndpoint } from './devnet-rpc-set.mjs';

const MAX_BODY = 1024 * 1024;
const RPC_TIMEOUT_MS = 5_000;
const PROXY_TIMEOUT_MS = 60_000;
const RPC_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getFeeForMessage', 'getLatestBlockhash',
  'getMinimumBalanceForRentExemption', 'getSignatureStatuses', 'getTokenAccountsByOwner',
  'getTokenSupply', 'sendTransaction', 'simulateTransaction',
]);
const ISSUER_PATHS = new Set(['/v2/challenge', '/v2/verify', '/v2/access-token', '/v2/registration-stage']);

const parseCli = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || !argv[index + 1]) throw new Error('Gateway arguments must be --name value pairs');
    values[argv[index].slice(2)] = argv[index + 1];
  }
  for (const name of ['runtime', 'rpc-set-file', 'tls-key', 'tls-cert', 'faults', 'site-origin', 'issuer-origin', 'matrix-origin']) {
    if (!values[name]) throw new Error(`Missing --${name}`);
  }
  return values;
};

const readBody = (request, maximum = MAX_BODY) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > maximum) {
      reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => resolve(Buffer.concat(chunks)));
  request.on('error', reject);
});

const securityHeaders = (response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
};

const sendJson = (response, status, value) => {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  securityHeaders(response);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  response.end(body);
};

const safeTarget = (origin, requestUrl) => {
  const base = new URL(origin);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname)) {
    throw new Error('Gateway upstreams must be loopback HTTP');
  }
  const target = new URL(requestUrl, base);
  if (target.origin !== base.origin) throw new Error('Gateway requests may not change the loopback upstream origin');
  return target;
};

const copyHeaders = (headers, response) => {
  for (const [name, value] of Object.entries(headers)) {
    if (!value || ['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(name.toLowerCase())) continue;
    response.setHeader(name, value);
  }
};

const proxyLoopback = async (request, response, origin, { body, dropResponse = false } = {}) => {
  const target = safeTarget(origin, request.url);
  await new Promise((resolve, reject) => {
    const upstream = http.request(target, {
      method: request.method,
      headers: {
        ...request.headers,
        host: target.host,
        connection: 'close',
        ...(body ? { 'content-length': String(body.length) } : {}),
      },
      timeout: PROXY_TIMEOUT_MS,
    }, (upstreamResponse) => {
      const chunks = [];
      let size = 0;
      upstreamResponse.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          upstream.destroy(new Error('Upstream response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      upstreamResponse.on('end', () => {
        if (dropResponse && (upstreamResponse.statusCode ?? 500) < 300) {
          request.socket.destroy();
          resolve();
          return;
        }
        securityHeaders(response);
        copyHeaders(upstreamResponse.headers, response);
        const payload = Buffer.concat(chunks);
        response.writeHead(upstreamResponse.statusCode ?? 502, { 'Content-Length': String(payload.length) });
        response.end(payload);
        resolve();
      });
      upstreamResponse.on('error', reject);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Loopback upstream timed out')));
    upstream.on('error', reject);
    if (body) upstream.end(body);
    else request.pipe(upstream);
  });
};

const readFaults = async (file) => {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return { dropMatrixFinalResponseOnce: value.dropMatrixFinalResponseOnce === true };
  } catch {
    return { dropMatrixFinalResponseOnce: false };
  }
};

const writeFaults = async (file, value) => {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
};

const readCappedResponse = async (upstream, controller) => {
  const contentLength = Number(upstream.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY) {
    controller.abort();
    throw new Error('Upstream response is too large');
  }
  if (!upstream.body) throw new Error('Upstream response has no body');
  const reader = upstream.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      controller.abort();
      throw new Error('Upstream response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

const proxyRpc = async (request, response, endpoint) => {
  const body = await readBody(request);
  let input;
  try {
    input = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
    return;
  }
  if (
    !input || typeof input !== 'object' || Array.isArray(input)
    || input.jsonrpc !== '2.0' || !RPC_METHODS.has(input.method)
    || !Array.isArray(input.params)
  ) {
    sendJson(response, 403, { jsonrpc: '2.0', id: input?.id ?? null, error: { code: -32601, message: 'Method unavailable' } });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const upstream = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: controller.signal,
    });
    const payload = await readCappedResponse(upstream, controller);
    securityHeaders(response);
    response.writeHead(upstream.ok ? 200 : 502, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    response.end(payload);
  } catch {
    sendJson(response, 503, { jsonrpc: '2.0', id: input.id ?? null, error: { code: -32000, message: 'Devnet RPC unavailable' } });
  } finally {
    clearTimeout(timer);
  }
};

export async function createManualGateway(options) {
  const [key, cert, rpcSet] = await Promise.all([
    fs.readFile(path.resolve(options['tls-key'])),
    fs.readFile(path.resolve(options['tls-cert'])),
    loadRpcSetCredential(options['rpc-set-file']),
  ]);
  const helius = selectHeliusEndpoint(rpcSet);
  const runtimeFile = path.resolve(options.runtime);
  const faultsFile = path.resolve(options.faults);
  const server = https.createServer({ key, cert }, async (request, response) => {
    try {
      const pathname = new URL(request.url, 'https://localhost').pathname;
      if (pathname === '/_neal/devnet/health' && request.method === 'GET') {
        sendJson(response, 200, { schema: 'neal.devnet-manual-health/v1', status: 'ok' });
        return;
      }
      const runtime = validateManualPublicRuntime(JSON.parse(await fs.readFile(runtimeFile, 'utf8')));
      if (pathname === '/_neal/devnet/runtime' && request.method === 'GET') {
        sendJson(response, 200, runtime);
        return;
      }
      if (pathname === '/wallet-policy.json' && request.method === 'GET') {
        sendJson(response, 200, buildManualWalletPolicy(runtime));
        return;
      }
      if (pathname === '/_neal/devnet/public-messages' && request.method === 'GET') {
        sendJson(response, 200, { chunk: [] });
        return;
      }
      if (pathname === '/_neal/devnet/rpc' && request.method === 'POST') {
        await proxyRpc(request, response, helius);
        return;
      }
      if (ISSUER_PATHS.has(pathname) && ['POST', 'OPTIONS'].includes(request.method)) {
        const body = request.method === 'POST' ? await readBody(request, 32 * 1024) : undefined;
        await proxyLoopback(request, response, options['issuer-origin'], { body });
        return;
      }
      if (pathname.startsWith('/_matrix/client/')) {
        const body = ['POST', 'PUT'].includes(request.method) ? await readBody(request) : undefined;
        let dropResponse = false;
        if (pathname === '/_matrix/client/v3/register' && request.method === 'POST' && body) {
          const value = JSON.parse(body.toString('utf8'));
          const faults = await readFaults(faultsFile);
          if (value?.auth?.type === 'm.login.dummy' && faults.dropMatrixFinalResponseOnce) {
            dropResponse = true;
            await writeFaults(faultsFile, { dropMatrixFinalResponseOnce: false });
          }
        }
        await proxyLoopback(request, response, options['matrix-origin'], { body, dropResponse });
        return;
      }
      await proxyLoopback(request, response, options['site-origin']);
    } catch (error) {
      if (!response.headersSent) sendJson(response, error?.status ?? 502, { error: 'Local acceptance service unavailable' });
      else response.destroy();
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const server = await createManualGateway(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4280, '127.0.0.1', resolve);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => {
    console.error('Manual devnet gateway failed to start');
    process.exitCode = 1;
  });
}
