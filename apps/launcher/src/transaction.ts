import { feeSharingConfigPda, getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from '@pump-fun/pump-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import type { LaunchControl, ReviewInput } from './types';

const CHAIN = 'solana:mainnet';

export type InstructionReview = {
  index: number;
  programId: string;
  signerCount: number;
  writableCount: number;
  dataBytes: number;
};

export type SimulationReview = {
  ok: boolean;
  error: string | null;
  logs: string[];
  unitsConsumed: number | null;
  networkFeeLamports: number | null;
  walletBalanceLamports: number;
};

export type PreparedLaunch = {
  mint: Keypair;
  transaction: VersionedTransaction;
  connection: Connection;
  blockhash: string;
  lastValidBlockHeight: number;
  maximumPurchaseLamports: bigint;
  curveInputLamports: bigint;
  estimatedTokenBaseUnits: string;
  instructions: InstructionReview[];
  simulation: SimulationReview;
};

type RpcResponse<T> = { result?: T; error?: { message?: string; data?: unknown } };

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const hardMaxToCurveInput = (hardMaximum: bigint): bigint => {
  // Pump SDK 1.36.0 adds 1% slippage inside createV2AndBuyInstructions.
  // Floor the curve input so the instruction's final quote cap never exceeds
  // the operator-approved hard maximum.
  return (hardMaximum * 100n) / 101n;
};

const reviewInstructions = (instructions: TransactionInstruction[]): InstructionReview[] =>
  instructions.map((instruction, index) => ({
    index: index + 1,
    programId: instruction.programId.toBase58(),
    signerCount: instruction.keys.filter((key) => key.isSigner).length,
    writableCount: instruction.keys.filter((key) => key.isWritable).length,
    dataBytes: instruction.data.length,
  }));

const simulateUnsigned = async (
  endpoint: string,
  transaction: VersionedTransaction,
): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }> => {
  const wire = transaction.serialize();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'simulateTransaction',
      params: [
        toBase64(wire),
        {
          encoding: 'base64',
          commitment: 'confirmed',
          sigVerify: false,
          replaceRecentBlockhash: false,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`RPC simulation HTTP ${response.status}`);
  const envelope = (await response.json()) as RpcResponse<{
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  }>;
  if (envelope.error) throw new Error(envelope.error.message ?? 'RPC simulation failed');
  if (!envelope.result) throw new Error('RPC simulation returned no result');
  return envelope.result.value;
};

export const buildLaunchTransaction = async (
  control: LaunchControl,
  input: ReviewInput,
  connectedAddress: string,
): Promise<PreparedLaunch> => {
  if (!control.pumpfun.creatorWallet) throw new Error('Creator wallet is missing');
  if (connectedAddress !== control.pumpfun.creatorWallet) {
    throw new Error(`Connected wallet must be the disclosed creator ${control.pumpfun.creatorWallet}`);
  }
  const maximumPurchaseLamports = BigInt(input.maximumPurchaseLamports);
  if (maximumPurchaseLamports < 0n) throw new Error('Purchase maximum cannot be negative');

  const connection = new Connection(input.rpcEndpoint, 'confirmed');
  const onlineSdk = new OnlinePumpSdk(connection);
  const creator = new PublicKey(control.pumpfun.creatorWallet);
  const mint = Keypair.generate();
  const instructions: TransactionInstruction[] = [];
  let curveInputLamports = 0n;
  let estimatedTokenBaseUnits = '0';

  if (maximumPurchaseLamports === 0n) {
    instructions.push(
      await PUMP_SDK.createV2Instruction({
        mint: mint.publicKey,
        name: control.token.name,
        symbol: control.token.symbol,
        uri: input.metadataUri,
        creator,
        user: creator,
        mayhemMode: control.pumpfun.mayhemMode,
        cashback: control.pumpfun.cashBack,
      }),
    );
  } else {
    const [global, feeConfig] = await Promise.all([onlineSdk.fetchGlobal(), onlineSdk.fetchFeeConfig()]);
    curveInputLamports = hardMaxToCurveInput(maximumPurchaseLamports);
    const quoteAmount = new BN(curveInputLamports.toString());
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: null,
      bondingCurve: null,
      amount: quoteAmount,
      quoteMint: NATIVE_MINT,
    });
    if (amount.isZero()) throw new Error('The purchase budget produces a zero-token quote');
    estimatedTokenBaseUnits = amount.toString();
    instructions.push(
      ...(await PUMP_SDK.createV2AndBuyInstructions({
        global,
        mint: mint.publicKey,
        name: control.token.name,
        symbol: control.token.symbol,
        uri: input.metadataUri,
        creator,
        user: creator,
        amount,
        solAmount: quoteAmount,
        mayhemMode: control.pumpfun.mayhemMode,
        cashback: control.pumpfun.cashBack,
      })),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  const message = new TransactionMessage({
    payerKey: creator,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  transaction.sign([mint]);

  const [simulation, networkFee, walletBalanceLamports] = await Promise.all([
    simulateUnsigned(input.rpcEndpoint, transaction),
    connection.getFeeForMessage(message, 'confirmed'),
    connection.getBalance(creator, 'confirmed'),
  ]);
  const error = simulation.err ? JSON.stringify(simulation.err) : null;

  return {
    mint,
    transaction,
    connection,
    blockhash,
    lastValidBlockHeight,
    maximumPurchaseLamports,
    curveInputLamports,
    estimatedTokenBaseUnits,
    instructions: reviewInstructions(instructions),
    simulation: {
      ok: !simulation.err,
      error,
      logs: simulation.logs ?? [],
      unitsConsumed: simulation.unitsConsumed ?? null,
      networkFeeLamports: networkFee.value,
      walletBalanceLamports,
    },
  };
};

export const refreshPreparedLaunch = async (prepared: PreparedLaunch): Promise<PreparedLaunch> => {
  const payer = prepared.transaction.message.staticAccountKeys[0];
  if (!payer) throw new Error('Prepared transaction has no payer');
  const { blockhash, lastValidBlockHeight } = await prepared.connection.getLatestBlockhash('confirmed');
  prepared.transaction.message.recentBlockhash = blockhash;
  prepared.transaction.signatures = prepared.transaction.signatures.map(() => new Uint8Array(64));
  prepared.transaction.sign([prepared.mint]);

  const [simulation, walletBalanceLamports] = await Promise.all([
    simulateUnsigned(prepared.connection.rpcEndpoint, prepared.transaction),
    prepared.connection.getBalance(payer, 'confirmed'),
  ]);
  const error = simulation.err ? JSON.stringify(simulation.err) : null;
  if (error) throw new Error(`Fresh simulation failed: ${error}`);

  return {
    ...prepared,
    blockhash,
    lastValidBlockHeight,
    simulation: {
      ...prepared.simulation,
      ok: true,
      error: null,
      logs: simulation.logs ?? [],
      unitsConsumed: simulation.unitsConsumed ?? null,
      walletBalanceLamports,
    },
  };
};

export const signAndSendPreparedLaunch = async (
  prepared: PreparedLaunch,
  wallet: Wallet,
  account: WalletAccount,
): Promise<string> => {
  if (!prepared.simulation.ok) throw new Error('Refusing to sign a transaction that did not simulate successfully');
  if (account.address !== prepared.transaction.message.staticAccountKeys[0]?.toBase58()) {
    throw new Error('Wallet account changed after review; rebuild the transaction');
  }
  const wire = prepared.transaction.serialize();
  const sendFeature = wallet.features[SolanaSignAndSendTransaction] as
    | SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
    | undefined;

  let signature: string;
  if (sendFeature && account.features.includes(SolanaSignAndSendTransaction)) {
    const result = (
      await sendFeature.signAndSendTransaction({
        account,
        transaction: wire,
        chain: CHAIN,
        options: { commitment: 'confirmed', skipPreflight: false, maxRetries: 3 },
      })
    )[0];
    if (!result) throw new Error('Wallet returned no transaction signature');
    signature = bs58.encode(result.signature);
  } else {
    const signFeature = wallet.features[SolanaSignTransaction] as
      | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
      | undefined;
    if (!signFeature || !account.features.includes(SolanaSignTransaction)) {
      throw new Error('Wallet cannot sign a Solana transaction through Wallet Standard');
    }
    const result = (
      await signFeature.signTransaction({ account, transaction: wire, chain: CHAIN })
    )[0];
    if (!result) throw new Error('Wallet returned no signed transaction');
    signature = await prepared.connection.sendRawTransaction(result.signedTransaction, {
      skipPreflight: false,
      maxRetries: 3,
    });
  }

  try {
    const confirmation = await prepared.connection.confirmTransaction(
      { signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
      'confirmed',
    );
    if (confirmation.value.err) throw new Error(`Launch transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  } catch (confirmationError) {
    // Confirmation polling can cross the block-height boundary after the RPC
    // already accepted and finalized the transaction. Reconcile the returned
    // signature against chain history before ever telling the operator to retry.
    const status = (
      await prepared.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
    ).value[0];
    if (status?.err) throw new Error(`Launch transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus !== 'confirmed' && status?.confirmationStatus !== 'finalized') {
      throw confirmationError;
    }
  }
  return signature;
};

export const buildFeeSharingInstructions = async (
  control: LaunchControl,
): Promise<{ configurationAddress: string; create: TransactionInstruction; finalize: TransactionInstruction }> => {
  const mintValue = control.execution.mintAddress;
  const creatorValue = control.pumpfun.creatorWallet;
  if (!mintValue || !creatorValue) throw new Error('Canonical mint and creator are required after launch');
  const mint = new PublicKey(mintValue);
  const creator = new PublicKey(creatorValue);
  const shares = control.programs.economics.creatorFeeRouting.shares.map((share) => {
    if (!share.wallet) throw new Error(`${share.role} fee recipient is missing`);
    return { address: new PublicKey(share.wallet), shareBps: share.shareBasisPoints };
  });
  const total = shares.reduce((sum, share) => sum + share.shareBps, 0);
  if (total !== 10_000) throw new Error(`Fee shares total ${total}, expected 10000`);
  const create = await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null });
  const finalize = await PUMP_SDK.updateFeeSharesV2({
    authority: creator,
    mint,
    currentShareholders: [creator],
    newShareholders: shares,
    quoteMint: NATIVE_MINT,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  return { configurationAddress: feeSharingConfigPda(mint).toBase58(), create, finalize };
};
