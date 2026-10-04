#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildManualWalletPolicy } from './manual-devnet-contracts.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (index % 2 === 0) pairs.push([value.replace(/^--/u, ''), values[index + 1]]);
  return pairs;
}, []));
const sourceCommit = args.commit;
const dist = path.resolve(args.dist ?? 'apps/site/dist');
if (!/^[0-9a-f]{40}$/u.test(sourceCommit ?? '')) throw new Error('Expected --commit with a full source commit');

const KEY = '11111111111111111111111111111111';
const requestNonce = 'd'.repeat(64);
const generatedAt = new Date();
const expiresAt = new Date(generatedAt.getTime() + 60 * 60 * 1_000);
const runtime = {
  schema: 'neal.devnet-manual-runtime/v1',
  mode: 'isolated-devnet-manual',
  sourceCommit,
  generatedAt: generatedAt.toISOString(),
  expiresAt: expiresAt.toISOString(),
  chainId: 'solana:devnet',
  verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2 },
  requestNonce,
  browserWallet: KEY,
  programId: KEY,
  programDataAddress: KEY,
  programSha256: 'a'.repeat(64),
  configAddress: KEY,
  configRevision: '0',
  issuerAuthority: KEY,
  mint: KEY,
  terms: {
    requiredAtomicAmount: '69000000000', minimumLockSeconds: 120,
    tokenDecimals: 6, mintedAtomicAmount: '69001000000',
  },
  matrix: {
    serverName: 'rehearsal.neal.invalid', baseUrl: 'https://localhost:4280',
    roomId: '!room:rehearsal.neal.invalid', roomAlias: '#neal-gc:rehearsal.neal.invalid',
    viaServers: ['rehearsal.neal.invalid'],
  },
};
const readiness = {
  schema: 'neal.devnet-manual-readiness/v1', status: 'ready', ready: true,
  checkedAt: new Date().toISOString(), sourceCommit, expiresAt: expiresAt.toISOString(),
  verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2, finalizedAgreementSlot: 123 },
  checks: {
    lease: 'ok', browserCommit: 'ok', site: 'ok', issuer: 'ok', matrix: 'ok',
    rpcQuorum: 'ok', walletPolicy: 'ok',
  },
};
const policy = buildManualWalletPolicy(runtime);

const chromePath = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate) => candidate && fs.existsSync(candidate));
if (!chromePath) throw new Error('Chrome is required for the built-browser manual acceptance smoke test');
if (typeof WebSocket !== 'function') throw new Error('The Node runtime must provide WebSocket');

const contentType = (file) => ({
  '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
}[path.extname(file)] ?? 'application/octet-stream');

const json = (response, status, value) => {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  response.end(body);
};

const freePort = async () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const waitFor = async (operation, milliseconds = 10_000) => {
  const deadline = Date.now() + milliseconds;
  let lastError;
  while (Date.now() < deadline) {
    try { return await operation(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('Timed out');
};

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'neal-browser-dom-'));
const keyFile = path.join(temporary, 'localhost.key');
const certificateFile = path.join(temporary, 'localhost.crt');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-keyout', keyFile, '-out', certificateFile, '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
], { stdio: 'ignore' });

let rpcObserved = false;
const server = https.createServer({ key: await fsp.readFile(keyFile), cert: await fsp.readFile(certificateFile) }, async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'https://localhost:4280');
    if (url.pathname === '/_neal/devnet/runtime') return json(response, 200, runtime);
    if (url.pathname === '/_neal/devnet/ready') return json(response, 200, readiness);
    if (url.pathname === '/wallet-policy.json') return json(response, 200, policy);
    if (url.pathname === '/_neal/devnet/rpc') {
      assert.equal(request.headers['x-neal-request-nonce'], requestNonce);
      rpcObserved = true;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return json(response, 200, {
        jsonrpc: '2.0', id: payload.id,
        error: { code: -32000, message: 'intentional browser-mount stop' },
      });
    }
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(dist, relative);
    if (!file.startsWith(`${dist}${path.sep}`)) throw new Error('Static path escaped dist');
    const body = await fsp.readFile(file);
    response.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': body.length });
    response.end(body);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(4280, resolve);
});

const debugPort = await freePort();
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--ignore-certificate-errors', `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${path.join(temporary, 'chrome-profile')}`, 'about:blank',
], { stdio: 'ignore' });
const chromeExited = new Promise((resolve) => chrome.once('exit', resolve));
let socket;
try {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) throw new Error(`Chrome target list returned ${response.status}`);
    const targets = await response.json();
    const page = targets.find((candidate) => candidate.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('No Chrome page target');
    return page;
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const exceptions = [];
  const events = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    events.push(message.method);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const listeners = new Map();
    const publicKey = {
      toBase58: () => ${JSON.stringify(KEY)},
      toString: () => ${JSON.stringify(KEY)},
      toBytes: () => new Uint8Array(32)
    };
    const emit = (event, value) => {
      for (const listener of listeners.get(event) ?? []) listener(value);
    };
    const provider = {
      isPhantom: true,
      isConnected: false,
      publicKey: null,
      on(event, listener) {
        const values = listeners.get(event) ?? new Set();
        values.add(listener);
        listeners.set(event, values);
      },
      async connect() {
        this.isConnected = true;
        this.publicKey = publicKey;
        emit('connect', publicKey);
        return { publicKey };
      },
      async disconnect() {
        this.isConnected = false;
        this.publicKey = null;
        emit('disconnect');
      },
      async signMessage(message) { return { signature: new Uint8Array(64), publicKey }; },
      async signTransaction(transaction) { return transaction; }
    };
    Object.defineProperty(window, 'phantom', { configurable: true, value: { solana: provider } });
  })();` });
  await send('Page.navigate', { url: 'https://localhost:4280/#gc' });
  await waitFor(async () => {
    const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (state.result.value !== 'complete') throw new Error('Page not complete');
    return true;
  });
  await waitFor(async () => {
    const state = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        manual: document.documentElement.dataset.devnetManual,
        blocked: document.documentElement.dataset.acceptanceBlocked,
        banner: document.querySelector('.devnet-manual-banner')?.textContent ?? '',
        terms: document.querySelector('#matrix-stake-terms')?.textContent ?? '',
        status: document.querySelector('#matrix-stake-status')?.textContent ?? ''
      })`, returnByValue: true,
    });
    const value = JSON.parse(state.result.value);
    if (!value.status || !/STAKE 69,000 NEAL · REFUNDABLE AFTER 120 SECONDS/u.test(value.terms)) {
      throw new Error(`Manual stake panel has not mounted: ${JSON.stringify({ value, rpcObserved, exceptions })}`);
    }
    return value;
  });
  const evaluated = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      manual: document.documentElement.dataset.devnetManual,
      blocked: document.documentElement.dataset.acceptanceBlocked,
      banner: document.querySelector('.devnet-manual-banner')?.textContent ?? '',
      terms: document.querySelector('#matrix-stake-terms')?.textContent ?? ''
    })`, returnByValue: true,
  });
  const rendered = JSON.parse(evaluated.result.value);
  assert.equal(rendered.manual, 'true');
  assert.equal(rendered.blocked, undefined);
  assert.match(rendered.banner, /READY FOR MANUAL ACCEPTANCE/u);
  assert.match(rendered.banner, /69,000 TEST NEAL · 120-SECOND REFUNDABLE LOCK/u);
  assert.match(rendered.terms, /STAKE 69,000 NEAL · REFUNDABLE AFTER 120 SECONDS/u);
  assert.equal(exceptions.some((message) => /Endpoint URL must start with/u.test(message)), false);
  const phantom = await waitFor(async () => {
    const state = await send('Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('#wallet-button')?.click();
        const choices = [...document.querySelectorAll('#wallet-list .wallet-choice')];
        const choice = choices.find((candidate) => candidate.textContent?.includes('Phantom'));
        if (!choice) return JSON.stringify({ found: false, labels: choices.map((candidate) => candidate.textContent) });
        choice.click();
        return JSON.stringify({ found: true });
      })()`, returnByValue: true,
    });
    const value = JSON.parse(state.result.value);
    if (!value.found) throw new Error(`Injected Phantom fallback is unavailable: ${JSON.stringify(value)}`);
    const connected = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        provider: document.querySelector('#wallet-provider')?.textContent,
        address: document.querySelector('#wallet-address')?.textContent
      })`, returnByValue: true,
    });
    const connection = JSON.parse(connected.result.value);
    if (connection.provider !== 'Phantom' || connection.address !== KEY) {
      throw new Error(`Injected Phantom did not connect: ${JSON.stringify(connection)}`);
    }
    return connection;
  });
  console.log(JSON.stringify({
    schema: 'neal.devnet-browser-dom-smoke/v1', sourceCommit, status: 'passed', phantom: phantom.provider,
  }));
} finally {
  try { socket?.close(); } catch {}
  chrome.kill('SIGTERM');
  if (await Promise.race([chromeExited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]) === false) {
    chrome.kill('SIGKILL');
    await chromeExited;
  }
  await new Promise((resolve) => server.close(resolve));
  // Chrome can briefly keep profile files open after its root process exits.
  // Use Node's bounded recursive-removal retry support so a successful browser
  // acceptance smoke cannot be reported as failed by that teardown race.
  await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
