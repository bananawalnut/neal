import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const parseCli = (argv) => {
  const values = { send: false, acknowledgeMainnet: false, launch: 'apps/site/public/launch-record.json' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--send') values.send = true;
    else if (argument === '--acknowledge-mainnet') values.acknowledgeMainnet = true;
    else if (argument.startsWith('--')) values[argument.slice(2)] = argv[++index];
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const required of ['cluster', 'rpc', 'program-id', 'authority-keypair', 'config-id', 'required-atomic-amount', 'minimum-lock-seconds']) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  if (!['devnet', 'mainnet'].includes(values.cluster)) throw new Error('--cluster must be devnet or mainnet');
  if (values.cluster === 'mainnet' && values.send && !values.acknowledgeMainnet) {
    throw new Error('Mainnet submission requires --acknowledge-mainnet');
  }
  return values;
};

const unsigned = (value, bytes, label) => {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > (1n << BigInt(bytes * 8)) - 1n) throw new Error(`${label} is out of range`);
  return parsed;
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  const connection = new Connection(new URL(options.rpc).toString(), 'finalized');
  const genesis = await connection.getGenesisHash();
  const expectedGenesis = options.cluster === 'mainnet' ? MAINNET_GENESIS : DEVNET_GENESIS;
  if (genesis !== expectedGenesis) throw new Error(`RPC genesis does not match ${options.cluster}`);

  const secret = JSON.parse(await fs.readFile(path.resolve(options['authority-keypair']), 'utf8'));
  if (!Array.isArray(secret) || secret.length !== 64 || secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Authority keypair file is invalid');
  }
  const authority = Keypair.fromSecretKey(Uint8Array.from(secret));
  const programId = new PublicKey(options['program-id']);
  const configId = unsigned(options['config-id'], 8, 'config ID');
  const requiredAmount = unsigned(options['required-atomic-amount'], 8, 'required amount');
  const minimumLockSeconds = BigInt(options['minimum-lock-seconds']);
  if (requiredAmount === 0n || minimumLockSeconds <= 0n || minimumLockSeconds > 365n * 24n * 60n * 60n) {
    throw new Error('Stake terms are outside the on-chain bounds');
  }

  const launch = JSON.parse(await fs.readFile(path.resolve(options.launch), 'utf8'));
  const canonicalMint = new PublicKey(launch.execution?.mintAddress);
  if (options.cluster === 'devnet' && !options.mint) throw new Error('Devnet rehearsal requires --mint for its revoked-authority Token-2022 rehearsal mint');
  const mint = new PublicKey(options.mint ?? canonicalMint);
  if (options.cluster === 'mainnet' && !mint.equals(canonicalMint)) throw new Error('Mainnet config must use the canonical launch mint');
  const configIdBytes = Buffer.alloc(8);
  configIdBytes.writeBigUInt64LE(configId);
  const [configAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from('access-config'), authority.publicKey.toBuffer(), configIdBytes],
    programId,
  );
  const [programAccount, configAccount, mintAccount] = await Promise.all([
    connection.getAccountInfo(programId, 'finalized'),
    connection.getAccountInfo(configAddress, 'finalized'),
    connection.getParsedAccountInfo(mint, 'finalized'),
  ]);
  if (!programAccount?.executable) throw new Error('Program is not deployed as an executable account');
  if (configAccount) throw new Error(`Config already exists at ${configAddress.toBase58()}`);
  const parsedMint = mintAccount.value;
  if (!parsedMint || !parsedMint.owner.equals(TOKEN_2022_PROGRAM) || !('parsed' in parsedMint.data)) {
    throw new Error('Canonical mint is not a parsed Token-2022 mint');
  }
  const mintInfo = parsedMint.data.parsed?.info;
  if (
    parsedMint.data.parsed?.type !== 'mint'
    || mintInfo?.isInitialized !== true
    || mintInfo?.mintAuthority !== null
    || mintInfo?.freezeAuthority !== null
  ) {
    throw new Error('Canonical mint authorities are not permanently revoked');
  }
  const extensions = Array.isArray(mintInfo.extensions) ? mintInfo.extensions : [];
  const allowedExtensions = new Set(['metadataPointer', 'tokenMetadata']);
  if (extensions.some((item) => !allowedExtensions.has(item.extension))) {
    throw new Error('Mint contains an unreviewed Token-2022 extension');
  }
  const metadataPointer = extensions.find((item) => item.extension === 'metadataPointer')?.state;
  const tokenMetadata = extensions.find((item) => item.extension === 'tokenMetadata')?.state;
  if (
    (metadataPointer && (metadataPointer.authority !== null || metadataPointer.metadataAddress !== mint.toBase58()))
    || (tokenMetadata && (tokenMetadata.updateAuthority !== null || tokenMetadata.mint !== mint.toBase58()))
  ) throw new Error('Mint metadata authorities are not permanently revoked');

  const data = Buffer.alloc(25);
  data[0] = 0;
  data.writeBigUInt64LE(configId, 1);
  data.writeBigUInt64LE(requiredAmount, 9);
  data.writeBigInt64LE(minimumLockSeconds, 17);
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: configAddress, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
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
    cluster: options.cluster,
    programId: programId.toBase58(),
    authority: authority.publicKey.toBase58(),
    configAddress: configAddress.toBase58(),
    configId: configId.toString(),
    mint: mint.toBase58(),
    tokenDecimals: mintInfo.decimals,
    requiredAtomicAmount: requiredAmount.toString(),
    minimumLockSeconds: Number(minimumLockSeconds),
    simulationUnits: simulation.value.unitsConsumed ?? null,
  };
  if (!options.send) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'finalized');
  if (confirmation.value.err) throw new Error(`Config transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  console.log(JSON.stringify({ ...receipt, signature }, null, 2));
}

main().catch((error) => {
  console.error(`Access-stake config initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
