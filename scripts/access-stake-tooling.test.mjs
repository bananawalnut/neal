import test from 'node:test';
import assert from 'node:assert/strict';
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
import { matrixAttempt, parseCli, validateReview } from './rehearse-access-stake-devnet.mjs';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const KEY = '11111111111111111111111111111111';

const release = () => ({
  schema: RELEASE_SCHEMA,
  sourceCommit: COMMIT,
  createdAt: '2026-10-02T00:00:00.000Z',
  toolchain: {
    agaveVersion: 'v4.2.1',
    agaveInstallerSha256: '24b3374030dff853e455b0f910aab149c934c79ccc7f498984923074967647d6',
    rustVersion: '1.90.0',
    rustupInstallerSha256: '7d0ea0f8eba7fa1ebfe998091cd7ec4501e33ec5ca6b884eb4d894d7da5170af',
    ubuntuSnapshot: '20261002T150000Z',
    cargoBuildSbfVersion: '4.1.0',
    platformToolsVersion: 'v1.54',
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
  const required = ['--release-manifest', 'release.json', '--rpc-primary', 'https://one.invalid', '--rpc-secondary', 'https://two.invalid', '--review-file', 'review.json'];
  assert.equal(parseCli(required).execute, false);
  assert.throws(() => parseCli([...required, '--execute']), /acknowledge-devnet/u);
  assert.equal(parseCli([...required, '--execute', '--acknowledge-devnet']).execute, true);
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
    response(403, { errcode: 'M_FORBIDDEN' }),
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
