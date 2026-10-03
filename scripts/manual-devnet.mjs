import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
  transferChecked,
} from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

import {
  MANUAL_AMOUNT,
  MANUAL_LEASE_SECONDS,
  MANUAL_LOCK_SECONDS,
  MANUAL_MINTED_AMOUNT,
  MANUAL_MODE,
  MANUAL_RUNTIME_SCHEMA,
  MANUAL_STATE_SCHEMA,
  validateManualPublicRuntime,
} from './manual-devnet-contracts.mjs';
import { establishDevnetAgreement, loadRpcSetCredential, rpcCall } from './devnet-rpc-set.mjs';
import { DEVNET_GENESIS, PRODUCTION_LOCK_SECONDS, readAndValidateReleaseManifest, sha256File } from './access-stake-contracts.mjs';
import {
  attestProgram,
  atomicWrite,
  buildToolchain,
  configCommand,
  dockerSolana,
  fundSigners,
  fundWithAirdrop,
  receiptAddress,
  renderSynapse,
  run,
  validateReview,
  waitHttp,
  writeKeypair,
  writePrivate,
} from './rehearse-access-stake-devnet.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '..');
const GATEWAY = path.join(ROOT, 'scripts/manual-devnet-gateway.mjs');
const COMPOSE = path.join(ROOT, 'infra/neal-access-rehearsal/compose.yaml');
const MANUAL_COMPOSE = path.join(ROOT, 'infra/neal-access-rehearsal/compose.manual.yaml');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), 'Library/Application Support/NEAL/devnet-manual');

const parseCli = (argv) => {
  const command = argv[0];
  if (!['prepare', 'start', 'status', 'fault', 'stop', 'guardian'].includes(command)) {
    throw new Error('Usage: manual-devnet <prepare|start|status|fault|stop> [options]');
  }
  const options = { command, execute: false, acknowledgeDevnet: false, acknowledgeCertificateTrusted: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') options.execute = true;
    else if (argument === '--acknowledge-devnet') options.acknowledgeDevnet = true;
    else if (argument === '--acknowledge-certificate-trusted') options.acknowledgeCertificateTrusted = true;
    else if (argument.startsWith('--')) options[argument.slice(2)] = argv[++index];
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return options;
};

const requireOptions = (options, names) => {
  for (const name of names) if (!options[name]) throw new Error(`Missing --${name}`);
};

const stateFile = (runtime) => path.join(runtime, 'state.json');
const publicRuntimeFile = (runtime) => path.join(runtime, 'public-runtime.json');
const faultsFile = (runtime) => path.join(runtime, 'faults.json');
const environmentFile = (runtime) => path.join(runtime, 'issuer.env');

const readState = async (runtime) => {
  const absolute = path.resolve(runtime);
  const metadata = await fs.lstat(absolute).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error('Manual runtime directory is unavailable or unsafe');
  const value = JSON.parse(await fs.readFile(stateFile(absolute), 'utf8'));
  if (value.schema !== MANUAL_STATE_SCHEMA || value.mode !== MANUAL_MODE) throw new Error('Manual runtime state is unsupported');
  if (value.runtime !== absolute || value.sourceCommit !== path.basename(absolute) || !/^[0-9a-f]{40}$/u.test(value.sourceCommit)) {
    throw new Error('Manual runtime path does not match its exact source commit');
  }
  return value;
};

const writeState = (runtime, value) => writePrivate(stateFile(runtime), `${JSON.stringify(value, null, 2)}\n`);

const safeEnvironmentValue = (value) => {
  if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) throw new Error('Issuer environment value is unsafe');
  return value;
};

const writeEnvironment = async (runtime, environment) => {
  const body = Object.entries(environment)
    .filter(([name]) => name.startsWith('NEAL_ACCESS_'))
    .map(([name, value]) => `${name}=${safeEnvironmentValue(String(value))}`)
    .join('\n');
  await writePrivate(environmentFile(runtime), `${body}\n`);
};

const assertGreenCi = async (sourceCommit) => {
  let repository;
  let checks;
  let status;
  try {
    repository = JSON.parse(await run('gh', ['repo', 'view', '--json', 'nameWithOwner'], { capture: true })).nameWithOwner;
    if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error('invalid repository');
    checks = JSON.parse(await run('gh', ['api', `repos/${repository}/commits/${sourceCommit}/check-runs?per_page=100`], { capture: true }));
    status = JSON.parse(await run('gh', ['api', `repos/${repository}/commits/${sourceCommit}/status`], { capture: true }));
  } catch {
    throw new Error('Could not verify GitHub CI for the exact source commit');
  }
  if (!Array.isArray(checks.check_runs) || checks.check_runs.length === 0) {
    throw new Error('The exact source commit has no GitHub check runs');
  }
  const latestChecks = new Map();
  for (const check of checks.check_runs) {
    const key = `${check.app?.slug ?? 'unknown'}:${check.name ?? 'unnamed'}`;
    const existing = latestChecks.get(key);
    if (!existing || Number(check.id) > Number(existing.id)) latestChecks.set(key, check);
  }
  const accepted = new Set(['success', 'neutral', 'skipped']);
  if ([...latestChecks.values()].some((check) => check.status !== 'completed' || !accepted.has(check.conclusion))) {
    throw new Error('The exact source commit does not have green completed GitHub checks');
  }
  if (Array.isArray(status.statuses) && status.statuses.length > 0 && status.state !== 'success') {
    throw new Error('The exact source commit does not have a green GitHub commit status');
  }
};

const manualCompose = (project, runtime, args, options = {}) => run('docker', [
  'compose', '--file', COMPOSE, '--file', MANUAL_COMPOSE, '--project-name', project, ...args,
], {
  ...options,
  env: {
    ...process.env,
    NEAL_REHEARSAL_RUNTIME: runtime,
    NEAL_REHEARSAL_UID: String(process.getuid?.() ?? 1000),
    NEAL_REHEARSAL_GID: String(process.getgid?.() ?? 1000),
  },
});

const serializeRpcSet = (rpcSet) => ({
  schema: rpcSet.schema,
  mode: rpcSet.mode,
  threshold: rpcSet.threshold,
  endpoints: rpcSet.endpoints.map(({ id, trustDomain, url }) => ({ id, trustDomain, url })),
});

const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const terminatePid = async (pid) => {
  if (!processAlive(pid) || pid === process.pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
};

const spawnDetached = (command, args, { cwd = ROOT, env = process.env, log }) => {
  const descriptor = fsSync.openSync(log, 'a', 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', descriptor, descriptor] });
  child.unref();
  fsSync.closeSync(descriptor);
  return child.pid;
};

const waitHttps = async (pathname, attempts = 60) => {
  const https = await import('node:https');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const okay = await new Promise((resolve) => {
      const request = https.get({ hostname: 'localhost', port: 4280, path: pathname, rejectUnauthorized: false }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on('error', () => resolve(false));
      request.setTimeout(1_000, () => request.destroy());
    });
    if (okay) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Local HTTPS acceptance gateway did not become ready');
};

const certificateFingerprint = async (certificate) => {
  const output = await run('/opt/homebrew/bin/openssl', ['x509', '-in', certificate, '-noout', '-fingerprint', '-sha1'], { capture: true });
  return output.split('=', 2)[1]?.replaceAll(':', '').trim().toUpperCase();
};

const createCertificate = async (runtime) => {
  const key = path.join(runtime, 'localhost.key.pem');
  const certificate = path.join(runtime, 'localhost.cert.pem');
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '2',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', key, '-out', certificate,
  ], { capture: true, failure: 'Could not generate the ephemeral localhost certificate' });
  await Promise.all([fs.chmod(key, 0o600), fs.chmod(certificate, 0o600)]);
  return { key, certificate, fingerprint: await certificateFingerprint(certificate) };
};

const createManualMint = async (connection, deployer, browserWallet) => {
  const mintKeypair = Keypair.generate();
  const mint = await createMint(
    connection, deployer, deployer.publicKey, deployer.publicKey, 6, mintKeypair,
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
  );
  const treasury = await getOrCreateAssociatedTokenAccount(
    connection, deployer, mint, deployer.publicKey, false, 'finalized',
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
  );
  const destination = await getOrCreateAssociatedTokenAccount(
    connection, deployer, mint, browserWallet, false, 'finalized',
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID,
  );
  const amount = BigInt(MANUAL_MINTED_AMOUNT);
  await mintTo(connection, deployer, mint, treasury.address, deployer, amount, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  await transferChecked(connection, deployer, treasury.address, mint, destination.address, deployer, amount, 6, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  await setAuthority(connection, deployer, mint, deployer, AuthorityType.MintTokens, null, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  await setAuthority(connection, deployer, mint, deployer, AuthorityType.FreezeAccount, null, [],
    { commitment: 'finalized', preflightCommitment: 'finalized' }, TOKEN_2022_PROGRAM_ID);
  const state = await getMint(connection, mint, 'finalized', TOKEN_2022_PROGRAM_ID);
  if (state.supply !== amount || state.mintAuthority !== null || state.freezeAuthority !== null) {
    throw new Error('Manual test mint failed its finalized authority/supply check');
  }
  return mint;
};

const prepare = async (options) => {
  requireOptions(options, ['release-manifest', 'rpc-set-file', 'review-file', 'wallet']);
  if (options.execute !== true || options.acknowledgeDevnet !== true) {
    throw new Error('Devnet preparation requires --execute --acknowledge-devnet');
  }
  await run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true, failure: 'Docker Desktop must be running' });
  const pythonVersion = await run('python3.12', ['--version'], { capture: true, failure: 'Python 3.12 is required' });
  if (!/^Python 3\.12\./u.test(pythonVersion)) throw new Error('Python 3.12 is required');
  const [head, dirty] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { capture: true }),
    run('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true }),
  ]);
  if (dirty) throw new Error('Manual devnet preparation requires a clean checkout');
  const browserWallet = new PublicKey(options.wallet);
  const release = await readAndValidateReleaseManifest(options['release-manifest']);
  if (release.manifest.sourceCommit !== head) throw new Error('Release manifest must cover the exact checkout commit');
  const reviewFile = path.resolve(options['review-file']);
  const review = validateReview(JSON.parse(await fs.readFile(reviewFile, 'utf8')), head);
  await assertGreenCi(head);
  const rpcSet = await loadRpcSetCredential(options['rpc-set-file']);
  const agreement = await establishDevnetAgreement(rpcSet);
  const runtimeRoot = path.resolve(options['runtime-root'] ?? DEFAULT_RUNTIME_ROOT);
  const runtime = path.join(runtimeRoot, head);
  await fs.mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeRoot, 0o700);
  try {
    await fs.mkdir(runtime, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Manual runtime already exists: ${runtime}`);
    throw error;
  }
  const project = `neal-manual-${head.slice(0, 12)}`;
  try {
    const deployer = Keypair.generate();
    const issuer = Keypair.generate();
    const program = Keypair.generate();
    const rpcSetFile = path.join(runtime, 'solana-rpc-set.json');
    await Promise.all([
      writeKeypair(path.join(runtime, 'deployer.json'), deployer),
      writeKeypair(path.join(runtime, 'issuer.json'), issuer),
      writeKeypair(path.join(runtime, 'program.json'), program),
      writePrivate(path.join(runtime, 'issuer-recovery-key'), randomBytes(32)),
      writePrivate(rpcSetFile, `${JSON.stringify(serializeRpcSet(rpcSet))}\n`),
      writePrivate(faultsFile(runtime), '{"dropMatrixFinalResponseOnce":false}\n'),
      writePrivate(environmentFile(runtime), ''),
    ]);
    const matrixSecret = randomBytes(48).toString('base64url');
    await renderSynapse(runtime, matrixSecret);
    const certificate = await createCertificate(runtime);
    await manualCompose(project, runtime, ['build', 'issuer'], { failure: 'Could not build the Ubuntu 24.04 manual issuer image' });
    await buildToolchain();
    const primaryRpc = rpcSet.endpoints[0].url;
    await writePrivate(path.join(runtime, 'solana-cli.yml'), [
      '---', `json_rpc_url: ${JSON.stringify(primaryRpc)}`, "websocket_url: ''",
      'keypair_path: /rehearsal/deployer.json', 'address_labels:', '  {}', 'commitment: finalized', '',
    ].join('\n'));
    const connection = new Connection(primaryRpc, 'finalized');
    await fundWithAirdrop(connection, deployer.publicKey, 4 * LAMPORTS_PER_SOL);
    await fundSigners(connection, deployer, [issuer]);
    await fundWithAirdrop(connection, browserWallet, Math.floor(0.25 * LAMPORTS_PER_SOL));
    await dockerSolana(runtime, release.artifactFile, [
      'solana', '--config', '/rehearsal/solana-cli.yml', 'program', 'deploy', `/release/${path.basename(release.artifactFile)}`,
      '--program-id', '/rehearsal/program.json', '--upgrade-authority', '/rehearsal/deployer.json',
      '--keypair', '/rehearsal/deployer.json', '--commitment', 'finalized',
    ], { failure: 'Manual devnet program deployment failed' });
    const programId = program.publicKey;
    const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER);
    await dockerSolana(runtime, release.artifactFile, [
      'solana', '--config', '/rehearsal/solana-cli.yml', 'program', 'set-upgrade-authority', programId.toBase58(), '--final',
      '--upgrade-authority', '/rehearsal/deployer.json', '--keypair', '/rehearsal/deployer.json', '--commitment', 'finalized',
    ], { failure: 'Could not revoke the manual devnet program upgrade authority' });
    await dockerSolana(runtime, release.artifactFile, [
      'solana', '--config', '/rehearsal/solana-cli.yml', 'program', 'dump', programId.toBase58(), '/rehearsal/deployed.so',
    ], { failure: 'Could not dump the immutable manual devnet program' });
    if (await sha256File(path.join(runtime, 'deployed.so')) !== release.manifest.artifact.sha256) {
      throw new Error('Manual devnet deployed bytes differ from the release artifact');
    }
    const programHash = await attestProgram(connection, programId, programData, release.manifest.artifact.sha256);
    const mint = await createManualMint(connection, deployer, browserWallet);
    const parityConfig = await configCommand({
      runtime, artifactFile: release.artifactFile, rpcSetFile, programId, programData, hash: programHash,
      mint, deployer, issuer, configId: 0, amount: MANUAL_AMOUNT, lock: PRODUCTION_LOCK_SECONDS,
    });
    const manualConfig = await configCommand({
      runtime, artifactFile: release.artifactFile, rpcSetFile, programId, programData, hash: programHash,
      mint, deployer, issuer, configId: 1, amount: MANUAL_AMOUNT, lock: MANUAL_LOCK_SECONDS,
    });
    const state = {
      schema: MANUAL_STATE_SCHEMA,
      mode: MANUAL_MODE,
      status: 'prepared',
      sourceCommit: head,
      preparedAt: new Date().toISOString(),
      runtime,
      project,
      rpcSetFile,
      browserWallet: browserWallet.toBase58(),
      programId: programId.toBase58(),
      programDataAddress: programData.toBase58(),
      programSha256: programHash,
      mint: mint.toBase58(),
      issuerAuthority: issuer.publicKey.toBase58(),
      parityConfigAddress: parityConfig.address.toBase58(),
      manualConfigAddress: manualConfig.address.toBase58(),
      configRevision: '0',
      roomId: null,
      expiresAt: null,
      pids: {},
      certificate,
      reviewSha256: await sha256File(reviewFile),
      finalizedAgreement: agreement,
      reviewSchema: review.schema,
    };
    await writeState(runtime, state);
    console.log(JSON.stringify({
      schema: 'neal.devnet-manual-prepare-result/v1', runtime, sourceCommit: head,
      browserWallet: state.browserWallet, programId: state.programId, mint: state.mint,
      manualConfigAddress: state.manualConfigAddress, certificate: state.certificate.certificate,
      certificateSha1: state.certificate.fingerprint,
    }, null, 2));
  } catch (error) {
    await manualCompose(project, runtime, ['down', '--volumes', '--remove-orphans']).catch(() => {});
    await fs.rm(runtime, { recursive: true, force: true });
    throw error;
  }
};

const matrixRequest = async (pathname, { method = 'GET', token, body } = {}) => {
  const response = await fetch(`http://127.0.0.1:18008${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Isolated Matrix setup failed with ${response.status}`);
  return payload;
};

const seedRoom = async (runtime, state) => {
  if (state.roomId) return state.roomId;
  const nonce = (await matrixRequest('/_synapse/admin/v1/register')).nonce;
  if (typeof nonce !== 'string') throw new Error('Isolated Matrix did not return a shared-secret nonce');
  const username = `seed_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(36).toString('base64url');
  const secret = (await fs.readFile(path.join(runtime, 'matrix-registration-secret'), 'utf8')).trim();
  const mac = createHmac('sha1', secret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
  const account = await matrixRequest('/_synapse/admin/v1/register', {
    method: 'POST', body: { nonce, username, password, admin: false, mac },
  });
  const room = await matrixRequest('/_matrix/client/v3/createRoom', {
    method: 'POST', token: account.access_token,
    body: { room_alias_name: 'neal-gc', name: 'NEAL isolated devnet acceptance', visibility: 'public', preset: 'public_chat' },
  });
  if (typeof room.room_id !== 'string') throw new Error('Isolated Matrix room creation returned no room ID');
  await matrixRequest('/_matrix/client/v3/logout', { method: 'POST', token: account.access_token, body: {} }).catch(() => {});
  return room.room_id;
};

const issuerEnvironment = (runtime, state) => ({
  NEAL_ACCESS_DATABASE: '/runtime/issuer.sqlite3',
  NEAL_ACCESS_SOLANA_RPC_SET_FILE: '/runtime/solana-rpc-set.json',
  NEAL_ACCESS_CHAIN_ID: 'solana:devnet',
  NEAL_ACCESS_SOLANA_GENESIS_HASH: DEVNET_GENESIS,
  NEAL_ACCESS_PROGRAM_ID: state.programId,
  NEAL_ACCESS_PROGRAM_DATA_ADDRESS: state.programDataAddress,
  NEAL_ACCESS_PROGRAM_SHA256: state.programSha256,
  NEAL_ACCESS_CONFIG_ADDRESS: state.manualConfigAddress,
  NEAL_ACCESS_MINT: state.mint,
  NEAL_ACCESS_EXPECTED_REVISION: state.configRevision,
  NEAL_ACCESS_EXPECTED_AMOUNT: MANUAL_AMOUNT,
  NEAL_ACCESS_EXPECTED_LOCK_SECONDS: String(MANUAL_LOCK_SECONDS),
  NEAL_ACCESS_ISSUER_KEYPAIR_FILE: '/runtime/issuer.json',
  NEAL_ACCESS_PUBLIC_ORIGIN: 'https://localhost:4280',
  NEAL_ACCESS_MATRIX_URL: 'http://127.0.0.1:8008',
  NEAL_ACCESS_MATRIX_SECRET_FILE: '/runtime/matrix-registration-secret',
  NEAL_ACCESS_RECOVERY_KEY_FILE: '/runtime/issuer-recovery-key',
  NEAL_ACCESS_RECOVERY_KEY_VERSION: '1',
  NEAL_ACCESS_MATRIX_SERVER_NAME: 'rehearsal.neal.invalid',
  NEAL_ACCESS_BIND: '127.0.0.1',
  NEAL_ACCESS_PORT: '18009',
});

const start = async (options) => {
  requireOptions(options, ['runtime']);
  if (!options.acknowledgeCertificateTrusted) throw new Error('Start requires --acknowledge-certificate-trusted');
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  if (Object.values(state.pids ?? {}).some(processAlive)) throw new Error('Manual acceptance processes are already running');
  await run('/usr/bin/security', [
    'verify-cert', '-c', state.certificate.certificate, '-p', 'ssl', '-n', 'localhost', '-L', '-q',
    '-k', path.join(os.homedir(), 'Library/Keychains/login.keychain-db'),
  ], { capture: true, failure: 'The emitted localhost certificate is not trusted; import it into the login keychain and mark it trusted first' });
  await run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true, failure: 'Docker Desktop must be running' });
  const environment = issuerEnvironment(runtime, state);
  await writeEnvironment(runtime, environment);
  await manualCompose(state.project, runtime, ['up', '--detach', '--wait']);
  await waitHttp('http://127.0.0.1:18008/_matrix/client/versions', [200]);
  await waitHttp('http://127.0.0.1:18009/readyz', [200]);
  state.roomId = await seedRoom(runtime, state);
  await writeState(runtime, state);
  const generatedAt = new Date();
  state.expiresAt = new Date(generatedAt.getTime() + MANUAL_LEASE_SECONDS * 1000).toISOString();
  const publicRuntime = validateManualPublicRuntime({
    schema: MANUAL_RUNTIME_SCHEMA,
    mode: MANUAL_MODE,
    sourceCommit: state.sourceCommit,
    generatedAt: generatedAt.toISOString(),
    expiresAt: state.expiresAt,
    chainId: 'solana:devnet',
    verification: { mode: 'quorum-2-of-3', providerCount: 3, threshold: 2 },
    browserWallet: state.browserWallet,
    programId: state.programId,
    programDataAddress: state.programDataAddress,
    programSha256: state.programSha256,
    configAddress: state.manualConfigAddress,
    configRevision: state.configRevision,
    issuerAuthority: state.issuerAuthority,
    mint: state.mint,
    terms: {
      requiredAtomicAmount: MANUAL_AMOUNT, minimumLockSeconds: MANUAL_LOCK_SECONDS,
      tokenDecimals: 6, mintedAtomicAmount: MANUAL_MINTED_AMOUNT,
    },
    matrix: {
      serverName: 'rehearsal.neal.invalid', baseUrl: 'https://localhost:4280',
      roomId: state.roomId, roomAlias: '#neal-gc:rehearsal.neal.invalid', viaServers: ['rehearsal.neal.invalid'],
    },
  });
  await atomicWrite(publicRuntimeFile(runtime), `${JSON.stringify(publicRuntime, null, 2)}\n`, 0o644);
  await run('npm', ['run', 'site:build'], { cwd: ROOT, failure: 'Could not build the local acceptance site' });
  const pids = {};
  try {
    pids.site = spawnDetached(path.join(ROOT, 'node_modules/.bin/vite'), [
      'preview', '--host', '127.0.0.1', '--port', '4281', '--strictPort',
    ], { cwd: path.join(ROOT, 'apps/site'), log: path.join(runtime, 'site.log') });
    await waitHttp('http://127.0.0.1:4281/', [200]);
    pids.gateway = spawnDetached(process.execPath, [
      GATEWAY,
      '--runtime', publicRuntimeFile(runtime), '--rpc-set-file', state.rpcSetFile,
      '--tls-key', state.certificate.key, '--tls-cert', state.certificate.certificate,
      '--faults', faultsFile(runtime), '--site-origin', 'http://127.0.0.1:4281',
      '--issuer-origin', 'http://127.0.0.1:18009', '--matrix-origin', 'http://127.0.0.1:18008',
    ], { log: path.join(runtime, 'gateway.log') });
    await waitHttps('/_neal/devnet/health');
    state.status = 'running';
    state.pids = pids;
    await writeState(runtime, state);
    pids.guardian = spawnDetached(process.execPath, [SCRIPT, 'guardian', '--runtime', runtime], { log: path.join(runtime, 'guardian.log') });
    state.pids = pids;
    await writeState(runtime, state);
  } catch (error) {
    await Promise.all(Object.values(pids).map(terminatePid));
    await manualCompose(state.project, runtime, ['stop']).catch(() => {});
    throw error;
  }
  console.log(JSON.stringify({
    schema: 'neal.devnet-manual-start-result/v1', status: 'running',
    url: 'https://localhost:4280/#gc', expiresAt: state.expiresAt,
    browserWallet: state.browserWallet, mint: state.mint, configAddress: state.manualConfigAddress,
  }, null, 2));
};

const stopLocalServices = async (runtime, state) => {
  await Promise.all(Object.values(state.pids ?? {}).map(terminatePid));
  await manualCompose(state.project, runtime, ['stop']).catch(() => {});
  state.pids = {};
};

const guardian = async (options) => {
  requireOptions(options, ['runtime']);
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  const wait = Math.max(0, Date.parse(state.expiresAt) - Date.now());
  await new Promise((resolve) => setTimeout(resolve, wait));
  const current = await readState(runtime);
  if (current.expiresAt !== state.expiresAt || current.status !== 'running') return;
  await stopLocalServices(runtime, current);
  current.status = 'expired';
  await writeState(runtime, current);
};

const status = async (options) => {
  requireOptions(options, ['runtime']);
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  const publicRuntime = await fs.readFile(publicRuntimeFile(runtime), 'utf8').then(JSON.parse).catch(() => null);
  console.log(JSON.stringify({
    schema: 'neal.devnet-manual-status/v1', status: state.status, sourceCommit: state.sourceCommit,
    expiresAt: state.expiresAt, services: Object.fromEntries(Object.entries(state.pids ?? {}).map(([name, pid]) => [name, processAlive(pid)])),
    browserWallet: state.browserWallet, programId: state.programId, mint: state.mint,
    configAddress: state.manualConfigAddress, roomId: state.roomId,
    runtimeValid: publicRuntime ? Boolean(validateManualPublicRuntime(publicRuntime, { allowExpired: true })) : false,
  }, null, 2));
};

const fault = async (options) => {
  requireOptions(options, ['runtime', 'name']);
  if (options.name !== 'matrix-final-response-once') throw new Error('Unsupported manual fault');
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  if (state.status !== 'running') throw new Error('Manual acceptance stack is not running');
  await writePrivate(faultsFile(runtime), '{"dropMatrixFinalResponseOnce":true}\n');
  console.log(JSON.stringify({ schema: 'neal.devnet-manual-fault/v1', armed: options.name }));
};

const reconciliationState = async (runtime, state) => {
  const output = await manualCompose(state.project, runtime, [
    'exec', '--no-TTY', 'issuer', '/opt/issuer/venv/bin/python', '/opt/issuer/reconcile.py',
    '--environment-file', '/runtime/issuer.env', '--list',
  ], { capture: true, failure: 'Could not inspect manual issuer reconciliation state' });
  const result = JSON.parse(output);
  const incomplete = result.claims.filter((claim) => !['REGISTRATION_COMPLETED', 'CANCELLED_BEFORE_CONSUMPTION'].includes(claim.phase));
  return { incomplete, administrators: result.administrators };
};

const quorumAccountInfo = async (rpcSet, address) => {
  await establishDevnetAgreement(rpcSet);
  const results = await Promise.all(rpcSet.endpoints.map(async (endpoint) => {
    try {
      const result = await rpcCall(endpoint, 'getAccountInfo', [address.toBase58(), {
        commitment: 'finalized', encoding: 'base64',
      }]);
      const account = result?.value ?? null;
      if (account && (
        typeof account.owner !== 'string'
        || typeof account.lamports !== 'number'
        || typeof account.executable !== 'boolean'
        || !Array.isArray(account.data)
        || typeof account.data[0] !== 'string'
        || account.data[1] !== 'base64'
      )) throw new Error('RPC account state is malformed');
      const identity = account
        ? `${account.owner}:${account.lamports}:${account.executable}:${account.data[0]}`
        : 'missing';
      return { account, identity };
    } catch {
      return null;
    }
  }));
  const groups = new Map();
  for (const result of results.filter(Boolean)) {
    const group = groups.get(result.identity) ?? [];
    group.push(result);
    groups.set(result.identity, group);
  }
  const agreement = [...groups.values()].find((group) => group.length >= rpcSet.threshold);
  if (!agreement) throw new Error('Refusing teardown: RPC providers do not agree on finalized receipt state');
  const account = agreement[0].account;
  return account ? { ...account, data: Buffer.from(account.data[0], 'base64') } : null;
};

const manualReceiptState = (account) => {
  if (!account || account.data.length !== 163 || !account.data.subarray(0, 8).equals(Buffer.from('NEALSTAK'))) {
    throw new Error('Refusing teardown: finalized receipt has an unsupported wire shape');
  }
  return {
    unlockAt: Number(account.data.readBigInt64LE(129)),
    releasedAt: Number(account.data.readBigInt64LE(153)),
  };
};

const stop = async (options) => {
  requireOptions(options, ['runtime']);
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  const rpcSet = await loadRpcSetCredential(state.rpcSetFile);
  const address = receiptAddress(new PublicKey(state.programId), new PublicKey(state.manualConfigAddress), new PublicKey(state.browserWallet));
  const account = await quorumAccountInfo(rpcSet, address);
  if (account) {
    const receipt = manualReceiptState(account);
    if (receipt.releasedAt <= 0) {
      throw new Error(`Refusing teardown: browser-wallet stake is not released (unlock timestamp ${receipt.unlockAt})`);
    }
  }
  if (fsSync.existsSync(environmentFile(runtime)) && fsSync.existsSync(path.join(runtime, 'issuer.sqlite3'))) {
    const reconciliation = await reconciliationState(runtime, state);
    if (reconciliation.incomplete.length || reconciliation.administrators.length) {
      throw new Error('Refusing teardown: issuer registration or administrator reconciliation remains incomplete');
    }
  }
  await stopLocalServices(runtime, state);
  await manualCompose(state.project, runtime, ['down', '--volumes', '--remove-orphans']);
  if (state.certificate?.fingerprint) {
    await run('/usr/bin/security', [
      'delete-certificate', '-Z', state.certificate.fingerprint,
      path.join(os.homedir(), 'Library/Keychains/login.keychain-db'),
    ], { capture: true }).catch(() => {});
  }
  await fs.rm(runtime, { recursive: true, force: true });
  console.log(JSON.stringify({ schema: 'neal.devnet-manual-stop-result/v1', status: 'removed', runtime }));
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'prepare') await prepare(options);
  else if (options.command === 'start') await start(options);
  else if (options.command === 'status') await status(options);
  else if (options.command === 'fault') await fault(options);
  else if (options.command === 'stop') await stop(options);
  else if (options.command === 'guardian') await guardian(options);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message.replaceAll(/https:\/\/[^\s]+/gu, '[redacted RPC URL]') : 'Unknown failure';
    console.error(`Manual devnet command failed: ${message}`);
    process.exitCode = 1;
  });
}
