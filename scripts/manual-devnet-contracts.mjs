import { PublicKey } from '@solana/web3.js';

import { assertPublicEvidence, TOKEN_2022_PROGRAM } from './access-stake-contracts.mjs';

export const MANUAL_RUNTIME_SCHEMA = 'neal.devnet-manual-runtime/v1';
export const MANUAL_STATE_SCHEMA = 'neal.devnet-manual-state/v1';
export const MANUAL_MODE = 'isolated-devnet-manual';
export const MANUAL_AMOUNT = '69000000000';
export const MANUAL_MINTED_AMOUNT = '69001000000';
export const MANUAL_LOCK_SECONDS = 120;
export const MANUAL_LEASE_SECONDS = 4 * 60 * 60;

const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error(`${label} fields are unsupported`);
};

const publicKey = (value, label) => {
  if (typeof value !== 'string') throw new Error(`${label} must be a public key`);
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw new Error(`${label} must be a public key`);
  }
};

const timestamp = (value, label) => {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return value;
};

export function validateManualPublicRuntime(value, { allowExpired = false } = {}) {
  exactKeys(value, [
    'schema', 'mode', 'sourceCommit', 'generatedAt', 'expiresAt', 'chainId', 'verification',
    'browserWallet', 'programId', 'programDataAddress', 'programSha256', 'configAddress',
    'configRevision', 'issuerAuthority', 'mint', 'terms', 'matrix',
  ], 'manual runtime');
  if (value.schema !== MANUAL_RUNTIME_SCHEMA || value.mode !== MANUAL_MODE || value.chainId !== 'solana:devnet') {
    throw new Error('Manual runtime identity is unsupported');
  }
  if (!/^[0-9a-f]{40}$/u.test(value.sourceCommit)) throw new Error('Manual runtime source commit is invalid');
  const generatedAt = timestamp(value.generatedAt, 'generatedAt');
  const expiresAt = timestamp(value.expiresAt, 'expiresAt');
  const leaseMilliseconds = Date.parse(expiresAt) - Date.parse(generatedAt);
  if (leaseMilliseconds <= 0 || leaseMilliseconds > MANUAL_LEASE_SECONDS * 1000) {
    throw new Error('Manual runtime lease exceeds four hours');
  }
  if (!allowExpired && Date.parse(expiresAt) <= Date.now()) throw new Error('Manual runtime lease has expired');
  exactKeys(value.verification, ['mode', 'providerCount', 'threshold'], 'verification');
  if (value.verification.mode !== 'quorum-2-of-3' || value.verification.providerCount !== 3 || value.verification.threshold !== 2) {
    throw new Error('Manual runtime must advertise strict 2-of-3 verification');
  }
  for (const name of ['browserWallet', 'programId', 'programDataAddress', 'configAddress', 'issuerAuthority', 'mint']) {
    publicKey(value[name], name);
  }
  if (!/^[0-9a-f]{64}$/u.test(value.programSha256)) throw new Error('Manual runtime program hash is invalid');
  if (!/^(0|[1-9][0-9]*)$/u.test(value.configRevision)) throw new Error('Manual runtime config revision is invalid');
  exactKeys(value.terms, ['requiredAtomicAmount', 'minimumLockSeconds', 'tokenDecimals', 'mintedAtomicAmount'], 'terms');
  if (
    value.terms.requiredAtomicAmount !== MANUAL_AMOUNT
    || value.terms.minimumLockSeconds !== MANUAL_LOCK_SECONDS
    || value.terms.tokenDecimals !== 6
    || value.terms.mintedAtomicAmount !== MANUAL_MINTED_AMOUNT
  ) throw new Error('Manual runtime terms do not match the approved acceptance terms');
  exactKeys(value.matrix, ['serverName', 'baseUrl', 'roomId', 'roomAlias', 'viaServers'], 'matrix');
  if (
    value.matrix.serverName !== 'rehearsal.neal.invalid'
    || value.matrix.baseUrl !== 'https://localhost:4280'
    || typeof value.matrix.roomId !== 'string'
    || !value.matrix.roomId.endsWith(':rehearsal.neal.invalid')
    || value.matrix.roomAlias !== '#neal-gc:rehearsal.neal.invalid'
    || !Array.isArray(value.matrix.viaServers)
    || value.matrix.viaServers.length !== 1
    || value.matrix.viaServers[0] !== 'rehearsal.neal.invalid'
  ) throw new Error('Manual runtime Matrix routing is invalid');
  assertPublicEvidence(value);
  return value;
}

export function buildManualWalletPolicy(runtime) {
  validateManualPublicRuntime(runtime);
  return {
    schema: 'neal.wallet-policy/v1',
    chain: 'solana:devnet',
    preferredWallets: ['Castalia'],
    walletStandard: {
      requiredFeatures: ['standard:connect', 'standard:events'],
      preferredAuthentication: 'solana:signIn',
      authenticationFallback: 'solana:signMessage',
      capabilityGatedTransactions: ['solana:signTransaction', 'solana:signAndSendTransaction'],
      mobileTransport: 'mobile-wallet-adapter-2.x',
    },
    identity: {
      subjectFormat: 'solana:devnet/{address}',
      sessionStorage: 'memory-only',
      nonceTtlSeconds: 300,
      statement: 'Sign in to the isolated NEAL devnet acceptance service. No transaction. No fee.',
      challengeEndpoint: '/v2/challenge',
      verifyEndpoint: '/v2/verify',
    },
    verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2 },
    holderProof: {
      rpcEndpoint: '/_neal/devnet/rpc',
      commitment: 'finalized',
      mintSource: null,
      minimumAtomicBalance: '1',
    },
    accessStake: {
      status: 'active',
      contractVersion: 2,
      programId: runtime.programId,
      programDataAddress: runtime.programDataAddress,
      programSha256: runtime.programSha256,
      configAddress: runtime.configAddress,
      configRevision: runtime.configRevision,
      issuerAuthority: runtime.issuerAuthority,
      mint: runtime.mint,
      tokenProgram: TOKEN_2022_PROGRAM,
      tokenDecimals: 6,
      requiredAtomicAmount: MANUAL_AMOUNT,
      minimumLockSeconds: MANUAL_LOCK_SECONDS,
      tokenEndpoint: '/v2/access-token',
    },
  };
}
