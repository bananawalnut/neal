import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { verifyAccessStake } from './verify-access-stake-readiness.mjs';

const CONFIG_SIZE = 171;
const CONFIG_DISCRIMINATOR = Buffer.from('NEALACFG');
const CONFIG_SEED = Buffer.from('access-config');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const parseCli = (argv) => {
  const values = {
    send: false,
    writePolicy: false,
    acknowledgeMainnet: false,
    policy: 'apps/site/public/wallet-policy.json',
    launch: 'apps/site/public/launch-record.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--send') values.send = true;
    else if (argument === '--write-policy') values.writePolicy = true;
    else if (argument === '--acknowledge-mainnet') values.acknowledgeMainnet = true;
    else if (argument.startsWith('--')) values[argument.slice(2)] = argv[++index];
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const required of ['action', 'cluster', 'rpc', 'program-id', 'config-address', 'authority-keypair']) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  if (!['pause', 'unpause'].includes(values.action)) throw new Error('--action must be pause or unpause');
  if (!['devnet', 'mainnet'].includes(values.cluster)) throw new Error('--cluster must be devnet or mainnet');
  if (values.cluster === 'mainnet') throw new Error('Direct mainnet authority changes are disabled; create and inspect an autonomous Squads v4 proposal');
  if (values.writePolicy && !values.send) throw new Error('--write-policy requires --send');
  if (values.writePolicy) throw new Error('Direct authority tooling never writes production policy');
  return values;
};

const parseConfig = (data) => {
  if (data.length !== CONFIG_SIZE || !data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR) || data[8] !== 2) {
    throw new Error('Config has an unsupported wire shape');
  }
  return {
    authority: new PublicKey(data.subarray(9, 41)),
    configId: data.readBigUInt64LE(73),
    revision: data.readBigUInt64LE(145),
    paused: data[169] !== 0,
    bump: data[170],
  };
};

const atomicJsonWrite = async (file, value) => {
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(temporary, file);
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  const rpc = new URL(options.rpc);
  if (rpc.protocol !== 'https:') throw new Error('--rpc must use HTTPS');
  const connection = new Connection(rpc.toString(), 'finalized');
  const expectedGenesis = DEVNET_GENESIS;
  if (await connection.getGenesisHash() !== expectedGenesis) throw new Error(`RPC genesis does not match ${options.cluster}`);

  const secret = JSON.parse(await fs.readFile(path.resolve(options['authority-keypair']), 'utf8'));
  if (!Array.isArray(secret) || secret.length !== 64 || secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Authority keypair file is invalid');
  }
  const authority = Keypair.fromSecretKey(Uint8Array.from(secret));
  const programId = new PublicKey(options['program-id']);
  const configAddress = new PublicKey(options['config-address']);
  const account = await connection.getAccountInfo(configAddress, 'finalized');
  if (!account || !account.owner.equals(programId)) throw new Error('Config is missing or owned by another program');
  const before = parseConfig(account.data);
  if (!before.authority.equals(authority.publicKey)) throw new Error('Authority keypair does not control this config');
  const configId = Buffer.alloc(8);
  configId.writeBigUInt64LE(before.configId);
  const expected = PublicKey.createProgramAddressSync(
    [CONFIG_SEED, authority.publicKey.toBuffer(), configId, Buffer.from([before.bump])],
    programId,
  );
  if (!expected.equals(configAddress)) throw new Error('Config address is not the expected PDA');

  const desiredPaused = options.action === 'pause';
  if (before.paused === desiredPaused) throw new Error(`Config is already ${desiredPaused ? 'paused' : 'active'}`);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: configAddress, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, desiredPaused ? 1 : 0]),
  });
  const latest = await connection.getLatestBlockhash('finalized');
  const transaction = new Transaction({
    feePayer: authority.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(instruction);
  transaction.sign(authority);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.err) {
    throw new Error(`Config simulation failed: ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).join('\n')}`);
  }
  const receipt = {
    mode: options.send ? 'send' : 'dry-run',
    action: options.action,
    cluster: options.cluster,
    programId: programId.toBase58(),
    configAddress: configAddress.toBase58(),
    authority: authority.publicKey.toBase58(),
    previousRevision: before.revision.toString(),
    expectedRevision: (before.revision + 1n).toString(),
    simulationUnits: simulation.value.unitsConsumed ?? null,
  };
  if (!options.send) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'finalized');
  if (confirmation.value.err) throw new Error(`Config transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  const finalized = await connection.getAccountInfo(configAddress, 'finalized');
  if (!finalized) throw new Error('Config disappeared after the finalized transaction');
  const after = parseConfig(finalized.data);
  if (after.paused !== desiredPaused || after.revision !== before.revision + 1n) {
    throw new Error('Finalized config state does not match the requested transition');
  }

  if (options.writePolicy) {
    const policyPath = path.resolve(options.policy);
    const launchPath = path.resolve(options.launch);
    const policy = JSON.parse(await fs.readFile(policyPath, 'utf8'));
    const launch = JSON.parse(await fs.readFile(launchPath, 'utf8'));
    if (policy.accessStake?.programId !== programId.toBase58() || policy.accessStake?.configAddress !== configAddress.toBase58()) {
      throw new Error('Policy references a different program or config');
    }
    const candidate = structuredClone(policy);
    candidate.accessStake.status = desiredPaused ? 'paused' : 'active';
    candidate.accessStake.configRevision = after.revision.toString();
    await verifyAccessStake(candidate, launch, { checkEndpoints: !desiredPaused });
    await atomicJsonWrite(policyPath, candidate);
  }

  console.log(JSON.stringify({ ...receipt, finalizedRevision: after.revision.toString(), signature, policyWritten: options.writePolicy }, null, 2));
}

main().catch((error) => {
  console.error(`Access-stake config management failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
