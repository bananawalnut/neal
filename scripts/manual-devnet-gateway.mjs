import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  MANUAL_AMOUNT,
  MANUAL_LOCK_SECONDS,
  buildManualReadiness,
  buildManualWalletPolicy,
  validateManualPublicRuntime,
} from './manual-devnet-contracts.mjs';
import { establishDevnetAgreement, loadRpcSetCredential, rpcCall } from './devnet-rpc-set.mjs';

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
  for (const name of ['runtime', 'rpc-set-file', 'tls-key', 'tls-cert', 'faults', 'site-origin', 'issuer-origin', 'matrix-origin', 'issuer-image-id']) {
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

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

const quorumIdentity = (method, result) => {
  const contextual = new Set([
    'getAccountInfo', 'getBalance', 'getFeeForMessage', 'getLatestBlockhash',
    'getSignatureStatuses', 'getTokenAccountsByOwner', 'getTokenSupply', 'simulateTransaction',
  ]);
  let comparable = contextual.has(method) ? result?.value : result;
  if (method === 'getTokenAccountsByOwner' && Array.isArray(comparable)) {
    comparable = [...comparable].sort((left, right) => String(left?.pubkey ?? '').localeCompare(String(right?.pubkey ?? '')));
  }
  return JSON.stringify(stableValue(comparable));
};

const exactBrowserRequest = (request, runtime, expectedHost, { requireJson = false } = {}) => {
  if (request.headers.host !== expectedHost) throw Object.assign(new Error('Unexpected local host'), { status: 421 });
  if (request.headers.origin !== 'https://localhost:4280') throw Object.assign(new Error('Origin denied'), { status: 403 });
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') throw Object.assign(new Error('Cross-site request denied'), { status: 403 });
  if (request.headers['x-neal-request-nonce'] !== runtime.requestNonce) {
    throw Object.assign(new Error('Request nonce denied'), { status: 403 });
  }
  if (requireJson && !String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('JSON content type required'), { status: 415 });
  }
};

export const matrixRouteAllowed = (pathname, method, runtime) => {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return false; }
  const exact = new Set([
    'GET /_matrix/client/versions',
    'GET /_matrix/client/v3/login',
    'POST /_matrix/client/v3/login',
    'POST /_matrix/client/v3/logout',
    'POST /_matrix/client/v3/register',
    'GET /_matrix/client/v3/register/available',
    'GET /_matrix/client/v3/sync',
    'GET /_matrix/client/v3/account/whoami',
    'GET /_matrix/client/v3/joined_rooms',
    'GET /_matrix/client/v3/capabilities',
  ]);
  if (exact.has(`${method} ${decoded}`)) return true;
  const roomPrefix = `/_matrix/client/v3/rooms/${runtime.matrix.roomId}/`;
  if (decoded.startsWith(roomPrefix) && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return true;
  for (const action of ['join', 'knock']) {
    const prefix = `/_matrix/client/v3/${action}/`;
    if (decoded.startsWith(prefix)) {
      const target = decoded.slice(prefix.length);
      return ['POST', 'PUT'].includes(method)
        && [runtime.matrix.roomId, runtime.matrix.roomAlias].includes(target);
    }
  }
  const profilePrefix = '/_matrix/client/v3/profile/';
  if (method === 'GET' && decoded.startsWith(profilePrefix)) {
    return decoded.slice(profilePrefix.length).includes(`:${runtime.matrix.serverName}`);
  }
  const userFilter = decoded.match(/^\/_matrix\/client\/v3\/user\/([^/]+)\/filter(?:\/([^/]+))?$/u);
  if (userFilter) {
    const [, userId, filterId] = userFilter;
    if (!userId.startsWith('@') || !userId.endsWith(`:${runtime.matrix.serverName}`)) return false;
    if (filterId === undefined) return method === 'POST';
    return method === 'GET' && /^[A-Za-z0-9._~-]+$/u.test(filterId);
  }
  return false;
};

const cappedFetch = async (url, { timeoutMs = RPC_TIMEOUT_MS } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const payload = await readCappedResponse(response, controller);
    let body;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new Error('Loopback readiness response is malformed');
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
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

const proxyRpc = async (request, response, rpcSet, rpcRequest = rpcCall) => {
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
  try {
    const results = await Promise.all(rpcSet.endpoints.map(async (endpoint) => {
      try {
        const result = await rpcRequest(endpoint, input.method, input.params, RPC_TIMEOUT_MS);
        return { identity: quorumIdentity(input.method, result), result };
      } catch {
        return null;
      }
    }));
    const groups = new Map();
    for (const entry of results.filter(Boolean)) {
      const group = groups.get(entry.identity) ?? [];
      group.push(entry.result);
      groups.set(entry.identity, group);
    }
    const agreement = [...groups.values()].find((group) => group.length >= rpcSet.threshold);
    if (!agreement) throw new Error('RPC quorum unavailable');
    sendJson(response, 200, { jsonrpc: '2.0', id: input.id ?? null, result: agreement[0] });
  } catch {
    sendJson(response, 503, { jsonrpc: '2.0', id: input.id ?? null, error: { code: -32000, message: 'Devnet RPC unavailable' } });
  }
};

export async function createManualGateway(options) {
  const [key, cert, rpcSet] = await Promise.all([
    fs.readFile(path.resolve(options['tls-key'])),
    fs.readFile(path.resolve(options['tls-cert'])),
    loadRpcSetCredential(options['rpc-set-file']),
  ]);
  const runtimeFile = path.resolve(options.runtime);
  const faultsFile = path.resolve(options.faults);
  const expectedHost = options.expectedHost ?? 'localhost:4280';
  const readinessAgreement = options.readinessAgreement ?? establishDevnetAgreement;
  const readinessFetch = options.readinessFetch ?? cappedFetch;
  const rpcRequest = options.rpcRequest ?? rpcCall;
  const readiness = async () => {
    const checks = {};
    let runtime = null;
    let agreement = null;
    const check = async (name, operation) => {
      try {
        await operation();
        checks[name] = 'ok';
      } catch {
        checks[name] = 'failed';
      }
    };
    await check('lease', async () => {
      runtime = validateManualPublicRuntime(JSON.parse(await fs.readFile(runtimeFile, 'utf8')));
    });
    await Promise.all([
      check('browserCommit', async () => {
        if (!runtime) throw new Error('runtime unavailable');
        const result = await readinessFetch(`${options['site-origin']}/_neal-build.json`);
        if (
          result.status !== 200
          || result.body?.schema !== 'neal.devnet-browser-build/v1'
          || result.body?.sourceCommit !== runtime.sourceCommit
        ) throw new Error('browser build mismatch');
      }),
      check('site', async () => {
        const result = await readinessFetch(`${options['site-origin']}/_neal-build.json`);
        if (result.status !== 200) throw new Error('site unavailable');
      }),
      check('issuer', async () => {
        if (!runtime) throw new Error('runtime unavailable');
        const result = await readinessFetch(`${options['issuer-origin']}/readyz`);
        const issuer = result.body;
        if (
          result.status !== 200
          || issuer?.schema !== 'neal.issuer-readiness/v2'
          || issuer.status !== 'ready'
          || issuer.sourceCommit !== runtime.sourceCommit
          || issuer.issuerImageId !== options['issuer-image-id']
          || issuer.expectedWallet !== runtime.browserWallet
          || issuer.verificationMode !== 'quorum-2-of-3'
          || issuer.chainId !== 'solana:devnet'
          || issuer.programId !== runtime.programId
          || issuer.programDataAddress !== runtime.programDataAddress
          || issuer.programSha256 !== runtime.programSha256
          || issuer.configAddress !== runtime.configAddress
          || issuer.mint !== runtime.mint
          || issuer.requiredAtomicAmount !== MANUAL_AMOUNT
          || issuer.minimumLockSeconds !== MANUAL_LOCK_SECONDS
          || issuer.configRevision !== runtime.configRevision
        ) throw new Error('issuer attestation mismatch');
      }),
      check('matrix', async () => {
        const result = await readinessFetch(`${options['matrix-origin']}/_matrix/client/versions`);
        if (result.status !== 200 || !Array.isArray(result.body?.versions)) throw new Error('matrix unavailable');
      }),
      check('rpcQuorum', async () => {
        agreement = await readinessAgreement(rpcSet);
        if (!Number.isSafeInteger(agreement?.slot) || agreement.slot <= 0) throw new Error('quorum unavailable');
      }),
      check('walletPolicy', async () => {
        if (!runtime) throw new Error('runtime unavailable');
        const policy = buildManualWalletPolicy(runtime);
        if (
          policy.chain !== 'solana:devnet'
          || policy.accessStake?.status !== 'active'
          || policy.accessStake?.programId !== runtime.programId
          || policy.accessStake?.configAddress !== runtime.configAddress
          || policy.accessStake?.mint !== runtime.mint
          || policy.accessStake?.requiredAtomicAmount !== MANUAL_AMOUNT
          || policy.accessStake?.minimumLockSeconds !== MANUAL_LOCK_SECONDS
          || typeof runtime.browserWallet !== 'string'
        ) throw new Error('wallet policy mismatch');
      }),
    ]);
    return buildManualReadiness({ runtime, checks, agreement });
  };
  const server = https.createServer({ key, cert }, async (request, response) => {
    try {
      if (request.headers.host !== expectedHost) {
        sendJson(response, 421, { error: 'Local acceptance host unavailable' });
        return;
      }
      const pathname = new URL(request.url, 'https://localhost').pathname;
      if (pathname === '/_neal/devnet/health' && request.method === 'GET') {
        sendJson(response, 200, { schema: 'neal.devnet-manual-health/v1', status: 'ok' });
        return;
      }
      if (pathname === '/_neal/devnet/ready' && request.method === 'GET') {
        const result = await readiness();
        sendJson(response, result.ready ? 200 : 503, result);
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
        exactBrowserRequest(request, runtime, expectedHost, { requireJson: true });
        await proxyRpc(request, response, rpcSet, rpcRequest);
        return;
      }
      if (ISSUER_PATHS.has(pathname) && request.method === 'POST') {
        exactBrowserRequest(request, runtime, expectedHost, { requireJson: true });
        const body = await readBody(request, 32 * 1024);
        await proxyLoopback(request, response, options['issuer-origin'], { body });
        return;
      }
      if (pathname.startsWith('/_matrix/client/')) {
        if (!matrixRouteAllowed(pathname, request.method, runtime)) {
          sendJson(response, 404, { error: 'Matrix route unavailable' });
          return;
        }
        if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
          exactBrowserRequest(request, runtime, expectedHost, { requireJson: ['POST', 'PUT'].includes(request.method) });
        }
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
