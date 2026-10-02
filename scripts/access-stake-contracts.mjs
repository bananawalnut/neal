import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const RELEASE_SCHEMA = 'neal.access-stake-release/v1';
export const REHEARSAL_SCHEMA = 'neal.access-stake-devnet-rehearsal/v1';
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PRODUCTION_AMOUNT = '69000000000';
export const PRODUCTION_LOCK_SECONDS = 7_776_000;
export const LIFECYCLE_AMOUNT = '1000000';
export const LIFECYCLE_LOCK_SECONDS = 120;

const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
};

const exactKeys = (value, allowed, label) => {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} contains unsupported field(s): ${extras.join(', ')}`);
};

const string = (value, label) => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
};

const sha256Value = (value, label) => {
  if (!/^[0-9a-f]{64}$/u.test(string(value, label))) throw new Error(`${label} must be a lowercase SHA-256`);
  return value;
};

const commitValue = (value, label) => {
  if (!/^[0-9a-f]{40}$/u.test(string(value, label))) throw new Error(`${label} must be a full Git commit SHA`);
  return value;
};

const publicKey = (value, label) => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(string(value, label))) throw new Error(`${label} must be a base58 public key`);
  return value;
};

const bool = (value, label) => {
  if (value !== true && value !== false) throw new Error(`${label} must be boolean`);
  return value;
};

const unsignedString = (value, label) => {
  if (!/^(0|[1-9][0-9]*)$/u.test(string(value, label))) throw new Error(`${label} must be an unsigned decimal string`);
  return value;
};

const isoTimestamp = (value, label) => {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || !value.endsWith('Z')) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
};

export const sha256File = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

export function validateReleaseManifest(input) {
  const value = object(input, 'release manifest');
  exactKeys(value, ['schema', 'sourceCommit', 'createdAt', 'toolchain', 'builds', 'artifact'], 'release manifest');
  if (value.schema !== RELEASE_SCHEMA) throw new Error(`Unsupported release schema: ${value.schema}`);
  commitValue(value.sourceCommit, 'sourceCommit');
  isoTimestamp(value.createdAt, 'createdAt');
  const toolchain = object(value.toolchain, 'toolchain');
  exactKeys(toolchain, ['agaveVersion', 'agaveInstallerSha256', 'rustVersion', 'rustupInstallerSha256', 'containerImage', 'containerImageId', 'platform'], 'toolchain');
  if (toolchain.agaveVersion !== 'v4.2.1') throw new Error('toolchain.agaveVersion must be v4.2.1');
  sha256Value(toolchain.agaveInstallerSha256, 'toolchain.agaveInstallerSha256');
  if (toolchain.rustVersion !== '1.90.0') throw new Error('toolchain.rustVersion must be 1.90.0');
  sha256Value(toolchain.rustupInstallerSha256, 'toolchain.rustupInstallerSha256');
  if (!string(toolchain.containerImage, 'toolchain.containerImage').includes('@sha256:')) {
    throw new Error('toolchain.containerImage must be digest-pinned');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(string(toolchain.containerImageId, 'toolchain.containerImageId'))) {
    throw new Error('toolchain.containerImageId must be a Docker image SHA-256');
  }
  if (toolchain.platform !== 'linux/amd64') throw new Error('toolchain.platform must be linux/amd64');
  if (!Array.isArray(value.builds) || value.builds.length !== 2) throw new Error('builds must contain exactly two builds');
  value.builds.forEach((entry, index) => {
    const build = object(entry, `builds[${index}]`);
    exactKeys(build, ['ordinal', 'sha256', 'bytes'], `builds[${index}]`);
    if (build.ordinal !== index + 1) throw new Error(`builds[${index}].ordinal is invalid`);
    sha256Value(build.sha256, `builds[${index}].sha256`);
    if (!Number.isSafeInteger(build.bytes) || build.bytes <= 0) throw new Error(`builds[${index}].bytes must be positive`);
  });
  if (value.builds[0].sha256 !== value.builds[1].sha256 || value.builds[0].bytes !== value.builds[1].bytes) {
    throw new Error('The two release builds are not byte-identical');
  }
  const artifact = object(value.artifact, 'artifact');
  exactKeys(artifact, ['file', 'sha256', 'bytes'], 'artifact');
  if (artifact.file !== 'neal_access_stake.so') throw new Error('artifact.file must be neal_access_stake.so');
  sha256Value(artifact.sha256, 'artifact.sha256');
  if (artifact.sha256 !== value.builds[0].sha256 || artifact.bytes !== value.builds[0].bytes) {
    throw new Error('artifact does not match both builds');
  }
  return value;
}

const forbiddenKey = /(credential|secret|password|passphrase|cookie|private|keypair|rpcurl|rpc_url|path|ipaddress|username|(?:^|_)(?:access|refresh|registration)?token(?:$|_))/iu;
const forbiddenValue = /(?:https?:\/\/[^\s"']*@|-----BEGIN|\[(?:\s*\d+\s*,){31}|(?:access|refresh)[_-]?token\s*[:=])/iu;

export function assertPublicEvidence(value, location = 'receipt') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicEvidence(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && forbiddenValue.test(value)) throw new Error(`${location} contains secret-like data`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'temporarySecretsRemoved' && forbiddenKey.test(key)) {
      throw new Error(`${location}.${key} is not allowed in public evidence`);
    }
    assertPublicEvidence(child, `${location}.${key}`);
  }
}

const validateConfig = (entry, index) => {
  const config = object(entry, `configs[${index}]`);
  exactKeys(config, ['purpose', 'address', 'configId', 'revision', 'requiredAtomicAmount', 'minimumLockSeconds'], `configs[${index}]`);
  if (!['parity', 'lifecycle'].includes(config.purpose)) throw new Error(`configs[${index}].purpose is invalid`);
  publicKey(config.address, `configs[${index}].address`);
  unsignedString(config.configId, `configs[${index}].configId`);
  unsignedString(config.revision, `configs[${index}].revision`);
  unsignedString(config.requiredAtomicAmount, `configs[${index}].requiredAtomicAmount`);
  if (!Number.isSafeInteger(config.minimumLockSeconds) || config.minimumLockSeconds <= 0) {
    throw new Error(`configs[${index}].minimumLockSeconds must be positive`);
  }
  return config;
};

export function validateRehearsalReceipt(input) {
  const value = object(input, 'rehearsal receipt');
  assertPublicEvidence(value);
  exactKeys(value, ['schema', 'executedAt', 'sourceCommit', 'releaseManifestSha256', 'artifact', 'cluster', 'program', 'mint', 'configs', 'checks', 'review'], 'rehearsal receipt');
  if (value.schema !== REHEARSAL_SCHEMA) throw new Error(`Unsupported rehearsal schema: ${value.schema}`);
  isoTimestamp(value.executedAt, 'executedAt');
  commitValue(value.sourceCommit, 'sourceCommit');
  sha256Value(value.releaseManifestSha256, 'releaseManifestSha256');
  const artifact = object(value.artifact, 'artifact');
  exactKeys(artifact, ['sha256', 'bytes'], 'artifact');
  sha256Value(artifact.sha256, 'artifact.sha256');
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error('artifact.bytes must be positive');
  const cluster = object(value.cluster, 'cluster');
  exactKeys(cluster, ['name', 'genesisHash', 'independentRpcAgreement'], 'cluster');
  if (cluster.name !== 'devnet' || cluster.genesisHash !== DEVNET_GENESIS || cluster.independentRpcAgreement !== true) {
    throw new Error('cluster must record independent Solana devnet agreement');
  }
  const program = object(value.program, 'program');
  exactKeys(program, ['programId', 'programDataAddress', 'deployedSha256', 'immutable'], 'program');
  publicKey(program.programId, 'program.programId');
  publicKey(program.programDataAddress, 'program.programDataAddress');
  sha256Value(program.deployedSha256, 'program.deployedSha256');
  if (program.deployedSha256 !== artifact.sha256 || program.immutable !== true) throw new Error('program must be immutable and match the release artifact');
  const mint = object(value.mint, 'mint');
  exactKeys(mint, ['address', 'program', 'decimals', 'mintedAtomicAmount', 'mintAuthority', 'freezeAuthority', 'metadataAuthority'], 'mint');
  publicKey(mint.address, 'mint.address');
  if (mint.program !== TOKEN_2022_PROGRAM || mint.decimals !== 6 || mint.mintedAtomicAmount !== '140000000000') {
    throw new Error('mint must be the six-decimal 140,000-token Token-2022 rehearsal mint');
  }
  for (const field of ['mintAuthority', 'freezeAuthority', 'metadataAuthority']) {
    if (!['revoked', 'absent'].includes(mint[field])) throw new Error(`mint.${field} must be revoked or absent`);
  }
  if (!Array.isArray(value.configs) || value.configs.length !== 2) throw new Error('configs must contain parity and lifecycle configs');
  const configs = value.configs.map(validateConfig);
  const parity = configs.find((config) => config.purpose === 'parity');
  const lifecycle = configs.find((config) => config.purpose === 'lifecycle');
  if (!parity || parity.configId !== '0' || parity.requiredAtomicAmount !== PRODUCTION_AMOUNT || parity.minimumLockSeconds !== PRODUCTION_LOCK_SECONDS) {
    throw new Error('parity config does not match approved production terms');
  }
  if (!lifecycle || lifecycle.configId !== '1' || lifecycle.requiredAtomicAmount !== LIFECYCLE_AMOUNT || lifecycle.minimumLockSeconds !== LIFECYCLE_LOCK_SECONDS) {
    throw new Error('lifecycle config does not match the approved short lifecycle terms');
  }
  const checks = object(value.checks, 'checks');
  const requiredChecks = [
    'releaseBuildsIdentical', 'deployedBytesMatch', 'programImmutable', 'mintAuthoritiesDisabled',
    'parityStakeClaimConsume', 'matrixTokenSingleUse', 'chainReplayRejected', 'cleanupFailureHalted',
    'cleanupReconciled', 'earlyUnstakeRejected', 'pauseRejectedStakeAndClaim', 'pausedRefundReturnedFullVault',
    'unpaused', 'encryptedBackupRestored', 'staleRestoreCouldNotReissue', 'temporarySecretsRemoved',
  ];
  exactKeys(checks, requiredChecks, 'checks');
  requiredChecks.forEach((key) => {
    if (!bool(checks[key], `checks.${key}`)) throw new Error(`checks.${key} did not pass`);
  });
  const review = object(value.review, 'review');
  exactKeys(review, ['sourceCommit', 'isolatedAgent', 'unresolvedP0ToP2'], 'review');
  commitValue(review.sourceCommit, 'review.sourceCommit');
  if (review.sourceCommit !== value.sourceCommit || review.isolatedAgent !== true || review.unresolvedP0ToP2 !== 0) {
    throw new Error('review must be an isolated-agent pass for the exact source commit with no unresolved P0-P2 findings');
  }
  return value;
}

export async function readAndValidateReleaseManifest(file) {
  const absolute = path.resolve(file);
  const value = validateReleaseManifest(JSON.parse(await fs.readFile(absolute, 'utf8')));
  const artifactFile = path.resolve(path.dirname(absolute), value.artifact.file);
  const [hash, stats] = await Promise.all([sha256File(artifactFile), fs.stat(artifactFile)]);
  if (hash !== value.artifact.sha256 || stats.size !== value.artifact.bytes) throw new Error('Release artifact does not match its manifest');
  return { manifest: value, manifestFile: absolute, artifactFile };
}
