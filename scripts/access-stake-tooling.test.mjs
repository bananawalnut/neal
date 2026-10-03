import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);
const KEY = '11111111111111111111111111111111';

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
  const required = ['--release-manifest', 'release.json', '--rpc-primary', 'https://one.invalid', '--rpc-secondary', 'https://two.invalid', '--rpc-tertiary', 'https://three.invalid', '--review-file', 'review.json'];
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
