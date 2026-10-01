import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const policyPath = path.resolve(process.argv[2] ?? 'apps/site/public/wallet-policy.json');
const launchPath = path.resolve(process.argv[3] ?? 'apps/site/public/launch-record.json');
const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
const launch = JSON.parse(await fs.readFile(launchPath, 'utf8'));

if (policy.schema !== 'neal.wallet-policy/v1') throw new Error('Unsupported wallet policy schema');
if (policy.chain !== 'solana:mainnet') throw new Error('Production wallet policy must use Solana mainnet');
const stake = policy.accessStake;
if (!stake || !['planned', 'active', 'paused'].includes(stake.status)) {
  throw new Error('accessStake.status must be planned, active, or paused');
}
if (stake.contractVersion !== 2) throw new Error('accessStake.contractVersion must be 2');
if (stake.mint !== launch.execution?.mintAddress) throw new Error('Stake mint must match the launch record');
if (stake.tokenProgram !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
  throw new Error('Stake policy must pin Token-2022');
}
if (stake.tokenDecimals !== 6 || stake.requiredAtomicAmount !== '69000000000' || stake.minimumLockSeconds !== 7776000) {
  throw new Error('Stake policy does not contain the approved 69,000 NEAL / 90-day terms');
}

const deploymentFields = [
  stake.programId,
  stake.programDataAddress,
  stake.programSha256,
  stake.configAddress,
  stake.configRevision,
  stake.issuerAuthority,
  policy.identity?.challengeEndpoint,
  policy.identity?.verifyEndpoint,
  stake.tokenEndpoint,
];
if (stake.status === 'planned' && deploymentFields.some((value) => value !== null)) {
  throw new Error('Planned policy must not contain partially active deployment fields');
}
if (stake.status !== 'planned' && deploymentFields.some((value) => typeof value !== 'string' || !value)) {
  throw new Error('Active or paused policy requires every deployment field');
}
if (stake.status !== 'planned') {
  const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
  if (![stake.programId, stake.programDataAddress, stake.configAddress, stake.issuerAuthority].every((value) => base58.test(value))) {
    throw new Error('Active or paused policy contains an invalid public key');
  }
  if (!/^[0-9a-f]{64}$/u.test(stake.programSha256) || !/^(0|[1-9][0-9]*)$/u.test(stake.configRevision)) {
    throw new Error('Active or paused policy contains an invalid program hash or config revision');
  }
  const routes = [
    [policy.identity.challengeEndpoint, '/v1/challenge'],
    [policy.identity.verifyEndpoint, '/v1/verify'],
    [stake.tokenEndpoint, '/v1/access-token'],
  ].map(([value, expectedPath]) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) {
      throw new Error(`Issuer URL must be the exact HTTPS ${expectedPath} route`);
    }
    return url;
  });
  if (new Set(routes.map((url) => url.origin)).size !== 1) throw new Error('Issuer URLs must share one origin');
}

console.log(`Wallet policy is valid for ${stake.status} contract v${stake.contractVersion}.`);
