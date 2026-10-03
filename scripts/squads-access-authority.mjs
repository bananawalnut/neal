import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const CONFIG_DISCRIMINATOR = Buffer.from('NEALACFG');
const VAULT_INDEX = 0;
export const SQUADS_MANIFEST_SCHEMA = 'neal.squads-access-proposal/v1';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const key = (value, label) => {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(label + ' must be a Solana public key');
  }
};
const unsigned = (value, label) => {
  if (!/^(0|[1-9][0-9]*)$/u.test(String(value))) throw new Error(label + ' must be an unsigned integer');
  return BigInt(value);
};
const normalizeInstruction = (instruction) => ({
  programId: instruction.programId.toBase58(),
  accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
    pubkey: pubkey.toBase58(), isSigner, isWritable,
  })),
  dataBase64: Buffer.from(instruction.data).toString('base64'),
});

export function buildAccessInstruction(options) {
  const action = options.action;
  const programId = key(options.programId, 'programId');
  const vault = key(options.vault, 'vault');
  const configAddress = key(options.configAddress, 'configAddress');
  if (action === 'initialize') {
    const issuerAuthority = key(options.issuerAuthority, 'issuerAuthority');
    const mint = key(options.mint, 'mint');
    const configId = unsigned(options.configId, 'configId');
    const requiredAmount = unsigned(options.requiredAtomicAmount, 'requiredAtomicAmount');
    const minimumLockSeconds = BigInt(options.minimumLockSeconds);
    if (requiredAmount <= 0n || minimumLockSeconds <= 0n || minimumLockSeconds > 31_536_000n) {
      throw new Error('Access terms are outside the on-chain bounds');
    }
    const data = Buffer.alloc(57);
    data[0] = 0;
    data.writeBigUInt64LE(configId, 1);
    issuerAuthority.toBuffer().copy(data, 9);
    data.writeBigUInt64LE(requiredAmount, 41);
    data.writeBigInt64LE(minimumLockSeconds, 49);
    return new TransactionInstruction({
      programId,
      keys: [
        { pubkey: vault, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: true, isWritable: false },
        { pubkey: configAddress, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }
  if (!['pause', 'unpause'].includes(action)) throw new Error('action must be initialize, pause, or unpause');
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: vault, isSigner: true, isWritable: false },
      { pubkey: configAddress, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, action === 'pause' ? 1 : 0]),
  });
}

export function createProposalManifest(options) {
  const multisigPda = key(options.multisig, 'multisig');
  const [vault, vaultBump] = multisig.getVaultPda({ multisigPda, index: VAULT_INDEX });
  if (options.vault && !vault.equals(key(options.vault, 'vault'))) throw new Error('Vault does not match Squads vault index zero');
  const instruction = buildAccessInstruction({ ...options, vault: vault.toBase58() });
  const normalized = normalizeInstruction(instruction);
  const terms = options.action === 'initialize'
    ? {
        configId: String(unsigned(options.configId, 'configId')),
        mint: key(options.mint, 'mint').toBase58(),
        issuerAuthority: key(options.issuerAuthority, 'issuerAuthority').toBase58(),
        requiredAtomicAmount: String(unsigned(options.requiredAtomicAmount, 'requiredAtomicAmount')),
        minimumLockSeconds: Number(options.minimumLockSeconds),
      }
    : null;
  return {
    schema: SQUADS_MANIFEST_SCHEMA,
    cluster: options.cluster,
    action: options.action,
    squadsProgramId: multisig.PROGRAM_ID.toBase58(),
    multisig: multisigPda.toBase58(),
    vault: vault.toBase58(),
    vaultIndex: VAULT_INDEX,
    vaultBump,
    transactionIndex: String(unsigned(options.transactionIndex, 'transactionIndex')),
    accessProgramId: key(options.programId, 'programId').toBase58(),
    configAddress: key(options.configAddress, 'configAddress').toBase58(),
    terms,
    expectedRevision: String(unsigned(options.expectedRevision, 'expectedRevision')),
    innerInstruction: normalized,
    messageHash: hash(Buffer.from(JSON.stringify(normalized))),
  };
}

export function validateProposalManifest(value) {
  const required = [
    'schema', 'cluster', 'action', 'squadsProgramId', 'multisig', 'vault', 'vaultIndex',
    'vaultBump', 'transactionIndex', 'accessProgramId', 'configAddress', 'terms',
    'expectedRevision', 'innerInstruction', 'messageHash',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Proposal manifest must be an object');
  if (Object.keys(value).sort().join() !== required.sort().join()) throw new Error('Proposal manifest fields are unsupported');
  if (value.schema !== SQUADS_MANIFEST_SCHEMA) throw new Error('Proposal manifest schema is unsupported');
  if (!['devnet', 'mainnet'].includes(value.cluster) || !['initialize', 'pause', 'unpause'].includes(value.action)) {
    throw new Error('Proposal manifest cluster or action is unsupported');
  }
  if (value.squadsProgramId !== multisig.PROGRAM_ID.toBase58() || value.vaultIndex !== 0) {
    throw new Error('Proposal manifest must use the reviewed Squads program and vault index zero');
  }
  const rebuilt = createProposalManifest({
    cluster: value.cluster,
    action: value.action,
    multisig: value.multisig,
    vault: value.vault,
    transactionIndex: value.transactionIndex,
    programId: value.accessProgramId,
    configAddress: value.configAddress,
    expectedRevision: value.expectedRevision,
    ...(value.terms ? {
      configId: value.terms.configId,
      mint: value.terms.mint,
      issuerAuthority: value.terms.issuerAuthority,
      requiredAtomicAmount: value.terms.requiredAtomicAmount,
      minimumLockSeconds: value.terms.minimumLockSeconds,
    } : {}),
  });
  if (JSON.stringify(rebuilt) !== JSON.stringify(value)) throw new Error('Proposal manifest does not reproduce');
  return value;
}

const parseConfig = (data) => {
  if (data.length !== 171 || !data.subarray(0, 8).equals(CONFIG_DISCRIMINATOR) || data[8] !== 2) {
    throw new Error('Access config has an unsupported wire shape');
  }
  return {
    authority: new PublicKey(data.subarray(9, 41)),
    revision: data.readBigUInt64LE(145),
    paused: data[169] !== 0,
  };
};

const matchesStoredInstruction = (message, expected) => {
  if (message.addressTableLookups.length) return false;
  return message.instructions.some((entry) => {
    const program = message.accountKeys[entry.programIdIndex];
    const accounts = entry.accountIndexes.map((index) => message.accountKeys[index].toBase58());
    return program?.toBase58() === expected.programId
      && Buffer.from(entry.data).toString('base64') === expected.dataBase64
      && JSON.stringify(accounts) === JSON.stringify(expected.accounts.map(({ pubkey }) => pubkey));
  });
};

export async function inspectProposal(manifest, options) {
  const rpc = new URL(options.rpc);
  if (rpc.protocol !== 'https:') throw new Error('--rpc must use HTTPS');
  const connection = new Connection(rpc.toString(), 'finalized');
  const expectedGenesis = manifest.cluster === 'mainnet' ? MAINNET_GENESIS : DEVNET_GENESIS;
  if (await connection.getGenesisHash() !== expectedGenesis) throw new Error('RPC genesis does not match proposal cluster');
  const multisigPda = new PublicKey(manifest.multisig);
  const members = String(options.members ?? '').split(',').filter(Boolean).map((item) => key(item, 'member'));
  if (members.length !== 3 || new Set(members.map((member) => member.toBase58())).size !== 3) {
    throw new Error('--members must contain three distinct custodian public keys');
  }
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda, 'finalized');
  if (!multisigAccount.configAuthority.equals(PublicKey.default)) throw new Error('Squads multisig is not autonomous');
  if (multisigAccount.threshold !== 2 || multisigAccount.members.length !== 3) throw new Error('Squads multisig is not 2-of-3');
  const actualMembers = multisigAccount.members.map(({ key: member }) => member.toBase58()).sort();
  if (JSON.stringify(actualMembers) !== JSON.stringify(members.map((member) => member.toBase58()).sort())) {
    throw new Error('Squads member set does not match the reviewed custodians');
  }
  const index = BigInt(manifest.transactionIndex);
  const [transactionPda] = multisig.getTransactionPda({ multisigPda, index });
  const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: index });
  const [transaction, proposal, configInfo] = await Promise.all([
    multisig.accounts.VaultTransaction.fromAccountAddress(connection, transactionPda, 'finalized'),
    multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda, 'finalized'),
    connection.getAccountInfo(new PublicKey(manifest.configAddress), 'finalized'),
  ]);
  if (transaction.vaultIndex !== 0 || !matchesStoredInstruction(transaction.message, manifest.innerInstruction)) {
    throw new Error('Stored Squads transaction does not match the reviewed inner instruction');
  }
  const status = proposal.pretty().status;
  const approved = proposal.approved.map((member) => member.toBase58());
  if (approved.length < 2 || new Set(approved).size < 2) throw new Error('Squads proposal lacks two distinct approvals');
  if (options.postExecution) {
    if (status !== 'Executed') throw new Error('Squads proposal is not finalized as executed');
    if (!configInfo) throw new Error('Access config is missing after execution');
    const config = parseConfig(configInfo.data);
    if (!config.authority.equals(new PublicKey(manifest.vault)) || config.revision.toString() !== manifest.expectedRevision) {
      throw new Error('Finalized access config does not match the Squads vault and expected revision');
    }
    if (manifest.action === 'pause' && !config.paused) throw new Error('Finalized config was not paused');
    if (manifest.action === 'unpause' && config.paused) throw new Error('Finalized config was not unpaused');
  } else if (status !== 'Approved') {
    throw new Error('Squads proposal must be Approved before execution');
  }
  return {
    schema: 'neal.squads-access-inspection/v1',
    phase: options.postExecution ? 'post-execution' : 'pre-execution',
    multisig: manifest.multisig,
    vault: manifest.vault,
    transaction: transactionPda.toBase58(),
    proposal: proposalPda.toBase58(),
    approvals: approved.sort(),
    status,
    messageHash: manifest.messageHash,
    expectedRevision: manifest.expectedRevision,
  };
}

const parseCli = (argv) => {
  const values = { mode: null, postExecution: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'plan' || argument === 'inspect') values.mode = argument;
    else if (argument === '--post-execution') values.postExecution = true;
    else if (argument.startsWith('--')) values[argument.slice(2)] = argv[++index];
    else throw new Error('Unexpected argument: ' + argument);
  }
  if (!values.mode) throw new Error('Use plan or inspect');
  return values;
};

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.mode === 'plan') {
    const manifest = createProposalManifest({
      cluster: options.cluster,
      action: options.action,
      multisig: options.multisig,
      vault: options.vault,
      transactionIndex: options['transaction-index'],
      programId: options['program-id'],
      configAddress: options['config-address'],
      expectedRevision: options['expected-revision'],
      configId: options['config-id'],
      mint: options.mint,
      issuerAuthority: options['issuer-authority'],
      requiredAtomicAmount: options['required-atomic-amount'],
      minimumLockSeconds: options['minimum-lock-seconds'],
    });
    const output = options.output ? path.resolve(options.output) : null;
    if (output) await fs.writeFile(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  const manifest = validateProposalManifest(JSON.parse(await fs.readFile(path.resolve(options.manifest), 'utf8')));
  console.log(JSON.stringify(await inspectProposal(manifest, options), null, 2));
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error('Squads access-authority check failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
