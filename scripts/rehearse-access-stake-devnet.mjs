import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHash, createPrivateKey, randomBytes, sign as signBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  transferChecked,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  DEVNET_GENESIS,
  LIFECYCLE_AMOUNT,
  LIFECYCLE_LOCK_SECONDS,
  PRODUCTION_AMOUNT,
  PRODUCTION_LOCK_SECONDS,
  REHEARSAL_SCHEMA,
  TOKEN_2022_PROGRAM,
  assertPublicEvidence,
  readAndValidateReleaseManifest,
  sha256File,
  validateRehearsalReceipt,
} from './access-stake-contracts.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
const COMPOSE = path.join(ROOT, 'infra/neal-access-rehearsal/compose.yaml');
const DOCKERFILE = path.join(ROOT, 'infra/neal-access-rehearsal/Dockerfile.sbf');
const FAULT_PROXY = path.join(ROOT, 'infra/neal-access-rehearsal/fault_proxy.py');
const ISSUER_DIR = path.join(ROOT, 'infra/neal-access-issuer');
const ISSUER = path.join(ISSUER_DIR, 'issuer.py');
const RECONCILE = path.join(ISSUER_DIR, 'reconcile.py');
const BACKUP = path.join(ISSUER_DIR, 'backup.py');
const POLICY = path.join(ROOT, 'apps/site/public/wallet-policy.json');
const TOOLCHAIN_IMAGE = 'neal-access-stake-devnet-toolchain:v4.2.1';
const POSTGRES_REHEARSAL_IMAGE = 'postgres:16.15-bookworm@sha256:1938c16e9d2f10a6a3623b344b64ae8d45f407f2c5f34f0979468bb689b9227a';
const SYNAPSE_REHEARSAL_IMAGE = 'matrixdotorg/synapse:v1.157.2@sha256:3827b727cb40c52d7d4806db2eb96058eb4514e94a79ca1d7b805de7a8fc44d9';
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const MINTED_ATOMIC = 140_000_000_000n;

export const parseCli = (argv) => {
  const values = { execute: false, acknowledgeDevnet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') values.execute = true;
    else if (argument === '--acknowledge-devnet') values.acknowledgeDevnet = true;
    else if (argument.startsWith('--')) values[argument.slice(2)] = argv[++index];
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  for (const required of ['release-manifest', 'rpc-primary', 'rpc-secondary', 'review-file']) {
    if (!values[required]) throw new Error(`Missing --${required}`);
  }
  if (values.acknowledgeDevnet && !values.execute) throw new Error('--acknowledge-devnet requires --execute');
  if (values.execute && !values.acknowledgeDevnet) throw new Error('Devnet writes require --execute --acknowledge-devnet');
  return values;
};

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const capture = options.capture === true;
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve(stdout.trim());
    else reject(new Error(options.failure ?? `${command} exited ${code ?? signal}${capture && stderr ? `: ${stderr.trim()}` : ''}`));
  });
});

const jsonCommand = async (command, args, options = {}) => {
  const output = await run(command, args, { ...options, capture: true });
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(options.failure ?? `${command} returned invalid JSON`);
  }
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const checkedUrl = (value, label) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${label} must be a credential-free HTTPS URL`);
  return url;
};

const atomicWrite = async (file, value, mode = 0o644) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, value, { mode });
  await fs.rename(temporary, file);
  await fs.chmod(file, mode);
};

const writePrivate = (file, value) => atomicWrite(file, value, 0o600);
const writeKeypair = (file, keypair) => writePrivate(file, `${JSON.stringify(Array.from(keypair.secretKey))}\n`);
const base64url = (value) => Buffer.from(value).toString('base64url');

export function validateReview(value, sourceCommit) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Review attestation must be an object');
  const allowed = ['schema', 'sourceCommit', 'reviewedAt', 'reviewerType', 'findings'];
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`Review attestation contains unsupported fields: ${extra.join(', ')}`);
  if (value.schema !== 'neal.access-stake-isolated-review/v1') throw new Error('Unsupported review attestation schema');
  if (value.sourceCommit !== sourceCommit) throw new Error('Review attestation does not cover the release source commit');
  if (value.reviewerType !== 'isolated-agent') throw new Error('Review must come from an isolated agent');
  if (typeof value.reviewedAt !== 'string' || Number.isNaN(Date.parse(value.reviewedAt))) throw new Error('Review timestamp is invalid');
  const findings = value.findings;
  if (!findings || !['p0', 'p1', 'p2'].every((key) => Number.isSafeInteger(findings[key]) && findings[key] === 0)) {
    throw new Error('Review has unresolved P0-P2 findings');
  }
  if (Object.keys(findings).some((key) => !['p0', 'p1', 'p2'].includes(key))) throw new Error('Review findings contain unsupported severities');
  return value;
}

const assertPlannedPolicy = async () => {
  const policy = JSON.parse(await fs.readFile(POLICY, 'utf8'));
  const stake = policy.accessStake;
  if (!stake || stake.status !== 'planned') throw new Error('wallet-policy.json must remain planned for the devnet gate');
  for (const field of ['programId', 'programDataAddress', 'programSha256', 'configAddress', 'configRevision', 'issuerAuthority', 'tokenEndpoint']) {
    if (stake[field] !== null) throw new Error(`wallet-policy.json accessStake.${field} must remain null`);
  }
};

const agreement = async (primary, secondary) => {
  const [firstGenesis, secondGenesis] = await Promise.all([primary.getGenesisHash(), secondary.getGenesisHash()]);
  if (firstGenesis !== DEVNET_GENESIS || secondGenesis !== DEVNET_GENESIS) throw new Error('Both RPCs must report Solana devnet genesis');
  const slots = await Promise.all([primary.getSlot('finalized'), secondary.getSlot('finalized')]);
  for (let offset = 0; offset < 64; offset += 1) {
    const slot = Math.min(...slots) - offset;
    if (slot <= 0) break;
    const blocks = await Promise.all([
      primary.getBlock(slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }),
      secondary.getBlock(slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }),
    ]);
    if (blocks[0] && blocks[1]) {
      if (blocks[0].blockhash !== blocks[1].blockhash || blocks[0].previousBlockhash !== blocks[1].previousBlockhash) {
        throw new Error('Independent RPCs disagree on a finalized devnet block');
      }
      return { genesisHash: firstGenesis, slot };
    }
  }
  throw new Error('Independent RPCs could not establish a shared finalized devnet block');
};

const compose = (project, runtime, args, options = {}) => run('docker', [
  'compose', '--file', COMPOSE, '--project-name', project, ...args,
], {
  ...options,
  env: {
    ...process.env,
    NEAL_REHEARSAL_RUNTIME: runtime,
    NEAL_REHEARSAL_UID: String(process.getuid?.() ?? 1000),
    NEAL_REHEARSAL_GID: String(process.getgid?.() ?? 1000),
  },
});

const stopProcess = async (child) => {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
  if (graceful) return;
  if (!child.kill('SIGKILL')) throw new Error('Could not terminate a rehearsal child process');
  const killed = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
  if (!killed) throw new Error('A rehearsal child process did not exit after SIGKILL');
};

const waitHttp = async (url, expected, attempts = 60) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (expected.includes(response.status)) return response;
    } catch {
      // Service startup is intentionally retried without logging connection details.
    }
    await sleep(1_000);
  }
  throw new Error('A loopback rehearsal service did not become ready');
};

const renderSynapse = async (runtime, matrixSecret) => {
  const postgresPassword = randomBytes(32).toString('base64url');
  const signingId = randomBytes(4).toString('hex');
  const signingSeed = randomBytes(32).toString('base64').replace(/=+$/u, '');
  await writePrivate(path.join(runtime, 'postgres-password'), `${postgresPassword}\n`);
  await writePrivate(path.join(runtime, 'matrix-registration-secret'), `${matrixSecret}\n`);
  await writePrivate(path.join(runtime, 'rehearsal.signing.key'), `ed25519 a_${signingId} ${signingSeed}\n`);
  await atomicWrite(path.join(runtime, 'synapse.log.config'), [
    'version: 1',
    'formatters:',
    '  precise:',
    "    format: '%(asctime)s %(name)s %(levelname)s %(message)s'",
    'handlers:',
    '  console:',
    '    class: logging.StreamHandler',
    '    formatter: precise',
    'root:',
    '  level: WARNING',
    '  handlers: [console]',
    'disable_existing_loggers: false',
    '',
  ].join('\n'));
  await writePrivate(path.join(runtime, 'homeserver.yaml'), [
    'server_name: rehearsal.neal.invalid',
    'public_baseurl: http://127.0.0.1:18008/',
    'pid_file: /tmp/homeserver.pid',
    'listeners:',
    '  - port: 8008',
    '    tls: false',
    '    type: http',
    "    bind_addresses: ['0.0.0.0']",
    '    x_forwarded: false',
    '    resources:',
    '      - names: [client]',
    '        compress: false',
    'database:',
    '  name: psycopg2',
    '  args:',
    '    user: synapse_rehearsal',
    `    password: ${JSON.stringify(postgresPassword)}`,
    '    database: synapse_rehearsal',
    '    host: postgres',
    '    port: 5432',
    '    cp_min: 1',
    '    cp_max: 5',
    'log_config: /data/synapse.log.config',
    'media_store_path: /data/media_store',
    `registration_shared_secret: ${JSON.stringify(matrixSecret)}`,
    'enable_registration: true',
    'enable_registration_without_verification: true',
    'registration_requires_token: true',
    `macaroon_secret_key: ${JSON.stringify(randomBytes(32).toString('base64url'))}`,
    `form_secret: ${JSON.stringify(randomBytes(32).toString('base64url'))}`,
    'signing_key_path: /data/rehearsal.signing.key',
    'trusted_key_servers: []',
    'suppress_key_server_warning: true',
    'report_stats: false',
    '',
  ].join('\n'));
};

const startLoggedProcess = async (command, args, env, logFile) => {
  const descriptor = fsSync.openSync(logFile, 'a', 0o600);
  const child = spawn(command, args, { cwd: ISSUER_DIR, env, stdio: ['ignore', descriptor, descriptor] });
  child.once('exit', () => fsSync.closeSync(descriptor));
  return child;
};

const siwsMessage = (input) => {
  const lines = [`${input.domain} wants you to sign in with your Solana account:`, input.address];
  if (input.statement) lines.push('', input.statement);
  lines.push('', `URI: ${input.uri}`, `Version: ${input.version}`, `Chain ID: ${input.chainId}`, `Nonce: ${input.nonce}`, `Issued At: ${input.issuedAt}`);
  for (const [key, label] of [['expirationTime', 'Expiration Time'], ['notBefore', 'Not Before'], ['requestId', 'Request ID']]) {
    if (input[key]) lines.push(`${label}: ${input[key]}`);
  }
  if (input.resources?.length) lines.push('Resources:', ...input.resources.map((resource) => `- ${resource}`));
  return Buffer.from(lines.join('\n'));
};

const issuerSession = async (wallet) => {
  const address = wallet.publicKey.toBase58();
  const common = { Origin: 'https://rehearsal.neal.invalid', 'Content-Type': 'application/json' };
  const challengeResponse = await fetch('http://127.0.0.1:18009/v1/challenge', {
    method: 'POST', headers: common, body: JSON.stringify({ schema: 'neal.wallet-challenge-request/v1', address, chain: 'solana:devnet' }),
  });
  if (!challengeResponse.ok) throw new Error('Rehearsal issuer rejected the wallet challenge');
  const challenge = await challengeResponse.json();
  const message = siwsMessage(challenge.signInInput);
  const seed = Buffer.from(wallet.secretKey.subarray(0, 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const signature = signBytes(null, message, privateKey);
  const verification = {
    schema: 'neal.wallet-verification/v1',
    method: 'solana:signIn',
    signInInput: challenge.signInInput,
    output: {
      account: { address, publicKey: base64url(wallet.publicKey.toBytes()) },
      signedMessage: base64url(message),
      signature: base64url(signature),
      signatureType: 'ed25519',
    },
  };
  const response = await fetch('http://127.0.0.1:18009/v1/verify', { method: 'POST', headers: common, body: JSON.stringify(verification) });
  if (!response.ok) throw new Error('Rehearsal issuer rejected the signed wallet challenge');
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Rehearsal issuer did not create a wallet session');
  return cookie;
};

const requestAccessToken = async (cookie) => {
  const response = await fetch('http://127.0.0.1:18009/v1/access-token', {
    method: 'POST',
    headers: { Origin: 'https://rehearsal.neal.invalid', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ schema: 'neal.matrix-access-token-request/v1' }),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};

export const matrixAttempt = async (registrationToken, shouldSucceed) => {
  const base = { username: `rehearsal_${randomBytes(8).toString('hex')}`, password: randomBytes(36).toString('base64url') };
  const request = (body) => fetch('http://127.0.0.1:18008/_matrix/client/v3/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const started = await request(base);
  const startedBody = await started.json().catch(() => ({}));
  const session = startedBody.session;
  const supported = startedBody.flows?.some((flow) => (
    Array.isArray(flow.stages)
    && flow.stages.includes('m.login.registration_token')
    && flow.stages.includes('m.login.dummy')
  ));
  if (started.status !== 401 || typeof session !== 'string' || !supported) {
    throw new Error('Pinned Synapse did not advertise the expected registration-token and dummy UIA flow');
  }

  const tokenStage = await request({
    ...base,
    auth: { type: 'm.login.registration_token', token: registrationToken, session },
  });
  const tokenBody = await tokenStage.json().catch(() => ({}));
  const tokenAccepted = tokenStage.status === 401
    && Array.isArray(tokenBody.completed)
    && tokenBody.completed.includes('m.login.registration_token');
  if (!tokenAccepted) {
    if (shouldSucceed) throw new Error('Synapse rejected the freshly issued one-use registration token');
    if (tokenStage.ok) throw new Error('Synapse completed registration without the required dummy UIA stage');
    return tokenBody;
  }

  const finalStage = await request({ ...base, auth: { type: 'm.login.dummy', session } });
  const finalBody = await finalStage.json().catch(() => ({}));
  if (shouldSucceed && !finalStage.ok) throw new Error('Synapse did not finish account creation after both UIA stages');
  if (!shouldSucceed && finalStage.ok) throw new Error('Synapse accepted a replayed one-use registration token');
  return finalBody;
};

const buildToolchain = () => run('docker', [
  'build', '--platform', 'linux/amd64', '--file', DOCKERFILE, '--tag', TOOLCHAIN_IMAGE, ROOT,
]);

const dockerSolana = (runtime, artifactFile, args, options = {}) => run('docker', [
  'run', '--rm', '--platform', 'linux/amd64',
  '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  '--env', 'HOME=/tmp',
  '--volume', `${runtime}:/rehearsal`,
  '--volume', `${path.dirname(artifactFile)}:/release:ro`,
  TOOLCHAIN_IMAGE,
  ...args,
], options);

const send = (connection, instructions, signers) => sendAndConfirmTransaction(
  connection,
  new Transaction().add(...instructions),
  signers,
  { commitment: 'finalized', preflightCommitment: 'finalized', maxRetries: 3 },
);

const expectRejected = async (operation, label) => {
  try {
    await operation();
  } catch {
    return true;
  }
  throw new Error(`${label} unexpectedly succeeded`);
};

const fundWithAirdrop = async (connection, account, targetLamports) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const balance = await connection.getBalance(account, 'finalized');
    if (balance >= targetLamports) return balance;
    try {
      const signature = await connection.requestAirdrop(account, Math.min(2 * LAMPORTS_PER_SOL, targetLamports - balance));
      const result = await connection.confirmTransaction(signature, 'finalized');
      if (result.value.err) throw new Error('airdrop failed');
    } catch {
      await sleep(3_000);
    }
  }
  const balance = await connection.getBalance(account, 'finalized');
  if (balance < targetLamports) throw new Error('Devnet faucet could not fund the disposable deployer');
  return balance;
};

const fundSigners = async (connection, deployer, signers) => {
  const transfers = signers.map((signer) => SystemProgram.transfer({
    fromPubkey: deployer.publicKey,
    toPubkey: signer.publicKey,
    lamports: 50_000_000,
  }));
  await send(connection, transfers, [deployer]);
};

const receiptAddress = (programId, config, staker) => PublicKey.findProgramAddressSync(
  [Buffer.from('access-stake'), config.toBuffer(), staker.toBuffer()],
  programId,
)[0];

const stakeInstruction = ({ programId, config, mint, staker, source, amount, lockSeconds, revision }) => {
  const receipt = receiptAddress(programId, config, staker);
  const vault = getAssociatedTokenAddressSync(mint, receipt, true, TOKEN_2022_PROGRAM_ID);
  const createVault = createAssociatedTokenAccountIdempotentInstruction(
    staker, vault, receipt, mint, TOKEN_2022_PROGRAM_ID,
  );
  const data = Buffer.alloc(26);
  data[0] = 3;
  data[1] = 6;
  data.writeBigUInt64LE(BigInt(amount), 2);
  data.writeBigInt64LE(BigInt(lockSeconds), 10);
  data.writeBigUInt64LE(BigInt(revision), 18);
  return {
    receipt,
    vault,
    instructions: [createVault, new TransactionInstruction({
      programId,
      keys: [
        { pubkey: staker, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: receipt, isSigner: false, isWritable: true },
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    })],
  };
};

const claimInstruction = (programId, config, staker) => new TransactionInstruction({
  programId,
  keys: [
    { pubkey: staker, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: receiptAddress(programId, config, staker), isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([4]),
});

const unstakeInstruction = (programId, config, mint, staker, vault, destination) => new TransactionInstruction({
  programId,
  keys: [
    { pubkey: staker, isSigner: true, isWritable: false },
    { pubkey: config, isSigner: false, isWritable: false },
    { pubkey: receiptAddress(programId, config, staker), isSigner: false, isWritable: true },
    { pubkey: vault, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([6, 6]),
});

const readReceipt = async (connection, address) => {
  const account = await connection.getAccountInfo(address, 'finalized');
  if (!account || account.data.length !== 163 || !account.data.subarray(0, 8).equals(Buffer.from('NEALSTAK'))) {
    throw new Error('Finalized rehearsal receipt has an invalid wire shape');
  }
  return {
    unlockAt: Number(account.data.readBigInt64LE(129)),
    claimedAt: Number(account.data.readBigInt64LE(137)),
    issuedAt: Number(account.data.readBigInt64LE(145)),
    releasedAt: Number(account.data.readBigInt64LE(153)),
  };
};

const configCommand = async ({ runtime, artifactFile, rpc, programId, programData, hash, mint, deployer, issuer, configId, amount, lock }) => {
  const result = await jsonCommand(process.execPath, [
    path.join(ROOT, 'scripts/initialize-access-stake-config.mjs'),
    '--cluster', 'devnet', '--rpc', rpc,
    '--program-id', programId.toBase58(), '--program-data-address', programData.toBase58(),
    '--program-sha256', hash, '--mint', mint.toBase58(),
    '--authority-keypair', path.join(runtime, 'deployer.json'),
    '--issuer-authority', issuer.publicKey.toBase58(), '--config-id', String(configId),
    '--required-atomic-amount', String(amount), '--minimum-lock-seconds', String(lock), '--send',
  ], { failure: 'Access-stake config initialization failed' });
  return { ...result, address: new PublicKey(result.configAddress) };
};

const pauseCommand = async ({ runtime, rpc, programId, config, action }) => jsonCommand(process.execPath, [
  path.join(ROOT, 'scripts/manage-access-stake-config.mjs'),
  '--action', action, '--cluster', 'devnet', '--rpc', rpc,
  '--program-id', programId.toBase58(), '--config-address', config.toBase58(),
  '--authority-keypair', path.join(runtime, 'deployer.json'), '--send',
], { failure: `Devnet config ${action} failed` });

const attestProgram = async (connection, programId, programData, expectedHash) => {
  const [program, data] = await Promise.all([
    connection.getAccountInfo(programId, 'finalized'),
    connection.getAccountInfo(programData, 'finalized'),
  ]);
  if (!program?.executable || !program.owner.equals(UPGRADEABLE_LOADER) || !data || !data.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error('Deployed rehearsal program is missing or owned by another loader');
  }
  if (program.data.readUInt32LE(0) !== 2 || !new PublicKey(program.data.subarray(4, 36)).equals(programData)) {
    throw new Error('Program account does not reference the expected ProgramData');
  }
  if (data.data.readUInt32LE(0) !== 3 || data.data[12] !== 0) throw new Error('Rehearsal program is still upgradeable');
  const deployedHash = createHash('sha256').update(data.data.subarray(45)).digest('hex');
  if (deployedHash !== expectedHash) throw new Error('Finalized ProgramData bytes differ from the release artifact');
  return deployedHash;
};

const startIssuer = async ({ python, runtime, rpcPrimary, rpcSecondary, programId, programData, programHash, config, mint }) => {
  const environment = {
    ...process.env,
    NEAL_ACCESS_DATABASE: path.join(runtime, 'issuer.sqlite3'),
    NEAL_ACCESS_SOLANA_RPCS: `${rpcPrimary},${rpcSecondary}`,
    NEAL_ACCESS_CHAIN_ID: 'solana:devnet',
    NEAL_ACCESS_SOLANA_GENESIS_HASH: DEVNET_GENESIS,
    NEAL_ACCESS_PROGRAM_ID: programId.toBase58(),
    NEAL_ACCESS_PROGRAM_DATA_ADDRESS: programData.toBase58(),
    NEAL_ACCESS_PROGRAM_SHA256: programHash,
    NEAL_ACCESS_CONFIG_ADDRESS: config.address.toBase58(),
    NEAL_ACCESS_MINT: mint.toBase58(),
    NEAL_ACCESS_EXPECTED_REVISION: '0',
    NEAL_ACCESS_EXPECTED_AMOUNT: PRODUCTION_AMOUNT,
    NEAL_ACCESS_EXPECTED_LOCK_SECONDS: String(PRODUCTION_LOCK_SECONDS),
    NEAL_ACCESS_ISSUER_KEYPAIR_FILE: path.join(runtime, 'issuer.json'),
    NEAL_ACCESS_PUBLIC_ORIGIN: 'https://rehearsal.neal.invalid',
    NEAL_ACCESS_MATRIX_URL: 'http://127.0.0.1:18010',
    NEAL_ACCESS_MATRIX_SECRET_FILE: path.join(runtime, 'matrix-registration-secret'),
    NEAL_ACCESS_BIND: '127.0.0.1',
    NEAL_ACCESS_PORT: '18009',
  };
  const child = await startLoggedProcess(python, [ISSUER], environment, path.join(runtime, 'issuer.log'));
  await waitHttp('http://127.0.0.1:18009/healthz', [200]);
  return { child, environment };
};

const installPython = async (runtime) => {
  await run('python3.13', ['-m', 'venv', path.join(runtime, 'venv')], { failure: 'Python 3.13 is required for the rehearsal issuer' });
  const python = path.join(runtime, 'venv/bin/python');
  await run(python, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--require-hashes',
    '--requirement', path.join(ISSUER_DIR, 'requirements-deploy.txt'),
  ], { failure: 'Could not install the hash-locked issuer dependencies' });
  return python;
};

const createRehearsalMint = async (connection, deployer, wallets) => {
  const mintKeypair = Keypair.generate();
  const mint = await createMint(
    connection, deployer, deployer.publicKey, deployer.publicKey, 6, mintKeypair,
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
  );
  const treasury = await getOrCreateAssociatedTokenAccount(
    connection, deployer, mint, deployer.publicKey, false, 'finalized',
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(connection, deployer, mint, treasury.address, deployer, MINTED_ATOMIC, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  const allocations = [
    [wallets.parityOne, 69_000_000_000n],
    [wallets.parityTwo, 69_000_000_000n],
    [wallets.lifecycle, 1_000_001n],
    [wallets.pausedAttempt, 1_000_000n],
  ];
  const accounts = {};
  for (const [wallet, amount] of allocations) {
    const account = await getOrCreateAssociatedTokenAccount(
      connection, deployer, mint, wallet.publicKey, false, 'finalized',
      { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
    );
    await transferChecked(connection, deployer, treasury.address, mint, account.address, deployer, amount, 6, [],
      { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
    accounts[wallet.publicKey.toBase58()] = account.address;
  }
  await setAuthority(connection, deployer, mint, deployer, AuthorityType.MintTokens, null, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  await setAuthority(connection, deployer, mint, deployer, AuthorityType.FreezeAccount, null, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  const mintState = await getMint(connection, mint, 'finalized', TOKEN_2022_PROGRAM_ID);
  if (mintState.mintAuthority !== null || mintState.freezeAuthority !== null || mintState.decimals !== 6 || mintState.supply !== MINTED_ATOMIC) {
    throw new Error('Rehearsal mint authorities or supply do not match the plan');
  }
  return { mint, accounts };
};

async function execute(options, release, review, rpcAgreement) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'neal-access-rehearsal-'));
  await fs.chmod(runtime, 0o700);
  const project = `neal-rehearsal-${process.pid}`;
  const publicLog = [];
  let issuerProcess;
  let proxyProcess;
  let issuerEnvironment;
  let receipt;
  try {
    const mark = (step) => publicLog.push({ step, status: 'passed' });
    const deployer = Keypair.generate();
    const issuer = Keypair.generate();
    const wallets = {
      parityOne: Keypair.generate(),
      parityTwo: Keypair.generate(),
      lifecycle: Keypair.generate(),
      pausedAttempt: Keypair.generate(),
    };
    const programKeypair = Keypair.generate();
    await Promise.all([
      writeKeypair(path.join(runtime, 'deployer.json'), deployer),
      writeKeypair(path.join(runtime, 'issuer.json'), issuer),
      writeKeypair(path.join(runtime, 'program.json'), programKeypair),
      ...Object.entries(wallets).map(([name, wallet]) => writeKeypair(path.join(runtime, `${name}.json`), wallet)),
    ]);
    const matrixSecret = randomBytes(48).toString('base64url');
    await renderSynapse(runtime, matrixSecret);
    const python = await installPython(runtime);
    await buildToolchain();
    mark('pinned-toolchains-ready');

    await compose(project, runtime, ['up', '--detach', '--wait']);
    await waitHttp('http://127.0.0.1:18008/_matrix/client/versions', [200]);
    proxyProcess = await startLoggedProcess(python, [FAULT_PROXY], process.env, path.join(runtime, 'fault-proxy.log'));
    await waitHttp('http://127.0.0.1:18010/_matrix/client/versions', [200]);
    mark('isolated-synapse-ready');

    const connection = new Connection(options['rpc-primary'], 'finalized');
    await fundWithAirdrop(connection, deployer.publicKey, 4 * LAMPORTS_PER_SOL);
    await fundSigners(connection, deployer, [issuer, ...Object.values(wallets)]);
    mark('disposable-identities-funded');

    await dockerSolana(runtime, release.artifactFile, [
      'solana', 'program', 'deploy', `/release/${path.basename(release.artifactFile)}`,
      '--program-id', '/rehearsal/program.json', '--upgrade-authority', '/rehearsal/deployer.json',
      '--keypair', '/rehearsal/deployer.json', '--url', options['rpc-primary'], '--commitment', 'finalized',
    ], { failure: 'Devnet program deployment failed' });
    const programId = programKeypair.publicKey;
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER);
    await dockerSolana(runtime, release.artifactFile, [
      'solana', 'program', 'set-upgrade-authority', programId.toBase58(), '--final',
      '--upgrade-authority', '/rehearsal/deployer.json', '--keypair', '/rehearsal/deployer.json',
      '--url', options['rpc-primary'], '--commitment', 'finalized',
    ], { failure: 'Could not finalize the devnet upgrade authority' });
    await dockerSolana(runtime, release.artifactFile, [
      'solana', 'program', 'dump', programId.toBase58(), '/rehearsal/deployed.so',
      '--url', options['rpc-primary'],
    ], { failure: 'Could not dump finalized devnet program bytes' });
    const dumpHash = await sha256File(path.join(runtime, 'deployed.so'));
    if (dumpHash !== release.manifest.artifact.sha256) throw new Error('solana program dump differs from the release artifact');
    const programHash = await attestProgram(connection, programId, programData, release.manifest.artifact.sha256);
    mark('immutable-program-attested');

    const { mint, accounts } = await createRehearsalMint(connection, deployer, wallets);
    mark('token-2022-mint-created-and-authorities-disabled');
    const parityConfig = await configCommand({
      runtime, artifactFile: release.artifactFile, rpc: options['rpc-primary'], programId, programData,
      hash: programHash, mint, deployer, issuer, configId: 0, amount: PRODUCTION_AMOUNT, lock: PRODUCTION_LOCK_SECONDS,
    });
    const lifecycleConfig = await configCommand({
      runtime, artifactFile: release.artifactFile, rpc: options['rpc-primary'], programId, programData,
      hash: programHash, mint, deployer, issuer, configId: 1, amount: LIFECYCLE_AMOUNT, lock: LIFECYCLE_LOCK_SECONDS,
    });
    mark('two-configs-finalized');

    ({ child: issuerProcess, environment: issuerEnvironment } = await startIssuer({
      python, runtime, rpcPrimary: options['rpc-primary'], rpcSecondary: options['rpc-secondary'],
      programId, programData, programHash, config: parityConfig, mint,
    }));
    await waitHttp('http://127.0.0.1:18009/readyz', [200]);
    mark('issuer-ready');

    const parityOneStake = stakeInstruction({
      programId, config: parityConfig.address, mint, staker: wallets.parityOne.publicKey,
      source: accounts[wallets.parityOne.publicKey.toBase58()], amount: PRODUCTION_AMOUNT,
      lockSeconds: PRODUCTION_LOCK_SECONDS, revision: 0,
    });
    await send(connection, parityOneStake.instructions, [wallets.parityOne]);
    await send(connection, [claimInstruction(programId, parityConfig.address, wallets.parityOne.publicKey)], [wallets.parityOne]);
    const cookieOne = await issuerSession(wallets.parityOne);
    const backupPassphrase = path.join(runtime, 'backup-passphrase');
    const backupFile = path.join(runtime, 'stale-issuer.nealbak');
    await writePrivate(backupPassphrase, `${randomBytes(32).toString('base64url')}\n`);
    await run(python, [BACKUP, 'backup', '--database', path.join(runtime, 'issuer.sqlite3'), '--output', backupFile, '--passphrase-file', backupPassphrase], {
      cwd: ISSUER_DIR, failure: 'Encrypted stale issuer backup failed',
    });
    const issued = await requestAccessToken(cookieOne);
    if (!issued.response.ok || typeof issued.body.token !== 'string') throw new Error('Issuer did not return the first one-use token');
    await matrixAttempt(issued.body.token, true);
    await matrixAttempt(issued.body.token, false);
    const consumed = await readReceipt(connection, parityOneStake.receipt);
    if (consumed.issuedAt <= 0) throw new Error('Issuer did not finalize on-chain consumption before Matrix issuance');
    mark('parity-stake-claim-consume-and-single-use-registration');

    await stopProcess(issuerProcess);
    issuerProcess = undefined;
    await run(python, [BACKUP, 'restore', '--input', backupFile, '--database', path.join(runtime, 'issuer.sqlite3'), '--passphrase-file', backupPassphrase, '--replace'], {
      cwd: ISSUER_DIR, failure: 'Encrypted issuer restore failed',
    });
    ({ child: issuerProcess, environment: issuerEnvironment } = await startIssuer({
      python, runtime, rpcPrimary: options['rpc-primary'], rpcSecondary: options['rpc-secondary'],
      programId, programData, programHash, config: parityConfig, mint,
    }));
    await waitHttp('http://127.0.0.1:18009/readyz', [200]);
    const replay = await requestAccessToken(cookieOne);
    if (replay.response.status !== 422 || replay.body.error !== 'Finalized stake receipt is not eligible') {
      throw new Error('Stale restore did not fail specifically on finalized on-chain consumption');
    }
    mark('encrypted-stale-restore-replay-rejected');

    const parityTwoStake = stakeInstruction({
      programId, config: parityConfig.address, mint, staker: wallets.parityTwo.publicKey,
      source: accounts[wallets.parityTwo.publicKey.toBase58()], amount: PRODUCTION_AMOUNT,
      lockSeconds: PRODUCTION_LOCK_SECONDS, revision: 0,
    });
    await send(connection, parityTwoStake.instructions, [wallets.parityTwo]);
    await send(connection, [claimInstruction(programId, parityConfig.address, wallets.parityTwo.publicKey)], [wallets.parityTwo]);
    const cookieTwo = await issuerSession(wallets.parityTwo);
    const arm = await fetch('http://127.0.0.1:18010/__fault/arm', { method: 'POST' });
    if (!arm.ok) throw new Error('Could not arm the one-shot cleanup fault');
    const faulted = await requestAccessToken(cookieTwo);
    if (faulted.response.ok) throw new Error('Injected temporary-admin cleanup failure did not halt issuance');
    const halted = await fetch('http://127.0.0.1:18009/readyz');
    if (halted.status !== 503) throw new Error('Issuer readiness did not halt after temporary-admin cleanup failure');
    const pending = await jsonCommand(python, [RECONCILE, '--environment-file', path.join(runtime, 'no-environment-file'), '--list'], {
      cwd: ISSUER_DIR, env: issuerEnvironment, failure: 'Could not inspect cleanup reconciliation state',
    });
    if (!Array.isArray(pending.pending) || pending.pending.length !== 1 || typeof pending.pending[0].user_id !== 'string') {
      throw new Error('Cleanup failure did not create exactly one durable reconciliation record');
    }
    const reconciliation = await jsonCommand(python, [
      RECONCILE, '--environment-file', path.join(runtime, 'no-environment-file'), '--user-id', pending.pending[0].user_id,
    ], { cwd: ISSUER_DIR, env: issuerEnvironment, failure: 'Temporary-admin reconciliation failed' });
    if (reconciliation.pendingCount !== 0) throw new Error('Temporary-admin reconciliation left unresolved records');
    const afterReconciliation = await jsonCommand(python, [
      RECONCILE, '--environment-file', path.join(runtime, 'no-environment-file'), '--list',
    ], { cwd: ISSUER_DIR, env: issuerEnvironment, failure: 'Could not verify cleanup reconciliation state' });
    if (!Array.isArray(afterReconciliation.pending) || afterReconciliation.pending.length !== 0) {
      throw new Error('Temporary-admin cleanup record remained after reconciliation');
    }
    await waitHttp('http://127.0.0.1:18009/readyz', [200]);
    mark('cleanup-failure-halted-and-reconciled');

    const lifecycleSource = accounts[wallets.lifecycle.publicKey.toBase58()];
    const lifecycleStake = stakeInstruction({
      programId, config: lifecycleConfig.address, mint, staker: wallets.lifecycle.publicKey,
      source: lifecycleSource, amount: LIFECYCLE_AMOUNT, lockSeconds: LIFECYCLE_LOCK_SECONDS, revision: 0,
    });
    await getOrCreateAssociatedTokenAccount(
      connection, deployer, mint, lifecycleStake.receipt, true, 'finalized',
      { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
    );
    await transferChecked(connection, wallets.lifecycle, lifecycleSource, mint, lifecycleStake.vault, wallets.lifecycle, 1n, 6, [],
      { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
    await send(connection, lifecycleStake.instructions, [wallets.lifecycle]);
    await expectRejected(
      () => send(connection, [unstakeInstruction(programId, lifecycleConfig.address, mint, wallets.lifecycle.publicKey, lifecycleStake.vault, lifecycleSource)], [wallets.lifecycle]),
      'early unstake',
    );
    const paused = await pauseCommand({ runtime, rpc: options['rpc-primary'], programId, config: lifecycleConfig.address, action: 'pause' });
    if (paused.finalizedRevision !== '1') throw new Error('Lifecycle pause did not finalize revision 1');
    await expectRejected(
      () => send(connection, [claimInstruction(programId, lifecycleConfig.address, wallets.lifecycle.publicKey)], [wallets.lifecycle]),
      'claim while paused',
    );
    const pausedStake = stakeInstruction({
      programId, config: lifecycleConfig.address, mint, staker: wallets.pausedAttempt.publicKey,
      source: accounts[wallets.pausedAttempt.publicKey.toBase58()], amount: LIFECYCLE_AMOUNT,
      lockSeconds: LIFECYCLE_LOCK_SECONDS, revision: 1,
    });
    await expectRejected(() => send(connection, pausedStake.instructions, [wallets.pausedAttempt]), 'new stake while paused');
    const lifecycleReceipt = await readReceipt(connection, lifecycleStake.receipt);
    const waitMilliseconds = Math.max(0, (lifecycleReceipt.unlockAt - Math.floor(Date.now() / 1000) + 2) * 1000);
    await sleep(waitMilliseconds);
    const beforeRefund = (await getAccount(connection, lifecycleSource, 'finalized', TOKEN_2022_PROGRAM_ID)).amount;
    await send(connection, [unstakeInstruction(programId, lifecycleConfig.address, mint, wallets.lifecycle.publicKey, lifecycleStake.vault, lifecycleSource)], [wallets.lifecycle]);
    const afterRefund = (await getAccount(connection, lifecycleSource, 'finalized', TOKEN_2022_PROGRAM_ID)).amount;
    if (afterRefund - beforeRefund !== 1_000_001n) throw new Error('Paused unstake did not return the full pre-dusted vault');
    const released = await readReceipt(connection, lifecycleStake.receipt);
    if (released.releasedAt <= 0) throw new Error('Lifecycle receipt did not finalize its release');
    const unpaused = await pauseCommand({ runtime, rpc: options['rpc-primary'], programId, config: lifecycleConfig.address, action: 'unpause' });
    if (unpaused.finalizedRevision !== '2') throw new Error('Lifecycle unpause did not finalize revision 2');
    mark('lifecycle-pause-rejections-full-refund-and-unpause');

    receipt = {
      schema: REHEARSAL_SCHEMA,
      executedAt: new Date().toISOString(),
      sourceCommit: release.manifest.sourceCommit,
      releaseManifestSha256: await sha256File(release.manifestFile),
      reviewAttestationSha256: await sha256File(path.resolve(options['review-file'])),
      artifact: { sha256: release.manifest.artifact.sha256, bytes: release.manifest.artifact.bytes },
      cluster: {
        name: 'devnet', genesisHash: rpcAgreement.genesisHash,
        independentRpcAgreement: true, finalizedAgreementSlot: rpcAgreement.slot,
      },
      harness: { postgresImage: POSTGRES_REHEARSAL_IMAGE, synapseImage: SYNAPSE_REHEARSAL_IMAGE },
      program: {
        programId: programId.toBase58(), programDataAddress: programData.toBase58(),
        deployedSha256: programHash, immutable: true,
      },
      mint: {
        address: mint.toBase58(), program: TOKEN_2022_PROGRAM, decimals: 6,
        mintedAtomicAmount: MINTED_ATOMIC.toString(), mintAuthority: 'revoked',
        freezeAuthority: 'revoked', metadataAuthority: 'absent',
      },
      configs: [
        { purpose: 'parity', address: parityConfig.address.toBase58(), configId: '0', revision: '0', requiredAtomicAmount: PRODUCTION_AMOUNT, minimumLockSeconds: PRODUCTION_LOCK_SECONDS },
        { purpose: 'lifecycle', address: lifecycleConfig.address.toBase58(), configId: '1', revision: '2', requiredAtomicAmount: LIFECYCLE_AMOUNT, minimumLockSeconds: LIFECYCLE_LOCK_SECONDS },
      ],
      checks: {
        releaseBuildsIdentical: true, deployedBytesMatch: true, programImmutable: true,
        mintAuthoritiesDisabled: true, parityStakeClaimConsume: true, matrixTokenSingleUse: true,
        chainReplayRejected: true, cleanupFailureHalted: true, cleanupReconciled: true,
        earlyUnstakeRejected: true, pauseRejectedStakeAndClaim: true,
        pausedRefundReturnedFullVault: true, unpaused: true, encryptedBackupRestored: true,
        staleRestoreCouldNotReissue: true, temporarySecretsRemoved: false,
      },
      review: { sourceCommit: review.sourceCommit, isolatedAgent: true, unresolvedP0ToP2: 0 },
    };
  } finally {
    let cleanupFailure;
    for (const [label, operation] of [
      ['issuer process', () => stopProcess(issuerProcess)],
      ['fault proxy process', () => stopProcess(proxyProcess)],
      ['rehearsal containers and volumes', () => compose(project, runtime, ['down', '--volumes', '--remove-orphans'], { failure: 'Rehearsal container cleanup failed' })],
      ['temporary secret directory', () => fs.rm(runtime, { recursive: true, force: true })],
    ]) {
      try {
        await operation();
      } catch {
        cleanupFailure ??= new Error(`Failed to remove ${label}; no rehearsal receipt will be emitted`);
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  }
  if (!receipt) throw new Error('Devnet rehearsal did not produce a receipt');
  receipt.checks.temporarySecretsRemoved = true;
  validateRehearsalReceipt(receipt);
  const date = receipt.executedAt.slice(0, 10);
  const receiptFile = path.resolve(options.receipt ?? path.join(ROOT, 'programs/access-stake/evidence/devnet', `${date}-${receipt.sourceCommit.slice(0, 12)}.json`));
  const logFile = path.resolve(options.log ?? path.join(ROOT, 'outputs/access-stake-devnet', `${date}-${receipt.sourceCommit.slice(0, 12)}.log.json`));
  const publicLogDocument = { schema: 'neal.access-stake-devnet-log/v1', sourceCommit: receipt.sourceCommit, steps: publicLog };
  assertPublicEvidence(publicLogDocument);
  await atomicWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  await atomicWrite(logFile, `${JSON.stringify(publicLogDocument, null, 2)}\n`);
  return { receiptFile, logFile, receipt };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const primaryUrl = checkedUrl(options['rpc-primary'], '--rpc-primary');
  const secondaryUrl = checkedUrl(options['rpc-secondary'], '--rpc-secondary');
  if (primaryUrl.hostname === secondaryUrl.hostname) throw new Error('Primary and secondary RPCs must use independent hostnames');
  const release = await readAndValidateReleaseManifest(options['release-manifest']);
  const review = validateReview(JSON.parse(await fs.readFile(path.resolve(options['review-file']), 'utf8')), release.manifest.sourceCommit);
  await assertPlannedPolicy();
  const head = await run('git', ['rev-parse', 'HEAD'], { capture: true });
  if (head !== release.manifest.sourceCommit) throw new Error('Executor checkout must be the exact reviewed release source commit');
  if (await run('git', ['status', '--porcelain'], { capture: true })) {
    throw new Error('Executor checkout has changes; use a clean release commit');
  }
  let rpcAgreement;
  try {
    rpcAgreement = await agreement(
      new Connection(primaryUrl.toString(), 'finalized'),
      new Connection(secondaryUrl.toString(), 'finalized'),
    );
  } catch {
    throw new Error('Independent RPC devnet/finality preflight failed');
  }
  if (!options.execute) {
    console.log(JSON.stringify({
      schema: 'neal.access-stake-devnet-plan/v1', mode: 'dry-run', sourceCommit: release.manifest.sourceCommit,
      artifactSha256: release.manifest.artifact.sha256, devnetGenesis: rpcAgreement.genesisHash,
      independentFinalizedAgreement: true, finalizedAgreementSlot: rpcAgreement.slot, writesAuthorized: false,
      configs: [
        { purpose: 'parity', configId: '0', requiredAtomicAmount: PRODUCTION_AMOUNT, minimumLockSeconds: PRODUCTION_LOCK_SECONDS },
        { purpose: 'lifecycle', configId: '1', requiredAtomicAmount: LIFECYCLE_AMOUNT, minimumLockSeconds: LIFECYCLE_LOCK_SECONDS },
      ],
    }, null, 2));
    return;
  }
  const result = await execute(options, release, review, rpcAgreement);
  console.log(JSON.stringify({
    schema: 'neal.access-stake-devnet-result/v1', receipt: result.receiptFile, log: result.logFile,
    programId: result.receipt.program.programId, artifactSha256: result.receipt.artifact.sha256,
  }, null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Access-stake devnet rehearsal failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
