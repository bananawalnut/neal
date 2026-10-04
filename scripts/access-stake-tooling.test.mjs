import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  DEVNET_GENESIS,
  LIFECYCLE_AMOUNT,
  LIFECYCLE_LOCK_SECONDS,
  PRODUCTION_AMOUNT,
  PRODUCTION_LOCK_SECONDS,
  RELEASE_SCHEMA,
  REHEARSAL_SCHEMA,
  TOKEN_2022_PROGRAM,
  assertPublicEvidence,
  validateReleaseManifest,
  validateRehearsalReceipt,
} from './access-stake-contracts.mjs';
import { expectProgramError, matrixAttempt, parseCli, validateReview } from './rehearse-access-stake-devnet.mjs';
import { buildSbfCommand, buildSbfEnvironment } from './reproduce-access-stake-release.mjs';
import { createProposalManifest, validateProposalManifest } from './squads-access-authority.mjs';
import { validateProductionReview } from './verify-production-review.mjs';
import {
  establishDevnetAgreement,
  fundDevnetAccount,
  quorumFinalizedBalance,
  rpcCall,
  validateRpcSetCredential,
} from './devnet-rpc-set.mjs';
import {
  MANUAL_RUNTIME_SCHEMA,
  MANUAL_LEASE_SECONDS,
  buildManualReadiness,
  buildManualWalletPolicy,
  validateManualReadiness,
  validateManualPublicRuntime,
} from './manual-devnet-contracts.mjs';
import {
  assertAcceptancePortsAvailable,
  directoryDigest,
  enforceLeaseExpiry,
  enforceTeardownBarrier,
  processAlive,
  reviewSignaturePayload,
  validateDockerImageId,
  validatePrepareRecoveryMarker,
  validateSignedIsolatedReview,
  waitForCleanReconciliation,
} from './manual-devnet.mjs';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const KEY = '11111111111111111111111111111111';

test('devnet genesis uses the canonical full hash', () => {
  assert.equal(DEVNET_GENESIS, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
});

const release = () => ({
  schema: RELEASE_SCHEMA,
  sourceCommit: COMMIT,
  createdAt: '2026-10-02T00:00:00.000Z',
  toolchain: {
    agaveVersion: 'v4.2.1',
    agaveArchiveSha256: '7f35f92c15861263bc540c001466678d2da228149a107b51d5b65ce497603074',
    rustVersion: '1.90.0',
    rustcArchiveSha256: '48c2a42de9e92fcae8c24568f5fe40d5734696a6f80e83cc6d46eef1a78f13c9',
    rustStdArchiveSha256: '663f4ab7945b392d5e5294dec1b050a66820a20e86f084ec37eeb0f2f7ff5569',
    cargoArchiveSha256: '9853db03d68578a30972e2755c89c66aec035fec641cf8f3a7117c81eec2578d',
    ubuntuSnapshot: '20261002T150000Z',
    cargoBuildSbfVersion: '4.1.0',
    platformToolsVersion: 'v1.54',
    platformToolsArchiveSha256: 'fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e',
    containerImage: 'ubuntu:24.04@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b',
    containerImageId: `sha256:${SHA}`,
    platform: 'linux/amd64',
  },
  builds: [
    { ordinal: 1, sha256: SHA, bytes: 123 },
    { ordinal: 2, sha256: SHA, bytes: 123 },
  ],
  artifact: { file: 'neal_access_stake.so', sha256: SHA, bytes: 123 },
});

const receipt = () => ({
  schema: REHEARSAL_SCHEMA,
  executedAt: '2026-10-02T00:00:00.000Z',
  sourceCommit: COMMIT,
  releaseManifestSha256: SHA,
  reviewAttestationSha256: SHA,
  artifact: { sha256: SHA, bytes: 123 },
  cluster: { name: 'devnet', genesisHash: DEVNET_GENESIS, independentRpcAgreement: true, finalizedAgreementSlot: 123 },
  harness: {
    postgresImage: 'postgres:16.15-bookworm@sha256:1938c16e9d2f10a6a3623b344b64ae8d45f407f2c5f34f0979468bb689b9227a',
    synapseImage: 'matrixdotorg/synapse:v1.157.2@sha256:3827b727cb40c52d7d4806db2eb96058eb4514e94a79ca1d7b805de7a8fc44d9',
  },
  program: { programId: KEY, programDataAddress: KEY, deployedSha256: SHA, immutable: true },
  mint: {
    address: KEY,
    program: TOKEN_2022_PROGRAM,
    decimals: 6,
    mintedAtomicAmount: '140000000000',
    mintAuthority: 'revoked',
    freezeAuthority: 'revoked',
    metadataAuthority: 'absent',
  },
  configs: [
    { purpose: 'parity', address: KEY, configId: '0', revision: '0', requiredAtomicAmount: PRODUCTION_AMOUNT, minimumLockSeconds: PRODUCTION_LOCK_SECONDS },
    { purpose: 'lifecycle', address: KEY, configId: '1', revision: '2', requiredAtomicAmount: LIFECYCLE_AMOUNT, minimumLockSeconds: LIFECYCLE_LOCK_SECONDS },
  ],
  checks: {
    releaseBuildsIdentical: true,
    deployedBytesMatch: true,
    programImmutable: true,
    mintAuthoritiesDisabled: true,
    parityStakeClaimConsume: true,
    matrixTokenSingleUse: true,
    chainReplayRejected: true,
    cleanupFailureHalted: true,
    cleanupReconciled: true,
    earlyUnstakeRejected: true,
    pauseRejectedStakeAndClaim: true,
    pausedRefundReturnedFullVault: true,
    unpaused: true,
    encryptedBackupRestored: true,
    staleRestoreCouldNotReissue: true,
    temporarySecretsRemoved: true,
  },
  review: { sourceCommit: COMMIT, isolatedAgent: true, unresolvedP0ToP2: 0 },
});

test('release manifest requires two byte-identical builds', () => {
  assert.equal(validateReleaseManifest(release()).artifact.sha256, SHA);
  const changed = release();
  changed.builds[1].sha256 = 'c'.repeat(64);
  assert.throws(() => validateReleaseManifest(changed), /not byte-identical/u);
});

test('public receipt validates exact configs, checks, and isolated review', () => {
  assert.equal(validateRehearsalReceipt(receipt()).configs[0].requiredAtomicAmount, PRODUCTION_AMOUNT);
  const changed = receipt();
  changed.configs[0].minimumLockSeconds = 90;
  assert.throws(() => validateRehearsalReceipt(changed), /production terms/u);
});

test('public evidence rejects credential-shaped keys and values', () => {
  assert.throws(() => assertPublicEvidence({ password: 'not-public' }), /not allowed/u);
  assert.throws(() => assertPublicEvidence({ note: 'https://user:pass@example.invalid' }), /secret-like/u);
  assert.doesNotThrow(() => assertPublicEvidence(receipt()));
});

test('devnet writes require both explicit flags', () => {
  const required = ['--release-manifest', 'release.json', '--rpc-set-file', '/private/rpc-set.json', '--review-file', 'review.json'];
  assert.equal(parseCli(required).execute, false);
  assert.throws(() => parseCli([...required, '--execute']), /acknowledge-devnet/u);
  assert.equal(parseCli([...required, '--execute', '--acknowledge-devnet']).execute, true);
});

test('manual issuer image identity accepts one exact Docker digest only', () => {
  const imageId = `sha256:${'a'.repeat(64)}`;
  assert.equal(validateDockerImageId(`${imageId}\n`), imageId);
  assert.throws(() => validateDockerImageId(''), /image ID is invalid/u);
  assert.throws(() => validateDockerImageId(`${imageId}\n${imageId}`), /image ID is invalid/u);
  assert.throws(() => validateDockerImageId(`sha256:${'A'.repeat(64)}`), /image ID is invalid/u);
});

test('manual preparation recovery marker is exact', () => {
  const runtime = path.join(os.tmpdir(), COMMIT);
  const marker = {
    schema: 'neal.devnet-manual-prepare-recovery/v1',
    sourceCommit: COMMIT,
    failedAt: '2026-10-04T00:00:00.000Z',
    status: 'operator_recovery_required',
  };
  assert.equal(validatePrepareRecoveryMarker(marker, runtime), marker);
  assert.throws(
    () => validatePrepareRecoveryMarker({ ...marker, status: 'prepared' }, runtime),
    /unsupported/u,
  );
});

test('manual devnet funding rotates providers and requires finalized 2-of-3 balance', async () => {
  const rpcSet = {
    threshold: 2,
    endpoints: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  };
  let balance = 0;
  const requests = [];
  const call = async (endpoint, method, params) => {
    if (method === 'getBalance') return { value: endpoint.id === 'c' ? Math.max(0, balance - 1) : balance };
    if (method === 'requestAirdrop') {
      requests.push(endpoint.id);
      if (endpoint.id === 'a') throw new Error('faucet unavailable');
      balance += params[1];
      return 's'.repeat(64);
    }
    throw new Error('unexpected method');
  };
  const funded = await fundDevnetAccount(rpcSet, KEY, 2_000_000_000, {
    call, wait: async () => {}, attempts: 4, pollsPerAttempt: 2,
  });
  assert.equal(funded.balance, 2_000_000_000);
  assert.deepEqual(funded.agreeingProviderIds, ['a', 'b']);
  assert.deepEqual(requests, ['a', 'b', 'b']);
});

test('manual devnet balance fails closed without two matching providers', async () => {
  const rpcSet = {
    threshold: 2,
    endpoints: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  };
  await assert.rejects(
    () => quorumFinalizedBalance(rpcSet, KEY, {
      call: async (endpoint) => ({ value: { a: 1, b: 2, c: 3 }[endpoint.id] }),
    }),
    /do not agree/u,
  );
});

test('manual teardown waits for two clean reconciliation observations', async () => {
  const observations = [
    { incomplete: [], administrators: [{ state: 'CREATE_REQUESTED' }] },
    { incomplete: [], administrators: [] },
    { incomplete: [], administrators: [] },
  ];
  let reads = 0;
  const result = await waitForCleanReconciliation({
    read: async () => observations[Math.min(reads++, observations.length - 1)],
    wait: async () => {},
    attempts: 3,
  });
  assert.deepEqual(result, { incomplete: [], administrators: [] });
  assert.equal(reads, 3);
  await assert.rejects(
    () => waitForCleanReconciliation({
      read: async () => ({ incomplete: [], administrators: [{ state: 'RECONCILIATION_REQUIRED' }] }),
      wait: async () => {},
      attempts: 2,
    }),
    /remains incomplete/u,
  );
});

test('manual acceptance port preflight reports an occupied listener without stopping it', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.equal(typeof address, 'object');
    await assert.rejects(
      () => assertAcceptancePortsAvailable([address.port]),
      new RegExp(`Acceptance port ${address.port} is already in use`, 'u'),
    );
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('prepared browser artifact digest changes on any file mutation and rejects symlinks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-browser-artifact-'));
  try {
    await fs.writeFile(path.join(directory, 'index.html'), 'ready');
    const first = await directoryDigest(directory);
    await fs.writeFile(path.join(directory, 'index.html'), 'changed');
    assert.notEqual(await directoryDigest(directory), first);
    await fs.symlink(path.join(directory, 'index.html'), path.join(directory, 'alias.html'));
    await assert.rejects(() => directoryDigest(directory), /may not contain symlinks/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('teardown barrier catches a receipt that finalizes during quiescence', async () => {
  const events = [];
  let scans = 0;
  const data = Buffer.alloc(163);
  Buffer.from('NEALSTAK').copy(data, 0);
  data.writeBigInt64LE(123n, 129);
  data.writeBigInt64LE(0n, 153);
  await assert.rejects(() => enforceTeardownBarrier({
    pause: async () => { events.push('pause'); },
    scan: async () => {
      events.push(`scan-${++scans}`);
      return scans === 1 ? [] : [{ pubkey: KEY, data }];
    },
    quiesce: async () => { events.push('quiesce'); },
    finalizedBarrier: async () => { events.push('barrier'); },
  }), /not released/u);
  assert.deepEqual(events, ['pause', 'scan-1', 'quiesce', 'barrier', 'scan-2']);
});

test('teardown barrier keeps services available for refund while a receipt is locked', async () => {
  const events = [];
  const data = Buffer.alloc(163);
  Buffer.from('NEALSTAK').copy(data, 0);
  data.writeBigInt64LE(123n, 129);
  data.writeBigInt64LE(0n, 153);
  await assert.rejects(() => enforceTeardownBarrier({
    pause: async () => { events.push('pause'); },
    scan: async () => { events.push('scan'); return [{ pubkey: KEY, data }]; },
    quiesce: async () => { events.push('quiesce'); },
    finalizedBarrier: async () => { events.push('barrier'); },
  }), /not released/u);
  assert.deepEqual(events, ['pause', 'scan']);
});

test('lease guardian runs the same teardown barrier at normal expiry', async () => {
  const events = [];
  await enforceLeaseExpiry({
    expiresAt: '2026-10-03T12:00:00.000Z',
    now: () => Date.parse('2026-10-03T12:00:01.000Z'),
    readCurrent: async () => ({ expiresAt: '2026-10-03T12:00:00.000Z', status: 'running' }),
    teardown: async () => { events.push('teardown'); },
    sleep: async (milliseconds) => { events.push(`sleep-${milliseconds}`); },
  });
  assert.deepEqual(events, ['sleep-0', 'teardown']);
});

test('lease guardian retries pause failure without disarming', async () => {
  const events = [];
  let attempts = 0;
  await enforceLeaseExpiry({
    expiresAt: '2026-10-03T12:00:00.000Z',
    now: () => Date.parse('2026-10-03T12:00:01.000Z'),
    readCurrent: async () => ({
      expiresAt: '2026-10-03T12:00:00.000Z',
      status: 'running',
    }),
    teardown: async () => {
      attempts += 1;
      events.push(`teardown-${attempts}`);
      if (attempts === 1) throw new Error('pause unavailable');
    },
    sleep: async (milliseconds) => { events.push(`sleep-${milliseconds}`); },
    retryMilliseconds: 25,
  });
  assert.deepEqual(events, ['sleep-0', 'teardown-1', 'sleep-25', 'teardown-2']);
});

test('lease guardian retries a partial process teardown while state is draining', async () => {
  const events = [];
  let attempts = 0;
  await enforceLeaseExpiry({
    expiresAt: '2026-10-03T12:00:00.000Z',
    now: () => Date.parse('2026-10-03T12:00:01.000Z'),
    readCurrent: async () => ({
      expiresAt: '2026-10-03T12:00:00.000Z', status: attempts === 0 ? 'running' : 'draining',
    }),
    teardown: async () => {
      attempts += 1;
      events.push(`teardown-${attempts}`);
      if (attempts === 1) throw new Error('process quiescence interrupted');
    },
    sleep: async (milliseconds) => { events.push(`sleep-${milliseconds}`); },
    retryMilliseconds: 25,
  });
  assert.deepEqual(events, ['sleep-0', 'teardown-1', 'sleep-25', 'teardown-2']);
});

test('manual process identity rejects a live PID with the wrong ownership nonce', async () => {
  const marker = `neal-manual-owner-${'a'.repeat(32)}`;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processAlive({ pid: child.pid, marker }), true);
    assert.equal(processAlive({ pid: child.pid, marker: `neal-manual-owner-${'b'.repeat(32)}` }), false);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
});

test('RPC-set contract requires three independent providers without exposing URLs in CLI parsing', () => {
  const value = {
    schema: 'neal.solana-rpc-set/v1',
    mode: 'quorum-2-of-3',
    threshold: 2,
    endpoints: [
      { id: 'helius-devnet', trustDomain: 'helius.xyz', url: 'https://devnet.helius-rpc.com/?api-key=secret' },
      { id: 'quicknode-devnet', trustDomain: 'quicknode.com', url: 'https://sample.solana-devnet.quiknode.pro/secret/' },
      { id: 'alchemy-devnet', trustDomain: 'alchemy.com', url: 'https://solana-devnet.g.alchemy.com/v2/secret' },
    ],
  };
  assert.equal(validateRpcSetCredential(value).endpoints.length, 3);
  const duplicate = structuredClone(value);
  duplicate.endpoints[2].trustDomain = 'quicknode.com';
  assert.throws(() => validateRpcSetCredential(duplicate), /trust domains must be distinct/u);
  const impostor = structuredClone(value);
  impostor.endpoints[1] = {
    id: 'unrelated-devnet', trustDomain: 'other.example', url: 'https://rpc.other.example/key',
  };
  assert.throws(() => validateRpcSetCredential(impostor), /recognized QuickNode/u);
});

test('devnet agreement tolerates one unavailable provider and fails closed without a majority', async () => {
  const rpcSet = validateRpcSetCredential({
    schema: 'neal.solana-rpc-set/v1', mode: 'quorum-2-of-3', threshold: 2,
    endpoints: [
      { id: 'helius-devnet', trustDomain: 'helius.xyz', url: 'https://devnet.helius-rpc.com/?api-key=hidden' },
      { id: 'quicknode-devnet', trustDomain: 'quicknode.com', url: 'https://sample.solana-devnet.quiknode.pro/hidden/' },
      { id: 'alchemy-devnet', trustDomain: 'alchemy.com', url: 'https://solana-devnet.g.alchemy.com/v2/hidden' },
    ],
  });
  const originalFetch = globalThis.fetch;
  const envelope = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('quiknode.pro')) throw new Error('provider unavailable');
    const { method, params } = JSON.parse(options.body);
    if (method === 'getGenesisHash') return envelope(DEVNET_GENESIS);
    if (method === 'getSlot') return envelope(100);
    if (method === 'getBlock') return envelope({ blockhash: `block-${params[0]}`, previousBlockhash: `block-${params[0] - 1}` });
    throw new Error('unexpected method');
  };
  try {
    const agreement = await establishDevnetAgreement(rpcSet);
    assert.deepEqual(agreement.agreeingProviderIds, ['alchemy-devnet', 'helius-devnet']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async (url, options) => {
    const { method, params } = JSON.parse(options.body);
    if (method === 'getGenesisHash') return envelope(DEVNET_GENESIS);
    if (method === 'getSlot') return envelope(100);
    if (method === 'getBlock') {
      const host = new URL(String(url)).hostname;
      return envelope({ blockhash: `${host}-${params[0]}`, previousBlockhash: `${host}-${params[0] - 1}` });
    }
    throw new Error('unexpected method');
  };
  try {
    await assert.rejects(() => establishDevnetAgreement(rpcSet), /could not establish 2-of-3/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual browser runtime produces only a localhost devnet policy', () => {
  const generatedAt = Date.now();
  const runtime = {
    schema: MANUAL_RUNTIME_SCHEMA,
    mode: 'isolated-devnet-manual',
    sourceCommit: COMMIT,
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(generatedAt + (MANUAL_LEASE_SECONDS * 1_000)).toISOString(),
    chainId: 'solana:devnet',
    verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2 },
    requestNonce: 'd'.repeat(64),
    browserWallet: KEY,
    programId: KEY,
    programDataAddress: KEY,
    programSha256: SHA,
    configAddress: KEY,
    configRevision: '0',
    issuerAuthority: KEY,
    mint: KEY,
    terms: { requiredAtomicAmount: '69000000000', minimumLockSeconds: 120, tokenDecimals: 6, mintedAtomicAmount: '69001000000' },
    matrix: {
      serverName: 'rehearsal.neal.invalid', baseUrl: 'https://localhost:4280',
      roomId: '!room:rehearsal.neal.invalid', roomAlias: '#neal-gc:rehearsal.neal.invalid',
      viaServers: ['rehearsal.neal.invalid'],
    },
  };
  assert.equal(validateManualPublicRuntime(runtime), runtime);
  const policy = buildManualWalletPolicy(runtime);
  assert.equal(policy.chain, 'solana:devnet');
  assert.equal(policy.verification.mode, 'quorum-2-of-3');
  assert.equal(policy.accessStake.requiredAtomicAmount, '69000000000');
  assert.equal(policy.holderProof.rpcEndpoint, '/_neal/devnet/rpc');
  assert.equal(JSON.stringify(policy).includes('secret'), false);
  assert.throws(() => validateManualPublicRuntime({
    ...runtime, terms: { ...runtime.terms, minimumLockSeconds: 7_776_000 },
  }), /approved acceptance terms/u);
  assert.throws(() => validateManualPublicRuntime({ ...runtime, requestNonce: 'short' }), /request nonce/u);
  assert.throws(() => validateManualPublicRuntime({
    ...runtime,
    generatedAt: new Date(generatedAt - (MANUAL_LEASE_SECONDS * 1_000)).toISOString(),
    expiresAt: new Date(generatedAt - 1).toISOString(),
  }), /expired/u);
});

test('manual RPC client forbids cross-host and local-address redirects', async () => {
  const originalFetch = globalThis.fetch;
  const endpoint = {
    id: 'helius-devnet', trustDomain: 'helius',
    url: 'https://example.helius-rpc.com/?api-key=redacted',
  };
  try {
    for (const redirectedUrl of ['https://attacker.invalid/rpc', 'http://127.0.0.1:8899/rpc']) {
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.redirect, 'error');
        const response = new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
        Object.defineProperty(response, 'redirected', { value: true });
        Object.defineProperty(response, 'url', { value: redirectedUrl });
        return response;
      };
      await assert.rejects(() => rpcCall(endpoint, 'getBlockHeight'), /redirects are forbidden/u);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual readiness is sanitized, exact-commit bound, and requires every check', () => {
  const runtime = {
    schema: MANUAL_RUNTIME_SCHEMA,
    mode: 'isolated-devnet-manual',
    sourceCommit: COMMIT,
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    chainId: 'solana:devnet',
    verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2 },
    requestNonce: 'd'.repeat(64),
    browserWallet: KEY, programId: KEY, programDataAddress: KEY, programSha256: SHA,
    configAddress: KEY, configRevision: '0', issuerAuthority: KEY, mint: KEY,
    terms: { requiredAtomicAmount: '69000000000', minimumLockSeconds: 120, tokenDecimals: 6, mintedAtomicAmount: '69001000000' },
    matrix: {
      serverName: 'rehearsal.neal.invalid', baseUrl: 'https://localhost:4280',
      roomId: '!room:rehearsal.neal.invalid', roomAlias: '#neal-gc:rehearsal.neal.invalid', viaServers: ['rehearsal.neal.invalid'],
    },
  };
  const checks = {
    lease: 'ok', browserCommit: 'ok', site: 'ok', issuer: 'ok', matrix: 'ok',
    rpcQuorum: 'ok', walletPolicy: 'ok',
  };
  const readiness = buildManualReadiness({ runtime, checks, agreement: { slot: 123 } });
  assert.equal(validateManualReadiness(readiness, { expectedCommit: COMMIT, requireReady: true }), readiness);
  assert.equal(JSON.stringify(readiness).includes('https://'), false);
  assert.throws(() => validateManualReadiness(readiness, { expectedCommit: 'c'.repeat(40) }), /different browser build/u);
  const unavailable = buildManualReadiness({ runtime, checks: { ...checks, issuer: 'failed' } });
  assert.equal(validateManualReadiness(unavailable).ready, false);
  assert.throws(() => validateManualReadiness(unavailable, { requireReady: true }), /not ready/u);
});

test('isolated review must cover the exact release with no P0-P2 findings', () => {
  const review = {
    schema: 'neal.access-stake-isolated-review/v1',
    sourceCommit: COMMIT,
    reviewedAt: '2026-10-02T00:00:00.000Z',
    reviewerType: 'isolated-agent',
    findings: { p0: 0, p1: 0, p2: 0 },
  };
  assert.equal(validateReview(review, COMMIT), review);
  assert.throws(() => validateReview({ ...review, findings: { p0: 0, p1: 0, p2: 1 } }, COMMIT), /unresolved/u);
});

test('manual acceptance requires a signed review bound to the exact release bytes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-signed-review-'));
  try {
    const artifact = Buffer.alloc(123, 7);
    const artifactSha256 = createHash('sha256').update(artifact).digest('hex');
    const manifest = release();
    manifest.builds = manifest.builds.map((build) => ({ ...build, sha256: artifactSha256 }));
    manifest.artifact = { ...manifest.artifact, sha256: artifactSha256 };
    const manifestFile = path.join(directory, 'release-manifest.json');
    const artifactFile = path.join(directory, 'neal_access_stake.so');
    const reviewFile = path.join(directory, 'review.json');
    const signatureFile = path.join(directory, 'review-signature.json');
    const publicKeyFile = path.join(directory, 'reviewer-public.pem');
    const issuerBundleFile = path.join(directory, 'issuer-bundle.tar');
    const browserBundleFile = path.join(directory, 'manual-browser-bundle.json');
    const review = {
      schema: 'neal.access-stake-isolated-review/v1', sourceCommit: COMMIT,
      reviewedAt: '2026-10-03T00:00:00.000Z', reviewerType: 'isolated-agent',
      findings: { p0: 0, p1: 0, p2: 0 },
    };
    const browserMarker = Buffer.from(`${JSON.stringify({ schema: 'neal.devnet-browser-build/v1', sourceCommit: COMMIT })}\n`);
    const browserBundle = {
      schema: 'neal.devnet-browser-bundle/v1', sourceCommit: COMMIT,
      toolchain: { nodeVersion: 'v24.0.0', platform: 'linux', architecture: 'x64' },
      packageLockSha256: createHash('sha256').update(await fs.readFile(path.join(process.cwd(), 'package-lock.json'))).digest('hex'),
      files: [{
        path: '_neal-build.json', mode: 0o644, size: browserMarker.length,
        sha256: createHash('sha256').update(browserMarker).digest('hex'), dataBase64: browserMarker.toString('base64'),
      }],
    };
    await Promise.all([
      fs.writeFile(artifactFile, artifact),
      fs.writeFile(manifestFile, `${JSON.stringify(manifest)}\n`),
      fs.writeFile(reviewFile, `${JSON.stringify(review)}\n`),
      fs.writeFile(issuerBundleFile, Buffer.from('reviewed issuer bundle')),
      fs.writeFile(browserBundleFile, `${JSON.stringify(browserBundle)}\n`),
    ]);
    const releaseManifestSha256 = createHash('sha256').update(await fs.readFile(manifestFile)).digest('hex');
    const reviewSha256 = createHash('sha256').update(await fs.readFile(reviewFile)).digest('hex');
    const issuerBundleSha256 = createHash('sha256').update(await fs.readFile(issuerBundleFile)).digest('hex');
    const browserBundleSha256 = createHash('sha256').update(await fs.readFile(browserBundleFile)).digest('hex');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await fs.writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
    const publicKeySha256 = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const envelope = {
      schema: 'neal.access-stake-isolated-review-signature/v2', sourceCommit: COMMIT,
      reviewSha256, releaseManifestSha256, artifactSha256, issuerBundleSha256, browserBundleSha256,
      reviewerIdentity: 'independent-review-agent', reviewedAt: review.reviewedAt, unacceptedP3: 0,
    };
    const signed = { ...envelope, signature: sign(null, reviewSignaturePayload(envelope), privateKey).toString('base64url') };
    await fs.writeFile(signatureFile, `${JSON.stringify(signed)}\n`);
    const validated = await validateSignedIsolatedReview({
      reviewFile, signatureFile, issuerBundleFile, browserBundleFile, reviewerPublicKeyFile: publicKeyFile, sourceCommit: COMMIT,
      authorizedReviewerIdentity: envelope.reviewerIdentity, authorizedPublicKeySha256: publicKeySha256,
      release: { manifest, manifestFile, artifactFile },
    });
    assert.equal(validated.envelope.artifactSha256, artifactSha256);
    const tampered = { ...signed, artifactSha256: SHA };
    await fs.writeFile(signatureFile, `${JSON.stringify(tampered)}\n`);
    await assert.rejects(() => validateSignedIsolatedReview({
      reviewFile, signatureFile, issuerBundleFile, browserBundleFile, reviewerPublicKeyFile: publicKeyFile, sourceCommit: COMMIT,
      authorizedReviewerIdentity: envelope.reviewerIdentity, authorizedPublicKeySha256: publicKeySha256,
      release: { manifest, manifestFile, artifactFile },
    }), /does not bind/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('manual compose keeps Synapse internal while giving only the issuer RPC egress', async () => {
  const [base, manual] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'infra/neal-access-rehearsal/compose.yaml'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'infra/neal-access-rehearsal/compose.manual.yaml'), 'utf8'),
  ]);
  assert.match(base, /synapse:[\s\S]*?networks:\n\s+- rehearsal-internal/u);
  assert.match(base, /rehearsal-internal:\n\s+internal: true/u);
  assert.doesNotMatch(manual, /^\s{2}synapse:/mu);
  assert.match(manual, /issuer:[\s\S]*?networks:\n\s+- rehearsal-internal\n\s+- manual-egress/u);
  assert.match(manual, /issuer:[\s\S]*?127\.0\.0\.1:18011:18011/u);
  assert.match(manual, /matrix-loopback:[\s\S]*?network_mode: "service:issuer"/u);
  assert.match(manual, /matrix-loopback:[\s\S]*?image: \$\{NEAL_MANUAL_ISSUER_IMAGE:\?set NEAL_MANUAL_ISSUER_IMAGE\}/u);
  assert.doesNotMatch(manual, /matrix-loopback:[\s\S]*?\n\s+volumes:/u);
});

test('port 4282 admin surface is inert and Vite has no production admin proxy', async () => {
  const [bootstrap, vite] = await Promise.all([
    fs.readFile(path.join(process.cwd(), 'apps/site/src/admin-bootstrap.ts'), 'utf8'),
    fs.readFile(path.join(process.cwd(), 'apps/site/vite.config.ts'), 'utf8'),
  ]);
  assert.match(bootstrap, /surface !== 'production'/u);
  assert.match(bootstrap, /ADMIN ACTIONS DISABLED/u);
  assert.doesNotMatch(vite, /matrix\.nealtheseal\.org|_neal\/admin|proxy:/u);
});

test('Matrix rehearsal completes token and dummy UIA stages and rejects token replay', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const response = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  const queue = [
    response(401, { session: 'first', flows: [{ stages: ['m.login.registration_token', 'm.login.dummy'] }] }),
    response(401, { session: 'first', completed: ['m.login.registration_token'] }),
    response(200, { user_id: '@rehearsal:rehearsal.neal.invalid' }),
    response(401, { session: 'replay', flows: [{ stages: ['m.login.registration_token', 'm.login.dummy'] }] }),
    response(401, { errcode: 'M_UNAUTHORIZED', error: 'Invalid registration token' }),
  ];
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return queue.shift();
  };
  try {
    await matrixAttempt('one-use-token', true);
    await matrixAttempt('one-use-token', false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[1].auth.type, 'm.login.registration_token');
  assert.equal(requests[1].auth.token, 'one-use-token');
  assert.equal(requests[2].auth.type, 'm.login.dummy');
  assert.equal(requests.length, 5);
});

test('Matrix replay evidence rejects transient server failures', async () => {
  const originalFetch = globalThis.fetch;
  const response = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  const queue = [
    response(401, { session: 'replay', flows: [{ stages: ['m.login.registration_token', 'm.login.dummy'] }] }),
    response(500, { errcode: 'M_UNKNOWN' }),
  ];
  globalThis.fetch = async () => queue.shift();
  try {
    await assert.rejects(() => matrixAttempt('one-use-token', false), /expected one-use failure/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('negative chain evidence requires the expected custom program error', async () => {
  await expectProgramError(
    async () => { throw new Error('simulation failed: custom program error: 0x8'); },
    'early unstake',
    8,
  );
  await assert.rejects(
    () => expectProgramError(async () => { throw new Error('RPC request timed out'); }, 'early unstake', 8),
    /without expected custom program error/u,
  );
  await assert.rejects(
    () => expectProgramError(async () => {}, 'early unstake', 8),
    /unexpectedly succeeded/u,
  );
});

test('release builds use the pinned cache without rustup or network resolution', () => {
  const command = buildSbfCommand();
  assert.deepEqual(buildSbfEnvironment(), {
    RUSTC: '/root/.cache/solana/v1.54/platform-tools/rust/bin/rustc',
  });
  assert.deepEqual(command.slice(0, 5), [
    'cargo', 'build-sbf', '--skip-tools-install', '--no-rustup-override', '--tools-version',
  ]);
  assert.equal(command.filter((argument) => argument === '--offline').length, 2);
  assert.ok(command.includes('--locked'));
});

test('CI artifacts bind to the exact pull-request head rather than the synthetic merge commit', async () => {
  const workflow = await fs.readFile(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
  assert.equal(
    workflow.match(/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/gu)?.length,
    4,
  );
  assert.match(workflow, /--commit "\$\(git rev-parse HEAD\)"/u);
  assert.doesNotMatch(workflow, /--commit "\$GITHUB_SHA"/u);
});

test('Squads authority manifest pins autonomous vault index zero and exact inner instruction', () => {
  const manifest = createProposalManifest({
    cluster: 'devnet',
    action: 'pause',
    multisig: KEY,
    transactionIndex: '4',
    programId: KEY,
    configAddress: KEY,
    expectedRevision: '8',
  });
  assert.equal(validateProposalManifest(manifest), manifest);
  assert.equal(manifest.vaultIndex, 0);
  assert.equal(manifest.innerInstruction.dataBase64, Buffer.from([1, 1]).toString('base64'));
  const changed = structuredClone(manifest);
  changed.messageHash = SHA;
  assert.throws(() => validateProposalManifest(changed), /does not reproduce/u);
});

test('production review binds commit and every release artifact with zero P0-P2', () => {
  const expected = {
    sourceCommit: COMMIT,
    reviewerIdentity: 'reviewer@example.test',
    releaseManifestSha256: SHA,
    sbfSha256: SHA,
    issuerBundleSha256: SHA,
  };
  const review = {
    schema: 'neal.production-review/v2',
    sourceCommit: COMMIT,
    reviewedAt: '2026-10-02T00:00:00.000Z',
    reviewerIdentity: expected.reviewerIdentity,
    releaseManifestSha256: SHA,
    sbfSha256: SHA,
    issuerBundleSha256: SHA,
    findings: { p0: 0, p1: 0, p2: 0, p3: 1 },
    signatureType: 'sigstore-keyless',
  };
  assert.equal(validateProductionReview(review, expected), review);
  assert.throws(
    () => validateProductionReview({ ...review, findings: { ...review.findings, p2: 1 } }, expected),
    /unresolved/u,
  );
});

test('direct authority tools structurally reject mainnet in favor of Squads', () => {
  const initialize = spawnSync(process.execPath, [
    'scripts/initialize-access-stake-config.mjs',
    '--cluster', 'mainnet',
    '--rpc', 'https://rpc.invalid',
    '--program-id', KEY,
    '--program-data-address', KEY,
    '--program-sha256', SHA,
    '--authority-keypair', '/does/not/exist',
    '--issuer-authority', KEY,
    '--config-id', '0',
    '--required-atomic-amount', PRODUCTION_AMOUNT,
    '--minimum-lock-seconds', String(PRODUCTION_LOCK_SECONDS),
  ], { encoding: 'utf8' });
  assert.equal(initialize.status, 1);
  assert.match(initialize.stderr, /Direct mainnet initialization is disabled/u);

  const manage = spawnSync(process.execPath, [
    'scripts/manage-access-stake-config.mjs',
    '--action', 'pause',
    '--cluster', 'mainnet',
    '--rpc', 'https://rpc.invalid',
    '--program-id', KEY,
    '--config-address', KEY,
    '--authority-keypair', '/does/not/exist',
  ], { encoding: 'utf8' });
  assert.equal(manage.status, 1);
  assert.match(manage.stderr, /Direct mainnet authority changes are disabled/u);
});
