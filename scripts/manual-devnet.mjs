import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import net from 'node:net';
import https from 'node:https';
import { createHash, createHmac, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
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
  MANUAL_READINESS_SCHEMA,
  MANUAL_RUNTIME_SCHEMA,
  MANUAL_STATE_SCHEMA,
  validateManualReadiness,
  validateManualPublicRuntime,
} from './manual-devnet-contracts.mjs';
import { establishDevnetAgreement, loadRpcSetCredential, rpcCall } from './devnet-rpc-set.mjs';
import { DEVNET_GENESIS, PRODUCTION_LOCK_SECONDS, assertPublicEvidence, readAndValidateReleaseManifest, sha256File } from './access-stake-contracts.mjs';
import {
  attestProgram,
  atomicWrite,
  buildToolchain,
  configCommand,
  dockerSolana,
  fundSigners,
  fundWithAirdrop,
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
const STATIC_SERVER = path.join(ROOT, 'scripts/manual-devnet-static.mjs');
const REVIEWER_PUBLIC_KEY = path.join(ROOT, 'infra/neal-access-rehearsal/independent-reviewer-public.pem');
const COMPOSE = path.join(ROOT, 'infra/neal-access-rehearsal/compose.yaml');
const MANUAL_COMPOSE = path.join(ROOT, 'infra/neal-access-rehearsal/compose.manual.yaml');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const DEFAULT_RUNTIME_ROOT = path.join(os.homedir(), 'Library/Application Support/NEAL/devnet-manual');
const ACCEPTANCE_URL = 'https://localhost:4280/#gc';
const ACCEPTANCE_PORTS = [4280, 4281];
const CHROME = '/Applications/Google Chrome.app';
const REVIEW_SIGNATURE_SCHEMA = 'neal.access-stake-isolated-review-signature/v1';
const REVIEWER_IDENTITY = 'neal-independent-reviewer:ed25519:sha256:676df1e3181d1541bf6351a7dae066fb19370b94161f0b5b9006e99db15edbed';
const REVIEWER_PUBLIC_KEY_SHA256 = '676df1e3181d1541bf6351a7dae066fb19370b94161f0b5b9006e99db15edbed';

const parseCli = (argv) => {
  const command = argv[0];
  if (!['doctor', 'prepare', 'start', 'verify', 'status', 'fault', 'stop', 'guardian'].includes(command)) {
    throw new Error('Usage: manual-devnet <doctor|prepare|start|verify|status|fault|stop> [options]');
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
const handoffFile = (runtime) => path.join(runtime, 'acceptance-handoff.json');

const assertExactCleanCheckout = async (expectedCommit = null) => {
  const [head, dirty] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { capture: true }),
    run('git', ['status', '--porcelain', '--untracked-files=all'], { capture: true }),
  ]);
  if (expectedCommit !== null && head !== expectedCommit) throw new Error('Checkout no longer matches the prepared source commit');
  if (dirty) throw new Error('Manual devnet commands require a clean checkout');
  return head;
};

export const directoryDigest = async (directory, { allowInternalSymlinks = false } = {}) => {
  const root = path.resolve(directory);
  const entries = [];
  const visit = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const metadata = await fs.lstat(absolute);
      if (metadata.isSymbolicLink()) {
        if (!allowInternalSymlinks) throw new Error('Prepared browser artifact may not contain symlinks');
        const link = await fs.readlink(absolute);
        const resolved = path.resolve(path.dirname(absolute), link);
        if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) {
          throw new Error('Installed dependency symlink leaves the exact checkout');
        }
        entries.push(`l ${relative} ${metadata.mode & 0o777} ${link}`);
      } else if (metadata.isDirectory()) {
        entries.push(`d ${relative} ${metadata.mode & 0o777}`);
        await visit(absolute);
      } else if (metadata.isFile()) {
        entries.push(`f ${relative} ${metadata.mode & 0o777} ${metadata.size} ${await sha256File(absolute)}`);
      } else {
        throw new Error('Prepared browser artifact contains an unsupported entry');
      }
    }
  };
  await visit(root);
  return createHash('sha256').update(`${entries.sort().join('\n')}\n`).digest('hex');
};

export const dependencyProof = async () => {
  const sourceLock = path.join(ROOT, 'package-lock.json');
  const installedLock = path.join(ROOT, 'node_modules/.package-lock.json');
  const dependencyDirectories = [
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, 'apps/site/node_modules'),
    path.join(ROOT, 'apps/launcher/node_modules'),
  ];
  return {
    sourceLockSha256: await sha256File(sourceLock),
    installedLockSha256: await sha256File(installedLock),
    dependencyDirectories: Object.fromEntries(await Promise.all(dependencyDirectories.map(async (directory) => [
      path.relative(ROOT, directory),
      await directoryDigest(directory, { allowInternalSymlinks: true }),
    ]))),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  };
};

export const reviewSignaturePayload = (value) => Buffer.from(JSON.stringify({
  schema: value.schema,
  sourceCommit: value.sourceCommit,
  reviewSha256: value.reviewSha256,
  releaseManifestSha256: value.releaseManifestSha256,
  artifactSha256: value.artifactSha256,
  issuerBundleSha256: value.issuerBundleSha256,
  reviewerIdentity: value.reviewerIdentity,
  reviewedAt: value.reviewedAt,
  unacceptedP3: value.unacceptedP3,
}));

export const validateSignedIsolatedReview = async ({
  reviewFile, signatureFile, issuerBundleFile, reviewerPublicKeyFile = REVIEWER_PUBLIC_KEY, sourceCommit, release,
  authorizedReviewerIdentity = REVIEWER_IDENTITY,
  authorizedPublicKeySha256 = REVIEWER_PUBLIC_KEY_SHA256,
}) => {
  const reviewPath = path.resolve(reviewFile);
  const signaturePath = path.resolve(signatureFile);
  const publicKeyPath = path.resolve(reviewerPublicKeyFile);
  const issuerBundlePath = path.resolve(issuerBundleFile);
  const issuerBundleMetadata = await fs.lstat(issuerBundlePath).catch(() => null);
  if (
    !issuerBundleMetadata?.isFile() || issuerBundleMetadata.isSymbolicLink()
    || issuerBundleMetadata.size <= 0 || issuerBundleMetadata.size > 512 * 1024 * 1024
  ) {
    throw new Error('Reviewed issuer bundle is unavailable or unsafe');
  }
  const review = validateReview(JSON.parse(await fs.readFile(reviewPath, 'utf8')), sourceCommit);
  const envelope = JSON.parse(await fs.readFile(signaturePath, 'utf8'));
  const keys = [
    'schema', 'sourceCommit', 'reviewSha256', 'releaseManifestSha256', 'artifactSha256',
    'issuerBundleSha256', 'reviewerIdentity', 'reviewedAt', 'unacceptedP3', 'signature',
  ];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || Object.keys(envelope).sort().join() !== keys.sort().join()) {
    throw new Error('Signed isolated review envelope has unsupported fields');
  }
  const expected = {
    sourceCommit,
    reviewSha256: await sha256File(reviewPath),
    releaseManifestSha256: await sha256File(path.resolve(release.manifestFile)),
    artifactSha256: release.manifest.artifact.sha256,
    issuerBundleSha256: await sha256File(issuerBundlePath),
  };
  if (
    envelope.schema !== REVIEW_SIGNATURE_SCHEMA
    || envelope.sourceCommit !== expected.sourceCommit
    || envelope.reviewSha256 !== expected.reviewSha256
    || envelope.releaseManifestSha256 !== expected.releaseManifestSha256
    || envelope.artifactSha256 !== expected.artifactSha256
    || envelope.issuerBundleSha256 !== expected.issuerBundleSha256
    || envelope.reviewedAt !== review.reviewedAt
    || envelope.reviewerIdentity !== authorizedReviewerIdentity
    || envelope.unacceptedP3 !== 0
    || typeof envelope.signature !== 'string'
  ) throw new Error('Signed isolated review does not bind the exact review and release artifacts');
  const publicKeyMetadata = await fs.lstat(publicKeyPath).catch(() => null);
  if (!publicKeyMetadata?.isFile() || publicKeyMetadata.isSymbolicLink() || publicKeyMetadata.size > 16 * 1024) {
    throw new Error('Reviewer public key is unavailable or unsafe');
  }
  let signature;
  try { signature = Buffer.from(envelope.signature, 'base64url'); } catch { throw new Error('Review signature is malformed'); }
  const key = createPublicKey(await fs.readFile(publicKeyPath));
  const keyFingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  if (keyFingerprint !== authorizedPublicKeySha256) {
    throw new Error('Reviewer public key is not the authorized independent-review key');
  }
  if (!verifySignature(null, reviewSignaturePayload(envelope), key, signature)) {
    throw new Error('Independent review signature verification failed');
  }
  assertPublicEvidence(envelope);
  return {
    review, envelope, reviewPath, signaturePath, issuerBundlePath, publicKeyPath, publicKeySha256: keyFingerprint,
  };
};

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

const copyPrivateFile = async (source, destination) => {
  await fs.copyFile(path.resolve(source), path.resolve(destination), fsSync.constants.COPYFILE_EXCL);
  await fs.chmod(destination, 0o600);
};

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
  if ([...latestChecks.values()].some((check) => check.status !== 'completed' || check.conclusion !== 'success')) {
    throw new Error('The exact source commit does not have green completed GitHub checks');
  }
  const requiredChecks = [
    'Web checks', 'Rust tests', 'Reproducible access-stake SBF build', 'Issuer checks',
  ];
  for (const name of requiredChecks) {
    const check = latestChecks.get(`github-actions:${name}`);
    if (!check || check.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error(`The exact source commit is missing required successful check: ${name}`);
    }
  }
  if (Array.isArray(status.statuses) && status.statuses.length > 0 && status.state !== 'success') {
    throw new Error('The exact source commit does not have a green GitHub commit status');
  }
};

const manualCompose = (project, runtime, args, options = {}) => {
  const { env: additionalEnvironment = {}, ...runOptions } = options;
  return run('docker', [
    'compose', '--file', COMPOSE, '--file', MANUAL_COMPOSE, '--project-name', project, ...args,
  ], {
    ...runOptions,
    env: {
      ...process.env,
      ...additionalEnvironment,
      NEAL_REHEARSAL_RUNTIME: runtime,
      NEAL_REHEARSAL_UID: String(process.getuid?.() ?? 1000),
      NEAL_REHEARSAL_GID: String(process.getgid?.() ?? 1000),
    },
  });
};

const serializeRpcSet = (rpcSet) => ({
  schema: rpcSet.schema,
  mode: rpcSet.mode,
  threshold: rpcSet.threshold,
  endpoints: rpcSet.endpoints.map(({ id, trustDomain, url }) => ({ id, trustDomain, url })),
});

export const processAlive = (record) => {
  const pid = record?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof record?.marker !== 'string') return false;
  try {
    process.kill(pid, 0);
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return command.includes(record.marker);
  } catch {
    return false;
  }
};

const discoverOwnedProcesses = async (state) => {
  if (typeof state.processNonce !== 'string' || !/^[0-9a-f]{32}$/u.test(state.processNonce)) return [];
  const marker = `neal-manual-owner-${state.processNonce}`;
  const output = await run('/bin/ps', ['ax', '-o', 'pid=', '-o', 'command='], { capture: true });
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match || !match[2].includes(marker) || !match[2].includes(state.runtime)) return [];
    return [{ pid: Number(match[1]), marker }];
  }).filter(processAlive);
};

const portAvailable = (port) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') resolve(false);
    else reject(error);
  });
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});

const portOccupant = async (port) => {
  try {
    return await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { capture: true });
  } catch {
    return 'listener details unavailable';
  }
};

export const assertAcceptancePortsAvailable = async (ports = ACCEPTANCE_PORTS) => {
  for (const port of ports) {
    if (await portAvailable(port)) continue;
    const occupant = await portOccupant(port);
    throw new Error(`Acceptance port ${port} is already in use. Stop that process before retrying. Listener: ${occupant.replaceAll(/\s+/gu, ' ').trim()}`);
  }
};

const terminatePid = async (record) => {
  const pid = record?.pid;
  if (!processAlive(record) || pid === process.pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processAlive(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
};

const spawnDetached = (command, args, { cwd = ROOT, env = process.env, log, marker }) => {
  if (typeof marker !== 'string' || !args.includes(marker)) throw new Error('Detached process requires an ownership marker argument');
  const descriptor = fsSync.openSync(log, 'a', 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', descriptor, descriptor] });
  child.unref();
  fsSync.closeSync(descriptor);
  return { pid: child.pid, marker };
};

const gatewayJson = async (state, pathname) => {
  const ca = await fs.readFile(state.certificate.certificate);
  return new Promise((resolve, reject) => {
    const request = https.get({ hostname: 'localhost', port: 4280, path: pathname, ca, servername: 'localhost' }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error('Gateway response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          reject(new Error('Gateway returned malformed JSON'));
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error('Gateway request timed out')));
  });
};

const verifyReady = async (state) => {
  const result = await gatewayJson(state, '/_neal/devnet/ready');
  const readiness = validateManualReadiness(result.body, {
    expectedCommit: state.sourceCommit,
    requireReady: true,
  });
  if (result.status !== 200 || readiness.schema !== MANUAL_READINESS_SCHEMA) {
    throw new Error('Local HTTPS acceptance gateway is not ready');
  }
  return readiness;
};

const waitReady = async (state, attempts = 60) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await verifyReady(state);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error('Local HTTPS acceptance gateway did not pass deep readiness');
};

const certificateFingerprint = async (certificate) => {
  const output = await run('openssl', ['x509', '-in', certificate, '-noout', '-fingerprint', '-sha1'], { capture: true });
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
  const alternativeNames = await run('openssl', [
    'x509', '-in', certificate, '-noout', '-ext', 'subjectAltName',
  ], { capture: true, failure: 'Could not inspect the ephemeral localhost certificate' });
  if (!alternativeNames.includes('DNS:localhost') || !alternativeNames.includes('IP Address:127.0.0.1')) {
    throw new Error('Ephemeral localhost certificate is missing required SANs');
  }
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

const verifyTrustedCertificate = async (state) => run('/usr/bin/security', [
  'verify-cert', '-c', state.certificate.certificate, '-p', 'ssl', '-n', 'localhost', '-L', '-q',
  '-k', path.join(os.homedir(), 'Library/Keychains/login.keychain-db'),
], { capture: true, failure: 'The emitted localhost certificate is not trusted; import it into the login keychain and mark it trusted first' });

const doctor = async (options) => {
  requireOptions(options, [
    'release-manifest', 'issuer-bundle', 'rpc-set-file', 'review-file', 'review-signature-file', 'wallet',
  ]);
  await assertAcceptancePortsAvailable();
  await fs.access(CHROME).catch(() => { throw new Error('Google Chrome is required at /Applications/Google Chrome.app'); });
  await run('openssl', ['version'], { capture: true, failure: 'OpenSSL with localhost SAN support is required' });
  await run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true, failure: 'Docker Desktop must be running' });
  const pythonVersion = await run('python3.12', ['--version'], { capture: true, failure: 'Python 3.12 is required' });
  if (!/^Python 3\.12\./u.test(pythonVersion)) throw new Error('Python 3.12 is required');
  await run('gh', ['auth', 'status', '--hostname', 'github.com'], { capture: true, failure: 'GitHub CLI authentication is required' });
  const head = await assertExactCleanCheckout();
  const release = await readAndValidateReleaseManifest(options['release-manifest']);
  if (release.manifest.sourceCommit !== head) throw new Error('Release manifest must cover the exact checkout commit');
  const signedReview = await validateSignedIsolatedReview({
    reviewFile: options['review-file'],
    signatureFile: options['review-signature-file'],
    issuerBundleFile: options['issuer-bundle'],
    sourceCommit: head,
    release,
  });
  const rpcSet = await loadRpcSetCredential(options['rpc-set-file']);
  const agreement = await establishDevnetAgreement(rpcSet);
  const browserWallet = new PublicKey(options.wallet).toBase58();
  await assertGreenCi(head);
  let certificate = 'pending-prepare';
  if (options.runtime) {
    const state = await readState(path.resolve(options.runtime));
    if (state.sourceCommit !== head || state.browserWallet !== browserWallet) {
      throw new Error('Prepared runtime does not match the exact checkout and browser wallet');
    }
    await verifyTrustedCertificate(state);
    certificate = 'trusted';
  }
  const result = {
    schema: 'neal.devnet-manual-doctor/v1',
    status: 'ok',
    sourceCommit: head,
    browserWallet,
    releaseManifestSha256: await sha256File(path.resolve(options['release-manifest'])),
    issuerBundleSha256: signedReview.envelope.issuerBundleSha256,
    reviewSchema: signedReview.review.schema,
    reviewSignatureSchema: signedReview.envelope.schema,
    finalizedAgreementSlot: agreement.slot,
    providerCount: rpcSet.endpoints.length,
    threshold: rpcSet.threshold,
    certificate,
    ports: { gateway: 4280, site: 4281, status: 'available' },
  };
  assertPublicEvidence(result);
  console.log(JSON.stringify(result, null, 2));
};

const prepare = async (options) => {
  requireOptions(options, [
    'release-manifest', 'issuer-bundle', 'rpc-set-file', 'review-file', 'review-signature-file', 'wallet',
  ]);
  if (options.execute !== true || options.acknowledgeDevnet !== true) {
    throw new Error('Devnet preparation requires --execute --acknowledge-devnet');
  }
  await assertAcceptancePortsAvailable();
  await fs.access(CHROME).catch(() => { throw new Error('Google Chrome is required at /Applications/Google Chrome.app'); });
  await run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true, failure: 'Docker Desktop must be running' });
  const pythonVersion = await run('python3.12', ['--version'], { capture: true, failure: 'Python 3.12 is required' });
  if (!/^Python 3\.12\./u.test(pythonVersion)) throw new Error('Python 3.12 is required');
  const head = await assertExactCleanCheckout();
  const browserWallet = new PublicKey(options.wallet);
  const release = await readAndValidateReleaseManifest(options['release-manifest']);
  if (release.manifest.sourceCommit !== head) throw new Error('Release manifest must cover the exact checkout commit');
  const signedReview = await validateSignedIsolatedReview({
    reviewFile: options['review-file'],
    signatureFile: options['review-signature-file'],
    issuerBundleFile: options['issuer-bundle'],
    sourceCommit: head,
    release,
  });
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
  let chainWritesStarted = false;
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
    const evidenceDirectory = path.join(runtime, 'release-evidence');
    await fs.mkdir(evidenceDirectory, { mode: 0o700 });
    if (path.basename(release.manifest.artifact.file) !== release.manifest.artifact.file) {
      throw new Error('Release artifact filename must not contain a path');
    }
    const evidenceManifest = path.join(evidenceDirectory, 'release-manifest.json');
    const evidenceArtifact = path.join(evidenceDirectory, path.basename(release.manifest.artifact.file));
    const evidenceReview = path.join(evidenceDirectory, 'isolated-review.json');
    const evidenceSignature = path.join(evidenceDirectory, 'isolated-review-signature.json');
    const evidenceIssuerBundle = path.join(evidenceDirectory, 'issuer-bundle.tar');
    await Promise.all([
      copyPrivateFile(release.manifestFile, evidenceManifest),
      copyPrivateFile(release.artifactFile, evidenceArtifact),
      copyPrivateFile(signedReview.reviewPath, evidenceReview),
      copyPrivateFile(signedReview.signaturePath, evidenceSignature),
      copyPrivateFile(signedReview.issuerBundlePath, evidenceIssuerBundle),
    ]);
    await run('npm', ['run', 'site:build'], {
      cwd: ROOT,
      env: { ...process.env, VITE_NEAL_SOURCE_COMMIT: head },
      failure: 'Could not build the exact manual acceptance browser artifact',
    });
    await atomicWrite(path.join(ROOT, 'apps/site/dist/_neal-build.json'), `${JSON.stringify({
      schema: 'neal.devnet-browser-build/v1', sourceCommit: head,
    })}\n`, 0o644);
    const browserArtifactDirectory = path.join(runtime, 'site-dist');
    await fs.cp(path.join(ROOT, 'apps/site/dist'), browserArtifactDirectory, { recursive: true, force: false });
    const browserArtifactSha256 = await directoryDigest(browserArtifactDirectory);
    const javascriptDependencies = await dependencyProof();
    const matrixSecret = randomBytes(48).toString('base64url');
    await renderSynapse(runtime, matrixSecret);
    const certificate = await createCertificate(runtime);
    await manualCompose(project, runtime, ['build', 'issuer'], {
      env: { NEAL_ISSUER_SOURCE_COMMIT: head },
      failure: 'Could not build the Ubuntu 24.04 manual issuer image',
    });
    const issuerImageId = (await manualCompose(project, runtime, ['images', '--quiet', 'issuer'], {
      capture: true, failure: 'Could not identify the exact manual issuer image',
    })).trim();
    if (!/^sha256:[0-9a-f]{64}$/u.test(issuerImageId)) throw new Error('Manual issuer image ID is invalid');
    await buildToolchain();
    const primaryRpc = rpcSet.endpoints[0].url;
    await writePrivate(path.join(runtime, 'solana-cli.yml'), [
      '---', `json_rpc_url: ${JSON.stringify(primaryRpc)}`, "websocket_url: ''",
      'keypair_path: /rehearsal/deployer.json', 'address_labels:', '  {}', 'commitment: finalized', '',
    ].join('\n'));
    const connection = new Connection(primaryRpc, 'finalized');
    chainWritesStarted = true;
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
      processNonce: randomBytes(16).toString('hex'),
      rpcSetFile,
      requestNonce: randomBytes(32).toString('hex'),
      browserArtifact: { directory: browserArtifactDirectory, sha256: browserArtifactSha256 },
      javascriptDependencies,
      releaseEvidence: {
        manifest: evidenceManifest,
        artifact: evidenceArtifact,
        review: evidenceReview,
        signature: evidenceSignature,
        issuerBundle: evidenceIssuerBundle,
      },
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
      issuerImageId,
      reviewSha256: await sha256File(signedReview.reviewPath),
      reviewSignatureSha256: await sha256File(signedReview.signaturePath),
      reviewerPublicKeySha256: signedReview.publicKeySha256,
      finalizedAgreement: agreement,
      reviewSchema: signedReview.review.schema,
      reviewSignatureSchema: signedReview.envelope.schema,
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
    if (chainWritesStarted) {
      await writePrivate(path.join(runtime, 'prepare-recovery-required.json'), `${JSON.stringify({
        schema: 'neal.devnet-manual-prepare-recovery/v1',
        sourceCommit: head,
        failedAt: new Date().toISOString(),
        status: 'operator_recovery_required',
      }, null, 2)}\n`).catch(() => {});
      throw new Error(`Manual preparation failed after devnet writes; private recovery state was preserved at ${runtime}`, { cause: error });
    }
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
  NEAL_ACCESS_EXPECTED_WALLET: state.browserWallet,
  NEAL_ACCESS_ISSUER_IMAGE_ID: state.issuerImageId,
  NEAL_ACCESS_ISSUER_KEYPAIR_FILE: '/runtime/issuer.json',
  NEAL_ACCESS_PUBLIC_ORIGIN: 'https://localhost:4280',
  NEAL_ACCESS_MATRIX_URL: 'http://synapse:8008',
  NEAL_ACCESS_MATRIX_SECRET_FILE: '/runtime/matrix-registration-secret',
  NEAL_ACCESS_RECOVERY_KEY_FILE: '/runtime/issuer-recovery-key',
  NEAL_ACCESS_RECOVERY_KEY_VERSION: '1',
  NEAL_ACCESS_MATRIX_SERVER_NAME: 'rehearsal.neal.invalid',
  NEAL_ACCESS_BIND: '0.0.0.0',
  NEAL_ACCESS_PORT: '18009',
});

const verifySynapseOutboundDenied = async (runtime, state) => manualCompose(state.project, runtime, [
  'exec', '--no-TTY', 'synapse', 'python', '-c',
  [
    'import socket',
    'try:',
    "    connection = socket.create_connection(('1.1.1.1', 443), 2)",
    'except OSError:',
    '    raise SystemExit(0)',
    'connection.close()',
    'raise SystemExit(1)',
  ].join('\n'),
], { capture: true, failure: 'Isolated Synapse unexpectedly has external network egress' });

const start = async (options) => {
  requireOptions(options, ['runtime']);
  if (!options.acknowledgeCertificateTrusted) throw new Error('Start requires --acknowledge-certificate-trusted');
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  const discovered = await discoverOwnedProcesses(state);
  if (Object.values(state.pids ?? {}).some(processAlive) || discovered.length) {
    throw new Error('Manual acceptance processes are already running');
  }
  if (state.status === 'starting') {
    await manualCompose(state.project, runtime, ['stop']).catch(() => {});
    state.status = 'unavailable';
    state.pids = {};
    await writeState(runtime, state);
  }
  await assertAcceptancePortsAvailable();
  await assertExactCleanCheckout(state.sourceCommit);
  const preparedRelease = await readAndValidateReleaseManifest(state.releaseEvidence?.manifest);
  if (
    preparedRelease.manifest.sourceCommit !== state.sourceCommit
    || preparedRelease.artifactFile !== state.releaseEvidence.artifact
    || preparedRelease.manifest.artifact.sha256 !== state.programSha256
  ) throw new Error('Prepared release evidence does not match the deployed program');
  const preparedReview = await validateSignedIsolatedReview({
    reviewFile: state.releaseEvidence.review,
    signatureFile: state.releaseEvidence.signature,
    issuerBundleFile: state.releaseEvidence.issuerBundle,
    sourceCommit: state.sourceCommit,
    release: preparedRelease,
  });
  if (
    await sha256File(preparedReview.reviewPath) !== state.reviewSha256
    || await sha256File(preparedReview.signaturePath) !== state.reviewSignatureSha256
    || preparedReview.publicKeySha256 !== state.reviewerPublicKeySha256
  ) throw new Error('Prepared independent-review evidence has changed');
  if (JSON.stringify(await dependencyProof()) !== JSON.stringify(state.javascriptDependencies)) {
    throw new Error('Installed JavaScript dependencies differ from the prepared dependency graph');
  }
  if (
    state.browserArtifact?.directory !== path.join(runtime, 'site-dist')
    || !/^[0-9a-f]{64}$/u.test(state.browserArtifact?.sha256 ?? '')
    || await directoryDigest(state.browserArtifact.directory) !== state.browserArtifact.sha256
  ) throw new Error('Prepared browser artifact digest is invalid');
  const browserMarker = JSON.parse(await fs.readFile(path.join(state.browserArtifact.directory, '_neal-build.json'), 'utf8'));
  if (browserMarker.schema !== 'neal.devnet-browser-build/v1' || browserMarker.sourceCommit !== state.sourceCommit) {
    throw new Error('Prepared browser artifact commit marker is invalid');
  }
  if (await certificateFingerprint(state.certificate.certificate) !== state.certificate.fingerprint) {
    throw new Error('Localhost certificate fingerprint differs from the prepared certificate');
  }
  await verifyTrustedCertificate(state);
  await run('docker', ['version', '--format', '{{.Server.Version}}'], { capture: true, failure: 'Docker Desktop must be running' });
  const environment = issuerEnvironment(runtime, state);
  await writeEnvironment(runtime, environment);
  const pids = {};
  const processMarker = `neal-manual-owner-${state.processNonce}`;
  state.status = 'starting';
  state.pids = pids;
  await writeState(runtime, state);
  try {
    await manualCompose(state.project, runtime, ['up', '--detach', '--wait']);
    const issuerContainer = (await manualCompose(state.project, runtime, ['ps', '--quiet', 'issuer'], {
      capture: true, failure: 'Could not identify the running issuer container',
    })).trim();
    const runningImageId = (await run('docker', ['inspect', '--format', '{{.Image}}', issuerContainer], {
      capture: true, failure: 'Could not attest the running issuer image',
    })).trim();
    if (runningImageId !== state.issuerImageId) throw new Error('Running issuer image differs from the prepared image');
    await waitHttp('http://127.0.0.1:18008/_matrix/client/versions', [200]);
    await verifySynapseOutboundDenied(runtime, state);
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
      requestNonce: state.requestNonce,
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
    pids.site = spawnDetached(process.execPath, [
      STATIC_SERVER, '--root', state.browserArtifact.directory, '--port', '4281',
      '--owner-nonce', processMarker,
    ], { cwd: ROOT, log: path.join(runtime, 'site.log'), marker: processMarker });
    state.pids = pids;
    await writeState(runtime, state);
    await waitHttp('http://127.0.0.1:4281/', [200]);
    pids.gateway = spawnDetached(process.execPath, [
      GATEWAY,
      '--runtime', publicRuntimeFile(runtime), '--rpc-set-file', state.rpcSetFile,
      '--tls-key', state.certificate.key, '--tls-cert', state.certificate.certificate,
      '--faults', faultsFile(runtime), '--site-origin', 'http://127.0.0.1:4281',
      '--issuer-origin', 'http://127.0.0.1:18009', '--matrix-origin', 'http://127.0.0.1:18008',
      '--issuer-image-id', state.issuerImageId,
      '--owner-nonce', processMarker,
    ], { log: path.join(runtime, 'gateway.log'), marker: processMarker });
    state.pids = pids;
    await writeState(runtime, state);
    const readiness = await waitReady(state);
    state.status = 'running';
    state.pids = pids;
    await writeState(runtime, state);
    pids.guardian = spawnDetached(process.execPath, [
      SCRIPT, 'guardian', '--runtime', runtime, '--owner-nonce', processMarker,
    ], { log: path.join(runtime, 'guardian.log'), marker: processMarker });
    state.pids = pids;
    await writeState(runtime, state);
    const handoff = {
      schema: 'neal.devnet-manual-handoff/v1',
      createdAt: new Date().toISOString(),
      sourceCommit: state.sourceCommit,
      browserArtifactSha256: state.browserArtifact.sha256,
      issuerImageId: state.issuerImageId,
      url: ACCEPTANCE_URL,
      expiresAt: state.expiresAt,
      browserWallet: state.browserWallet,
      programId: state.programId,
      configAddress: state.manualConfigAddress,
      mint: state.mint,
      requiredAtomicAmount: MANUAL_AMOUNT,
      minimumLockSeconds: MANUAL_LOCK_SECONDS,
      finalizedAgreementSlot: readiness.verification.finalizedAgreementSlot,
      readinessChecks: readiness.checks,
    };
    assertPublicEvidence(handoff);
    await atomicWrite(handoffFile(runtime), `${JSON.stringify(handoff, null, 2)}\n`, 0o644);
    await run('/usr/bin/open', ['-a', 'Google Chrome', ACCEPTANCE_URL], {
      capture: true,
      failure: 'The acceptance stack is ready, but Google Chrome could not be opened',
    });
  } catch (error) {
    const owned = await discoverOwnedProcesses(state).catch(() => []);
    await Promise.all([...Object.values(pids), ...owned].map(terminatePid));
    await manualCompose(state.project, runtime, ['stop']).catch(() => {});
    state.status = 'unavailable';
    state.pids = {};
    await writeState(runtime, state).catch(() => {});
    throw error;
  }
  console.log(JSON.stringify({
    schema: 'neal.devnet-manual-start-result/v1', status: 'ready', acceptanceReady: true,
    url: ACCEPTANCE_URL, expiresAt: state.expiresAt,
    browserArtifactSha256: state.browserArtifact.sha256, issuerImageId: state.issuerImageId,
    browserWallet: state.browserWallet, mint: state.mint, configAddress: state.manualConfigAddress,
  }, null, 2));
};

const stopLocalServices = async (runtime, state) => {
  const owned = await discoverOwnedProcesses(state).catch(() => []);
  await Promise.all([...Object.values(state.pids ?? {}), ...owned].map(terminatePid));
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

const verify = async (options) => {
  requireOptions(options, ['runtime']);
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  if (state.status !== 'running' || !processAlive(state.pids?.gateway)) {
    throw new Error('Manual acceptance stack is not running');
  }
  const readiness = await verifyReady(state);
  const result = {
    ...readiness,
    url: ACCEPTANCE_URL,
    browserWallet: state.browserWallet,
    programId: state.programId,
    configAddress: state.manualConfigAddress,
    mint: state.mint,
    requiredAtomicAmount: MANUAL_AMOUNT,
    minimumLockSeconds: MANUAL_LOCK_SECONDS,
  };
  assertPublicEvidence(result);
  console.log(JSON.stringify(result, null, 2));
};

const status = async (options) => {
  requireOptions(options, ['runtime']);
  const runtime = path.resolve(options.runtime);
  const state = await readState(runtime);
  const publicRuntime = await fs.readFile(publicRuntimeFile(runtime), 'utf8').then(JSON.parse).catch(() => null);
  let runtimeValid = false;
  try {
    runtimeValid = Boolean(publicRuntime && validateManualPublicRuntime(publicRuntime, { allowExpired: true }));
  } catch { /* Reported below as false. */ }
  const services = Object.fromEntries(Object.entries(state.pids ?? {}).map(([name, record]) => [name, processAlive(record)]));
  let readiness = null;
  if (services.gateway) {
    try {
      const result = await gatewayJson(state, '/_neal/devnet/ready');
      readiness = validateManualReadiness(result.body, { expectedCommit: state.sourceCommit });
    } catch { /* A running PID is not sufficient for readiness. */ }
  }
  const acceptanceReady = readiness?.ready === true && Object.values(services).every(Boolean);
  const result = {
    schema: 'neal.devnet-manual-status/v1',
    status: acceptanceReady ? 'ready' : state.status === 'running' ? 'unavailable' : state.status,
    acceptanceReady,
    sourceCommit: state.sourceCommit,
    browserArtifactSha256: state.browserArtifact?.sha256 ?? null,
    issuerImageId: state.issuerImageId ?? null,
    url: ACCEPTANCE_URL,
    expiresAt: state.expiresAt,
    services,
    browserWallet: state.browserWallet, programId: state.programId, mint: state.mint,
    configAddress: state.manualConfigAddress, roomId: state.roomId,
    requiredAtomicAmount: MANUAL_AMOUNT,
    minimumLockSeconds: MANUAL_LOCK_SECONDS,
    runtimeValid,
    readinessChecks: readiness?.checks ?? null,
    finalizedAgreementSlot: readiness?.verification.finalizedAgreementSlot ?? null,
  };
  assertPublicEvidence(result);
  console.log(JSON.stringify(result, null, 2));
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

const quorumConfigReceipts = async (rpcSet, programId, configAddress) => {
  await establishDevnetAgreement(rpcSet);
  const results = await Promise.all(rpcSet.endpoints.map(async (endpoint) => {
    try {
      const value = await rpcCall(endpoint, 'getProgramAccounts', [programId.toBase58(), {
        commitment: 'finalized',
        encoding: 'base64',
        filters: [{ dataSize: 163 }, { memcmp: { offset: 9, bytes: configAddress.toBase58() } }],
      }]);
      if (!Array.isArray(value)) throw new Error('RPC program-account response is malformed');
      const accounts = value.map((entry) => {
        if (
          typeof entry?.pubkey !== 'string'
          || typeof entry?.account?.owner !== 'string'
          || entry.account.owner !== programId.toBase58()
          || !Array.isArray(entry?.account?.data)
          || typeof entry.account.data[0] !== 'string'
          || entry.account.data[1] !== 'base64'
        ) throw new Error('RPC receipt account is malformed');
        return { pubkey: entry.pubkey, data: Buffer.from(entry.account.data[0], 'base64') };
      }).sort((left, right) => left.pubkey.localeCompare(right.pubkey));
      return {
        accounts,
        identity: accounts.map((entry) => `${entry.pubkey}:${entry.data.toString('base64')}`).join('|'),
      };
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
  if (!agreement) throw new Error('Refusing teardown: RPC providers do not agree on manual-config receipts');
  return agreement[0].accounts;
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
  const programId = new PublicKey(state.programId);
  const configAddress = new PublicKey(state.manualConfigAddress);
  const receipts = await quorumConfigReceipts(rpcSet, programId, configAddress);
  for (const account of receipts) {
    const receipt = manualReceiptState({ data: account.data });
    if (receipt.releasedAt <= 0) {
      throw new Error(`Refusing teardown: receipt ${account.pubkey} is not released (unlock timestamp ${receipt.unlockAt})`);
    }
  }
  if (fsSync.existsSync(environmentFile(runtime)) && fsSync.existsSync(path.join(runtime, 'issuer.sqlite3'))) {
    await manualCompose(state.project, runtime, ['up', '--detach']);
    await waitHttp('http://127.0.0.1:18008/_matrix/client/versions', [200]);
    const reconciliation = await reconciliationState(runtime, state);
    if (reconciliation.incomplete.length || reconciliation.administrators.length) {
      throw new Error('Refusing teardown: issuer registration or administrator reconciliation remains incomplete');
    }
  }
  await stopLocalServices(runtime, state);
  await manualCompose(state.project, runtime, ['down', '--volumes', '--remove-orphans']);
  if (state.certificate?.fingerprint) {
    const keychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
    let certificateInventory = await run('/usr/bin/security', [
      'find-certificate', '-a', '-Z', keychain,
    ], { capture: true, failure: 'Could not confirm localhost certificate removal; runtime recovery metadata was preserved' });
    if (certificateInventory.toUpperCase().includes(state.certificate.fingerprint)) {
      await run('/usr/bin/security', [
        'delete-certificate', '-Z', state.certificate.fingerprint, keychain,
      ], { capture: true, failure: 'Could not remove the trusted localhost certificate; runtime recovery metadata was preserved' });
      certificateInventory = await run('/usr/bin/security', [
        'find-certificate', '-a', '-Z', keychain,
      ], { capture: true, failure: 'Could not confirm localhost certificate removal; runtime recovery metadata was preserved' });
    }
    if (certificateInventory.toUpperCase().includes(state.certificate.fingerprint)) {
      throw new Error('Trusted localhost certificate remains installed; runtime recovery metadata was preserved');
    }
  }
  await fs.rm(runtime, { recursive: true, force: true });
  console.log(JSON.stringify({ schema: 'neal.devnet-manual-stop-result/v1', status: 'removed', runtime }));
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.command === 'doctor') await doctor(options);
  else if (options.command === 'prepare') await prepare(options);
  else if (options.command === 'start') await start(options);
  else if (options.command === 'verify') await verify(options);
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
