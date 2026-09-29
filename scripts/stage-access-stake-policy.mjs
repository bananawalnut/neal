import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { verifyAccessStake } from './verify-access-stake-readiness.mjs';

const required = [
  'program-id',
  'config-address',
  'required-atomic-amount',
  'minimum-lock-seconds',
  'challenge-endpoint',
  'verify-endpoint',
  'token-endpoint',
];

const parseCli = (argv) => {
  const values = {
    policy: 'apps/site/public/wallet-policy.json',
    launch: 'apps/site/public/launch-record.json',
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--write') values.write = true;
    else if (argument.startsWith('--')) values[argument.slice(2)] = argv[++index];
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const name of required) if (!values[name]) throw new Error(`Missing --${name}`);
  return values;
};

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

async function main() {
  const options = parseCli(process.argv.slice(2));
  const policyPath = path.resolve(options.policy);
  const launchPath = path.resolve(options.launch);
  const policy = await readJson(policyPath);
  const launch = await readJson(launchPath);
  const amount = BigInt(options['required-atomic-amount']);
  const lock = Number(options['minimum-lock-seconds']);
  if (amount <= 0n || !Number.isSafeInteger(lock)) throw new Error('Invalid stake amount or lock duration');

  const candidate = structuredClone(policy);
  candidate.identity.challengeEndpoint = options['challenge-endpoint'];
  candidate.identity.verifyEndpoint = options['verify-endpoint'];
  candidate.accessStake = {
    ...candidate.accessStake,
    status: 'active',
    programId: options['program-id'],
    configAddress: options['config-address'],
    mint: launch.execution?.mintAddress,
    requiredAtomicAmount: amount.toString(),
    minimumLockSeconds: lock,
    tokenEndpoint: options['token-endpoint'],
  };

  const receipt = await verifyAccessStake(candidate, launch);
  console.log(JSON.stringify({ mode: options.write ? 'write' : 'dry-run', ...receipt }, null, 2));
  if (!options.write) return;
  const temporary = `${policyPath}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(temporary, policyPath);
}

main().catch((error) => {
  console.error(`Access-stake policy staging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
