import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';

const CONFIG_SIZE = 171;
const CONFIG_DISCRIMINATOR = Buffer.from('NEALACFG');
const CONFIG_SEED = Buffer.from('access-config');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

const endpoint = (value, label) => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is missing`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return parsed;
};

const issuerEndpoint = (value, label, expectedPath) => {
  const parsed = endpoint(value, label);
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== expectedPath
    || parsed.search
    || parsed.hash
  ) throw new Error(`${label} must be the exact ${expectedPath} HTTPS endpoint`);
  return parsed;
};

const checkPreflight = async (url, publicOrigin) => {
  const response = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: publicOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  if (response.status !== 204) throw new Error(`${url} preflight returned HTTP ${response.status}`);
  if (response.headers.get('access-control-allow-origin') !== publicOrigin) {
    throw new Error(`${url} returned the wrong CORS origin`);
  }
  if (response.headers.get('access-control-allow-credentials') !== 'true') {
    throw new Error(`${url} does not allow the issuer session cookie`);
  }
};

const parseConfig = (data) => {
  if (data.length !== CONFIG_SIZE || !data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR) || data[8] !== 2) {
    throw new Error('The finalized config account has an unsupported wire shape');
  }
  return {
    authority: new PublicKey(data.subarray(9, 41)),
    issuerAuthority: new PublicKey(data.subarray(41, 73)),
    configId: data.readBigUInt64LE(73),
    mint: new PublicKey(data.subarray(81, 113)),
    tokenProgram: new PublicKey(data.subarray(113, 145)),
    revision: data.readBigUInt64LE(145),
    requiredAmount: data.readBigUInt64LE(153),
    minimumLockSeconds: data.readBigInt64LE(161),
    paused: data[169] !== 0,
    bump: data[170],
  };
};

export async function verifyAccessStake(policy, launchRecord, { checkEndpoints = true } = {}) {
  if (policy.schema !== 'neal.wallet-policy/v1') throw new Error('Unsupported wallet policy schema');
  if (
    policy.chain !== 'solana:mainnet'
    || policy.verification?.mode !== 'quorum-2-of-3'
    || policy.verification?.providerCount !== 3
    || policy.verification?.threshold !== 2
  ) throw new Error('Production readiness requires strict mainnet 2-of-3 verification');
  if (launchRecord.schema !== 'neal.public-record/v1') throw new Error('Unsupported public record schema');
  const stake = policy.accessStake;
  if (!stake || stake.status === 'planned') throw new Error('Access staking is still planned');
  if (!['active', 'paused'].includes(stake.status)) throw new Error('Unsupported access-stake status');
  if (stake.contractVersion !== 2) throw new Error('Unsupported access-stake contract version');

  const programId = new PublicKey(stake.programId);
  const configAddress = new PublicKey(stake.configAddress);
  const mint = new PublicKey(stake.mint);
  const canonicalMint = new PublicKey(launchRecord.execution?.mintAddress);
  if (!mint.equals(canonicalMint)) throw new Error('Stake mint does not match the canonical launch mint');
  if (stake.tokenProgram !== TOKEN_2022_PROGRAM.toBase58()) throw new Error('Stake policy does not pin Token-2022');
  if (!Number.isSafeInteger(stake.tokenDecimals) || stake.tokenDecimals < 0) throw new Error('Invalid token decimals');
  const requiredAmount = BigInt(stake.requiredAtomicAmount);
  const minimumLockSeconds = BigInt(stake.minimumLockSeconds);
  if (requiredAmount <= 0n || minimumLockSeconds <= 0n || minimumLockSeconds > 365n * 24n * 60n * 60n) {
    throw new Error('Stake terms are outside the on-chain bounds');
  }

  const rpc = endpoint(policy.holderProof?.rpcEndpoint, 'holderProof.rpcEndpoint');
  const connection = new Connection(rpc.toString(), 'finalized');
  const programDataAddress = new PublicKey(stake.programDataAddress);
  if (!/^[0-9a-f]{64}$/u.test(stake.programSha256)) throw new Error('Invalid reviewed program SHA-256');
  const [genesis, programAccount, programDataAccount, configAccount, mintAccount] = await Promise.all([
    connection.getGenesisHash(),
    connection.getAccountInfo(programId, 'finalized'),
    connection.getAccountInfo(programDataAddress, 'finalized'),
    connection.getAccountInfo(configAddress, 'finalized'),
    connection.getParsedAccountInfo(mint, 'finalized'),
  ]);
  if (genesis !== MAINNET_GENESIS) throw new Error('Holder-proof RPC is not Solana mainnet');
  if (
    !programAccount?.executable
    || !programAccount.owner.equals(UPGRADEABLE_LOADER)
    || programAccount.data.length < 36
    || programAccount.data.readUInt32LE(0) !== 2
    || !new PublicKey(programAccount.data.subarray(4, 36)).equals(programDataAddress)
  ) throw new Error('Program account does not match the reviewed ProgramData account');
  if (
    !programDataAccount
    || !programDataAccount.owner.equals(UPGRADEABLE_LOADER)
    || programDataAccount.data.length <= 45
    || programDataAccount.data.readUInt32LE(0) !== 3
    || programDataAccount.data[12] !== 0
  ) throw new Error('ProgramData is missing, invalid, or still upgradeable');
  const deployedHash = createHash('sha256').update(programDataAccount.data.subarray(45)).digest('hex');
  if (deployedHash !== stake.programSha256) throw new Error('Deployed program bytes do not match the reviewed SBF artifact');
  if (!configAccount || !configAccount.owner.equals(programId)) throw new Error('Config account is missing or owned by another program');
  const config = parseConfig(configAccount.data);
  const configId = Buffer.alloc(8);
  configId.writeBigUInt64LE(config.configId);
  const expectedConfig = PublicKey.createProgramAddressSync(
    [CONFIG_SEED, config.authority.toBuffer(), configId, Buffer.from([config.bump])],
    programId,
  );
  if (!expectedConfig.equals(configAddress)) throw new Error('Config address is not the expected PDA');
  if (!config.mint.equals(mint) || !config.tokenProgram.equals(TOKEN_2022_PROGRAM)) {
    throw new Error('Finalized config pins different token accounts');
  }
  if (stake.issuerAuthority !== config.issuerAuthority.toBase58()) {
    throw new Error('Published issuer authority does not match the finalized config');
  }
  if (stake.configRevision !== config.revision.toString()) {
    throw new Error('Published config revision does not match the finalized config');
  }
  if (config.requiredAmount !== requiredAmount || config.minimumLockSeconds !== minimumLockSeconds) {
    throw new Error('Published stake terms do not match the finalized config');
  }
  if ((stake.status === 'paused') !== config.paused) {
    throw new Error('Policy status does not match the finalized config pause state');
  }

  const parsedMint = mintAccount.value;
  if (!parsedMint || !parsedMint.owner.equals(TOKEN_2022_PROGRAM) || !('parsed' in parsedMint.data)) {
    throw new Error('Canonical mint is not a parsed Token-2022 mint');
  }
  const mintInfo = parsedMint.data.parsed?.info;
  if (
    parsedMint.data.parsed?.type !== 'mint'
    || mintInfo?.decimals !== stake.tokenDecimals
    || mintInfo?.isInitialized !== true
    || mintInfo?.mintAuthority !== null
    || mintInfo?.freezeAuthority !== null
  ) throw new Error('Canonical mint decimals or revoked authorities do not match policy');
  const extensions = Array.isArray(mintInfo.extensions) ? mintInfo.extensions : [];
  const allowedExtensions = new Set(['metadataPointer', 'tokenMetadata']);
  if (extensions.some((item) => !allowedExtensions.has(item.extension))) {
    throw new Error('Canonical mint contains an unreviewed Token-2022 extension');
  }
  const metadataPointer = extensions.find((item) => item.extension === 'metadataPointer')?.state;
  const tokenMetadata = extensions.find((item) => item.extension === 'tokenMetadata')?.state;
  if (
    metadataPointer?.authority !== null
    || metadataPointer?.metadataAddress !== mint.toBase58()
    || tokenMetadata?.updateAuthority !== null
    || tokenMetadata?.mint !== mint.toBase58()
  ) throw new Error('Canonical mint metadata authorities are not permanently revoked');

  const publicOrigin = 'https://nealtheseal.org';
  const challenge = issuerEndpoint(policy.identity?.challengeEndpoint, 'identity.challengeEndpoint', '/v2/challenge');
  const verify = issuerEndpoint(policy.identity?.verifyEndpoint, 'identity.verifyEndpoint', '/v2/verify');
  const token = issuerEndpoint(stake.tokenEndpoint, 'accessStake.tokenEndpoint', '/v2/access-token');
  if (new Set([challenge.origin, verify.origin, token.origin]).size !== 1) {
    throw new Error('Issuer endpoints must share one HTTPS origin');
  }
  if (checkEndpoints) await Promise.all([challenge, verify, token].map((url) => checkPreflight(url, publicOrigin)));

  return {
    programId: programId.toBase58(),
    programDataAddress: programDataAddress.toBase58(),
    programSha256: deployedHash,
    configAddress: configAddress.toBase58(),
    mint: mint.toBase58(),
    requiredAtomicAmount: requiredAmount.toString(),
    minimumLockSeconds: Number(minimumLockSeconds),
    configRevision: config.revision.toString(),
    issuerAuthority: config.issuerAuthority.toBase58(),
    status: stake.status,
    issuerOrigin: challenge.origin,
  };
}

const parseCli = (argv) => {
  const options = {
    policy: 'apps/site/public/wallet-policy.json',
    launch: 'apps/site/public/launch-record.json',
    requireActive: false,
    informationalPlanned: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--policy') options.policy = argv[++index];
    else if (argument === '--launch') options.launch = argv[++index];
    else if (argument === '--require-active') options.requireActive = true;
    else if (argument === '--informational-planned') options.informationalPlanned = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  const policy = await readJson(path.resolve(options.policy));
  const launch = await readJson(path.resolve(options.launch));
  if (options.requireActive && policy.accessStake?.status !== 'active') {
    throw new Error('Access staking is not active');
  }
  if (policy.accessStake?.status === 'planned' && !options.requireActive) {
    const blockers = [
      ['programId', policy.accessStake.programId],
      ['programDataAddress', policy.accessStake.programDataAddress],
      ['programSha256', policy.accessStake.programSha256],
      ['configAddress', policy.accessStake.configAddress],
      ['configRevision', policy.accessStake.configRevision],
      ['issuerAuthority', policy.accessStake.issuerAuthority],
      ['requiredAtomicAmount', policy.accessStake.requiredAtomicAmount],
      ['minimumLockSeconds', policy.accessStake.minimumLockSeconds],
      ['identity.challengeEndpoint', policy.identity?.challengeEndpoint],
      ['identity.verifyEndpoint', policy.identity?.verifyEndpoint],
      ['tokenEndpoint', policy.accessStake.tokenEndpoint],
    ].filter(([, value]) => value === null || value === undefined || value === '');
    console.log(JSON.stringify({ status: 'planned', blockers: blockers.map(([name]) => name) }, null, 2));
    if (!options.informationalPlanned) process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(await verifyAccessStake(policy, launch), null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`Access-stake readiness failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
