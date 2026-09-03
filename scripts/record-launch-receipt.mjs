import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receiptArgument = process.argv[2];
if (!receiptArgument) throw new Error('usage: npm run launcher:record -- /absolute/path/to/launch-receipt.json');

const receipt = JSON.parse(await readFile(resolve(receiptArgument), 'utf8'));
if (receipt.schema !== 'neal.launch-receipt/v1') throw new Error('receipt schema must be neal.launch-receipt/v1');
const mint = new PublicKey(receipt.mintAddress);
const signatureBytes = bs58.decode(receipt.creationTransaction);
if (signatureBytes.length !== 64) throw new Error('creationTransaction is not a 64-byte Solana signature');

const rpcEndpoint = process.env.NEAL_SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const connection = new Connection(rpcEndpoint, 'confirmed');
const transaction = await connection.getTransaction(receipt.creationTransaction, {
  commitment: 'confirmed',
  maxSupportedTransactionVersion: 0,
});
if (!transaction) throw new Error('creation transaction is not confirmed on the selected RPC');
if (transaction.meta?.err) throw new Error(`creation transaction failed: ${JSON.stringify(transaction.meta.err)}`);
const message = transaction.transaction.message;
const accountKeys = 'getAccountKeys' in message
  ? message.getAccountKeys().staticAccountKeys.map((key) => key.toBase58())
  : message.accountKeys.map((key) => key.toBase58());
if (!accountKeys.includes(mint.toBase58())) throw new Error('receipt mint is not present in the creation transaction');

const configPath = resolve(root, 'launch-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (config.execution.mintAddress || config.execution.creationTransaction) {
  throw new Error('launch-config.json already contains an execution receipt; refusing to overwrite it');
}
if (!accountKeys.includes(config.pumpfun.creatorWallet)) {
  throw new Error('disclosed creator wallet is not present in the creation transaction');
}
config.execution.mintAddress = mint.toBase58();
config.execution.creationTransaction = receipt.creationTransaction;
config.status = 'launched';

const temporaryPath = `${configPath}.next`;
await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
await rename(temporaryPath, configPath);
console.log(JSON.stringify({ recorded: true, mintAddress: mint.toBase58(), creationTransaction: receipt.creationTransaction }, null, 2));
