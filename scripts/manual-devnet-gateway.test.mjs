import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createManualGateway } from './manual-devnet-gateway.mjs';

const request = (port, pathname, options = {}) => new Promise((resolve, reject) => {
  const call = https.request({
    hostname: '127.0.0.1', port, path: pathname, rejectUnauthorized: false,
    method: options.method ?? 'GET',
    headers: { Host: 'localhost:test', ...(options.headers ?? {}) },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({
      status: response.statusCode,
      headers: response.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }));
  });
  call.on('error', reject);
  if (options.body) call.write(options.body);
  call.end();
});

test('manual gateway serves only sanitized runtime and local devnet wallet policy', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-manual-gateway-test-'));
  const key = path.join(directory, 'localhost.key.pem');
  const cert = path.join(directory, 'localhost.cert.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  assert.equal(openssl.status, 0);
  const rpcSet = path.join(directory, 'rpc-set.json');
  await fs.writeFile(rpcSet, JSON.stringify({
    schema: 'neal.solana-rpc-set/v1', mode: 'quorum-2-of-3', threshold: 2,
    endpoints: [
      { id: 'helius-devnet', trustDomain: 'helius.xyz', url: 'https://devnet.helius-rpc.com/?api-key=not-returned' },
      { id: 'quicknode-devnet', trustDomain: 'quicknode.com', url: 'https://sample.solana-devnet.quiknode.pro/not-returned/' },
      { id: 'alchemy-devnet', trustDomain: 'alchemy.com', url: 'https://solana-devnet.g.alchemy.com/v2/not-returned' },
    ],
  }), { mode: 0o600 });
  const runtimeFile = path.join(directory, 'runtime.json');
  const runtime = {
    schema: 'neal.devnet-manual-runtime/v1', mode: 'isolated-devnet-manual', sourceCommit: 'b'.repeat(40),
    generatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), chainId: 'solana:devnet',
    verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2 },
    requestNonce: 'd'.repeat(64),
    browserWallet: '11111111111111111111111111111111', programId: '11111111111111111111111111111111',
    programDataAddress: '11111111111111111111111111111111', programSha256: 'a'.repeat(64),
    configAddress: '11111111111111111111111111111111', configRevision: '0',
    issuerAuthority: '11111111111111111111111111111111', mint: '11111111111111111111111111111111',
    terms: { requiredAtomicAmount: '69000000000', minimumLockSeconds: 120, tokenDecimals: 6, mintedAtomicAmount: '69001000000' },
    matrix: {
      serverName: 'rehearsal.neal.invalid', baseUrl: 'https://localhost:4280',
      roomId: '!test:rehearsal.neal.invalid', roomAlias: '#neal-gc:rehearsal.neal.invalid', viaServers: ['rehearsal.neal.invalid'],
    },
  };
  await fs.writeFile(runtimeFile, JSON.stringify(runtime));
  const faults = path.join(directory, 'faults.json');
  await fs.writeFile(faults, '{"dropMatrixFinalResponseOnce":false}', { mode: 0o600 });
  let issuerHealthy = true;
  let rpcMode = 'agreement';
  const rpcCalls = [];
  const readinessFetch = async (url) => {
    if (url.endsWith('/_neal-build.json')) {
      return { status: 200, body: { schema: 'neal.devnet-browser-build/v1', sourceCommit: runtime.sourceCommit } };
    }
    if (url.endsWith('/readyz')) {
      return issuerHealthy ? {
        status: 200,
        body: {
          schema: 'neal.issuer-readiness/v2', status: 'ready', chainId: 'solana:devnet',
          sourceCommit: runtime.sourceCommit, issuerImageId: `sha256:${'e'.repeat(64)}`,
          expectedWallet: runtime.browserWallet,
          verificationMode: 'quorum-2-of-3', programId: runtime.programId,
          programDataAddress: runtime.programDataAddress, programSha256: runtime.programSha256,
          configAddress: runtime.configAddress, mint: runtime.mint,
          requiredAtomicAmount: runtime.terms.requiredAtomicAmount,
          minimumLockSeconds: runtime.terms.minimumLockSeconds, configRevision: runtime.configRevision,
        },
      } : { status: 503, body: { schema: 'neal.issuer-readiness/v2', status: 'unavailable' } };
    }
    if (url.endsWith('/_matrix/client/versions')) return { status: 200, body: { versions: ['v1.11'] } };
    throw new Error('unexpected readiness URL');
  };
  const server = await createManualGateway({
    runtime: runtimeFile, 'rpc-set-file': rpcSet, 'tls-key': key, 'tls-cert': cert, faults,
    'site-origin': 'http://127.0.0.1:9', 'issuer-origin': 'http://127.0.0.1:9', 'matrix-origin': 'http://127.0.0.1:9',
    readinessFetch,
    readinessAgreement: async () => ({ slot: 123, agreeingProviderIds: ['helius-devnet', 'quicknode-devnet'] }),
    rpcRequest: async (endpoint, method) => {
      rpcCalls.push({ provider: endpoint.id, method });
      if (method === 'sendTransaction') {
        if (endpoint.id.startsWith('alchemy')) throw new Error('provider unavailable');
        return '4'.repeat(88);
      }
      const providerIndex = ['helius-devnet', 'quicknode-devnet', 'alchemy-devnet'].indexOf(endpoint.id);
      if (rpcMode === 'no-majority') return { context: { slot: 123 + providerIndex }, value: 456 + providerIndex };
      if (rpcMode === 'one-liar' && endpoint.id.startsWith('alchemy')) return { context: { slot: 999 }, value: 999 };
      return { context: { slot: 123 }, value: 456 };
    },
    expectedHost: 'localhost:test',
    'issuer-image-id': `sha256:${'e'.repeat(64)}`,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const runtimeResponse = await request(port, '/_neal/devnet/runtime');
    assert.equal(runtimeResponse.status, 200);
    assert.deepEqual(runtimeResponse.body, runtime);
    assert.equal(JSON.stringify(runtimeResponse.body).includes('not-returned'), false);
    assert.equal(runtimeResponse.headers['cache-control'], 'no-store');
    assert.match(runtimeResponse.headers['content-security-policy'], /frame-ancestors 'none'/u);
    const policy = await request(port, '/wallet-policy.json');
    assert.equal(policy.body.chain, 'solana:devnet');
    assert.equal(policy.body.holderProof.rpcEndpoint, '/_neal/devnet/rpc');
    assert.equal(policy.body.accessStake.requiredAtomicAmount, '69000000000');
    const ready = await request(port, '/_neal/devnet/ready');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.schema, 'neal.devnet-manual-readiness/v1');
    assert.equal(ready.body.ready, true);
    assert.equal(ready.body.verification.finalizedAgreementSlot, 123);
    assert.equal(JSON.stringify(ready.body).includes('not-returned'), false);
    issuerHealthy = false;
    const unavailable = await request(port, '/_neal/devnet/ready');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.ready, false);
    assert.equal(unavailable.body.checks.issuer, 'failed');
    const rpcBody = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'getBalance', params: [runtime.browserWallet] });
    const rpcHeaders = {
      Origin: 'https://localhost:4280',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      'X-Neal-Request-Nonce': runtime.requestNonce,
    };
    const rpc = await request(port, '/_neal/devnet/rpc', { method: 'POST', headers: rpcHeaders, body: rpcBody });
    assert.equal(rpc.status, 200);
    assert.equal(rpc.body.result.value, 456);
    assert.equal(rpcCalls.filter((call) => call.method === 'getBalance').length, 3);
    rpcMode = 'one-liar';
    const oneLiar = await request(port, '/_neal/devnet/rpc', { method: 'POST', headers: rpcHeaders, body: rpcBody });
    assert.equal(oneLiar.status, 200);
    assert.equal(oneLiar.body.result.value, 456);
    rpcMode = 'no-majority';
    const noMajority = await request(port, '/_neal/devnet/rpc', { method: 'POST', headers: rpcHeaders, body: rpcBody });
    assert.equal(noMajority.status, 503);
    rpcMode = 'agreement';
    const sendBody = JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'sendTransaction', params: ['signed-bytes'] });
    const sent = await request(port, '/_neal/devnet/rpc', { method: 'POST', headers: rpcHeaders, body: sendBody });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.result, '4'.repeat(88));
    assert.equal(rpcCalls.filter((call) => call.method === 'sendTransaction').length, 3);
    const crossOrigin = await request(port, '/_neal/devnet/rpc', {
      method: 'POST', headers: { ...rpcHeaders, Origin: 'https://attacker.invalid' }, body: rpcBody,
    });
    assert.equal(crossOrigin.status, 403);
    const { 'X-Neal-Request-Nonce': _nonce, ...headersWithoutNonce } = rpcHeaders;
    const missingNonce = await request(port, '/_neal/devnet/rpc', {
      method: 'POST', headers: headersWithoutNonce, body: rpcBody,
    });
    assert.equal(missingNonce.status, 403);
    const textPlain = await request(port, '/_neal/devnet/rpc', {
      method: 'POST', headers: { ...rpcHeaders, 'Content-Type': 'text/plain' }, body: rpcBody,
    });
    assert.equal(textPlain.status, 415);
    const wrongHost = await request(port, '/_neal/devnet/health', { headers: { Host: 'foo.localhost:test' } });
    assert.equal(wrongHost.status, 421);
    const genericMatrixRoute = await request(port, '/_matrix/client/v3/admin/users');
    assert.equal(genericMatrixRoute.status, 404);
    const crossOriginRegistration = await request(port, '/_matrix/client/v3/register', {
      method: 'POST', headers: { ...rpcHeaders, Origin: 'https://attacker.invalid' }, body: '{}',
    });
    assert.equal(crossOriginRegistration.status, 403);
    const absoluteTarget = await request(port, 'https://example.com/');
    assert.equal(absoluteTarget.status, 502);
    assert.equal(absoluteTarget.body.error, 'Local acceptance service unavailable');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
