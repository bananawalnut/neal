import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from '@pump-fun/pump-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const control = JSON.parse(await readFile(resolve(root, 'launch-config.json'), 'utf8'));
const endpoint = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const creator = new PublicKey(control.pumpfun.creatorWallet);
const maximumPurchaseLamports = BigInt(control.pumpfun.initialCreatorPurchaseLamports);
if (maximumPurchaseLamports <= 0n) throw new Error('preflight requires a positive launch purchase ceiling');

const connection = new Connection(endpoint, 'confirmed');
const onlineSdk = new OnlinePumpSdk(connection);
const mint = Keypair.generate();
const [global, feeConfig] = await Promise.all([onlineSdk.fetchGlobal(), onlineSdk.fetchFeeConfig()]);
const curveInputLamports = (maximumPurchaseLamports * 100n) / 101n;
const quoteAmount = new BN(curveInputLamports.toString());
const amount = getBuyTokenAmountFromSolAmount({
  global,
  feeConfig,
  mintSupply: null,
  bondingCurve: null,
  amount: quoteAmount,
  quoteMint: NATIVE_MINT,
});
const instructions = await PUMP_SDK.createV2AndBuyInstructions({
  global,
  mint: mint.publicKey,
  name: control.token.name,
  symbol: control.token.symbol,
  uri: control.token.metadataUri,
  creator,
  user: creator,
  amount,
  solAmount: quoteAmount,
  mayhemMode: control.pumpfun.mayhemMode,
  cashback: control.pumpfun.cashBack,
});

const { blockhash } = await connection.getLatestBlockhash('finalized');
const message = new TransactionMessage({
  payerKey: creator,
  recentBlockhash: blockhash,
  instructions,
}).compileToV0Message();
const transaction = new VersionedTransaction(message);
transaction.sign([mint]);
const wire = transaction.serialize();
const base64 = Buffer.from(wire).toString('base64');
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'simulateTransaction',
    params: [base64, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      accounts: { encoding: 'base64', addresses: [creator.toBase58()] },
    }],
  }),
});
if (!response.ok) throw new Error(`RPC simulation HTTP ${response.status}`);
const envelope = await response.json();
if (envelope.error) throw new Error(envelope.error.message ?? 'RPC simulation failed');
const [fee, balance, rentExemptFloorLamports] = await Promise.all([
  connection.getFeeForMessage(message, 'confirmed'),
  connection.getBalance(creator, 'confirmed'),
  connection.getMinimumBalanceForRentExemption(0, 'confirmed'),
]);
const logs = envelope.result.value.logs ?? [];
const insufficientTransfer = logs
  .map((line) => line.match(/Transfer: insufficient lamports (\d+), need (\d+)/))
  .find(Boolean);
const observedTransferDeficitLamports = insufficientTransfer
  ? Number(insufficientTransfer[2]) - Number(insufficientTransfer[1])
  : null;
console.log(JSON.stringify({
  schema: 'neal.unsigned-launch-preflight/v1',
  creator: creator.toBase58(),
  generatedMint: mint.publicKey.toBase58(),
  walletBalanceLamports: balance,
  maximumPurchaseLamports: maximumPurchaseLamports.toString(),
  curveInputLamports: curveInputLamports.toString(),
  estimatedTokenBaseUnits: amount.toString(),
  networkFeeLamports: fee.value,
  rentExemptFloorLamports,
  simulatedCreatorBalanceLamports: envelope.result.value.accounts?.[0]?.lamports ?? null,
  observedTransferDeficitLamports,
  simulation: {
    ok: !envelope.result.value.err,
    error: envelope.result.value.err,
    unitsConsumed: envelope.result.value.unitsConsumed ?? null,
    logs,
  },
}, null, 2));
