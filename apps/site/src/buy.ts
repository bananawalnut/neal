import { getBuyTokenAmountFromSolAmount, OnlinePumpSdk, PUMP_SDK } from '@pump-fun/pump-sdk';
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import BN from 'bn.js';
import bs58 from 'bs58';
import type { WalletAccount } from '@wallet-standard/base';
import type { WalletIdentityController, WalletTransactionSession } from './wallet';

const SLIPPAGE_PERCENT = 3;
const MINIMUM_BUY_LAMPORTS = 1_000_000n;
const MAXIMUM_BUY_LAMPORTS = 5_000_000_000n;

type PreparedBuy = {
  accountAddress: string;
  mintAddress: string;
  hardMaximumLamports: bigint;
  quotedInputLamports: bigint;
  estimatedTokenBaseUnits: string;
  connection: Connection;
  transaction: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
  networkFeeLamports: number;
  walletBalanceLamports: number;
  unitsConsumed: number | null;
};

const requireElement = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const parseSolToLamports = (value: string): bigint => {
  const trimmed = value.trim();
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,9}))?$/u.exec(trimmed);
  if (!match) throw new Error('Enter an exact SOL maximum with no more than 9 decimal places.');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const lamports = BigInt(`${whole}${fraction.padEnd(9, '0')}`.replace(/^0+(?=\d)/u, ''));
  if (lamports < MINIMUM_BUY_LAMPORTS) throw new Error('The on-site minimum is 0.001 SOL.');
  if (lamports > MAXIMUM_BUY_LAMPORTS) throw new Error('Use Pump directly for buys above the 5 SOL on-site safety limit.');
  return lamports;
};

const lamportsToSol = (value: bigint | number): string => {
  const raw = BigInt(value).toString().padStart(10, '0');
  const whole = raw.slice(0, -9);
  const fraction = raw.slice(-9).replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole;
};

const formatNeal = (atomic: string): string => {
  const raw = atomic.padStart(7, '0');
  const whole = raw.slice(0, -6);
  const fraction = raw.slice(-6).replace(/0+$/u, '');
  return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
};

const shortAddress = (address: string): string => `${address.slice(0, 5)}…${address.slice(-5)}`;

const quoteInputInsideHardMaximum = (hardMaximumLamports: bigint): bigint => {
  const slippageTenths = BigInt(Math.floor(SLIPPAGE_PERCENT * 10));
  return (hardMaximumLamports * 1000n) / (1000n + slippageTenths);
};

const simulate = async (connection: Connection, transaction: VersionedTransaction) => {
  const result = await connection.simulateTransaction(transaction, {
    commitment: 'confirmed',
    replaceRecentBlockhash: false,
    sigVerify: false,
  });
  if (result.value.err) throw new Error(`Buy simulation failed: ${JSON.stringify(result.value.err)}`);
  return result.value;
};

const buildBuy = async (
  mintAddress: string,
  session: WalletTransactionSession,
  hardMaximumLamports: bigint,
): Promise<PreparedBuy> => {
  const connection = new Connection(session.rpcEndpoint, 'confirmed');
  const onlineSdk = new OnlinePumpSdk(connection);
  const mint = new PublicKey(mintAddress);
  const user = new PublicKey(session.account.address);
  const [global, feeConfig, buyState, supply] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
    onlineSdk.fetchBuyState(mint, user, TOKEN_2022_PROGRAM_ID),
    connection.getTokenSupply(mint, 'confirmed'),
  ]);
  if (buyState.bondingCurve.complete) {
    throw new Error('NEAL has graduated from the bonding curve. Use the Pump link for its live market.');
  }

  const quotedInputLamports = quoteInputInsideHardMaximum(hardMaximumLamports);
  const solAmount = new BN(quotedInputLamports.toString());
  const estimatedTokens = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: new BN(supply.value.amount),
    bondingCurve: buyState.bondingCurve,
    amount: solAmount,
    quoteMint: NATIVE_MINT,
  });
  if (estimatedTokens.isZero()) throw new Error('That SOL maximum currently produces a zero-token quote.');

  const instructions = await PUMP_SDK.buyInstructions({
    global,
    ...buyState,
    mint,
    user,
    amount: estimatedTokens,
    solAmount,
    slippage: SLIPPAGE_PERCENT,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const [simulation, fee, walletBalanceLamports] = await Promise.all([
    simulate(connection, transaction),
    connection.getFeeForMessage(message, 'confirmed'),
    connection.getBalance(user, 'confirmed'),
  ]);

  return {
    accountAddress: session.account.address,
    mintAddress,
    hardMaximumLamports,
    quotedInputLamports,
    estimatedTokenBaseUnits: estimatedTokens.toString(),
    connection,
    transaction,
    blockhash,
    lastValidBlockHeight,
    networkFeeLamports: fee.value ?? 0,
    walletBalanceLamports,
    unitsConsumed: simulation.unitsConsumed ?? null,
  };
};

const refreshPreparedBuy = async (prepared: PreparedBuy): Promise<PreparedBuy> => {
  const { blockhash, lastValidBlockHeight } = await prepared.connection.getLatestBlockhash('confirmed');
  prepared.transaction.message.recentBlockhash = blockhash;
  prepared.transaction.signatures = prepared.transaction.signatures.map(() => new Uint8Array(64));
  const [simulation, walletBalanceLamports] = await Promise.all([
    simulate(prepared.connection, prepared.transaction),
    prepared.connection.getBalance(new PublicKey(prepared.accountAddress), 'confirmed'),
  ]);
  return {
    ...prepared,
    blockhash,
    lastValidBlockHeight,
    walletBalanceLamports,
    unitsConsumed: simulation.unitsConsumed ?? null,
  };
};

const signAndSend = async (prepared: PreparedBuy, session: WalletTransactionSession) => {
  const { wallet, account } = session;
  if (account.address !== prepared.accountAddress) throw new Error('Wallet account changed after quote. Build a new quote.');
  if (account.address !== prepared.transaction.message.staticAccountKeys[0]?.toBase58()) {
    throw new Error('Transaction payer does not match the connected wallet.');
  }
  const wire = prepared.transaction.serialize();
  const sendFeature = wallet.features[SolanaSignAndSendTransaction] as
    | SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
    | undefined;
  let signature: string;

  if (sendFeature && account.features.includes(SolanaSignAndSendTransaction)) {
    const output = (await sendFeature.signAndSendTransaction({
      account,
      transaction: wire,
      chain: session.chain,
      options: { commitment: 'confirmed', skipPreflight: false, maxRetries: 3 },
    }))[0];
    if (!output) throw new Error('Wallet returned no buy signature.');
    signature = bs58.encode(output.signature);
  } else {
    const signFeature = wallet.features[SolanaSignTransaction] as
      | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
      | undefined;
    if (!signFeature || !account.features.includes(SolanaSignTransaction)) {
      throw new Error('This wallet cannot sign a Solana transaction through Wallet Standard.');
    }
    const output = (await signFeature.signTransaction({ account, transaction: wire, chain: session.chain }))[0];
    if (!output) throw new Error('Wallet returned no signed buy transaction.');
    signature = await prepared.connection.sendRawTransaction(output.signedTransaction, {
      skipPreflight: false,
      maxRetries: 3,
    });
  }

  let confirmationStatus: 'submitted' | 'confirmed' | 'finalized' = 'confirmed';
  try {
    const confirmation = await prepared.connection.confirmTransaction({
      signature,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    }, 'confirmed');
    if (confirmation.value.err) throw new Error(`Buy failed: ${JSON.stringify(confirmation.value.err)}`);
  } catch (confirmationError) {
    const status = (await prepared.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw new Error(`Buy failed: ${JSON.stringify(status.err)}`);
    if (!status) throw confirmationError;
    confirmationStatus = status.confirmationStatus === 'finalized'
      ? 'finalized'
      : status.confirmationStatus === 'confirmed' ? 'confirmed' : 'submitted';
  }
  return { signature, confirmationStatus };
};

const setStatus = (message: string, state: 'idle' | 'busy' | 'ready' | 'success' | 'error' = 'idle') => {
  const status = requireElement<HTMLElement>('buy-status');
  status.className = `buy-status ${state}`;
  status.textContent = message;
};

export function mountNealPurchase(
  getCanonicalMint: () => string | null,
  walletController: WalletIdentityController,
): void {
  const form = requireElement<HTMLFormElement>('buy-form');
  const amountInput = requireElement<HTMLInputElement>('buy-sol');
  const quoteButton = requireElement<HTMLButtonElement>('buy-quote');
  const connectButton = requireElement<HTMLButtonElement>('buy-connect');
  const review = requireElement<HTMLElement>('buy-review');
  const reviewed = requireElement<HTMLInputElement>('buy-reviewed');
  const submit = requireElement<HTMLButtonElement>('buy-submit');
  const resultLink = requireElement<HTMLAnchorElement>('buy-result');
  const walletState = requireElement<HTMLElement>('buy-wallet-state');
  let prepared: PreparedBuy | null = null;
  let preparedInput = '';

  const invalidate = (message = 'Enter a maximum and build a live quote.'): void => {
    prepared = null;
    preparedInput = '';
    review.hidden = true;
    reviewed.checked = false;
    submit.disabled = true;
    resultLink.hidden = true;
    setStatus(message);
  };

  const renderWallet = (): void => {
    const session = walletController.getTransactionSession();
    walletState.textContent = session ? `CONNECTED · ${shortAddress(session.account.address)}` : 'WALLET REQUIRED';
    connectButton.textContent = session ? 'CHANGE WALLET' : 'CONNECT WALLET TO BUY';
    if (prepared && session?.account.address !== prepared.accountAddress) invalidate('Wallet changed. Build a new quote.');
  };

  const renderPrepared = (value: PreparedBuy): void => {
    requireElement<HTMLElement>('buy-review-mint').textContent = value.mintAddress;
    requireElement<HTMLElement>('buy-review-input').textContent = `${lamportsToSol(value.quotedInputLamports)} SOL`;
    requireElement<HTMLElement>('buy-review-max').textContent = `${lamportsToSol(value.hardMaximumLamports)} SOL`;
    requireElement<HTMLElement>('buy-review-output').textContent = `≈ ${formatNeal(value.estimatedTokenBaseUnits)} NEAL`;
    requireElement<HTMLElement>('buy-review-fee').textContent = `${lamportsToSol(value.networkFeeLamports)} SOL + token-account rent if required`;
    requireElement<HTMLElement>('buy-review-balance').textContent = `${lamportsToSol(value.walletBalanceLamports)} SOL`;
    requireElement<HTMLElement>('buy-review-compute').textContent = value.unitsConsumed?.toLocaleString() ?? 'RPC DID NOT REPORT';
    review.hidden = false;
    setStatus('Simulation passed. Review the mint, quote and hard maximum before wallet approval.', 'ready');
  };

  form.addEventListener('submit', (event) => event.preventDefault());
  connectButton.addEventListener('click', () => walletController.openWalletPicker());
  document.addEventListener('neal:wallet-session-change', renderWallet);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-buy-sol]')) {
    button.addEventListener('click', () => {
      amountInput.value = button.dataset.buySol ?? '';
      amountInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  amountInput.addEventListener('input', () => invalidate());
  reviewed.addEventListener('change', () => {
    submit.disabled = !(prepared && reviewed.checked);
  });

  quoteButton.addEventListener('click', () => {
    void (async () => {
      const mint = getCanonicalMint();
      const session = walletController.getTransactionSession();
      if (!mint) {
        setStatus('Canonical NEAL mint is unavailable. Buying is disabled.', 'error');
        return;
      }
      if (!session) {
        setStatus('Connect a Solana wallet before building the quote.', 'error');
        walletController.openWalletPicker();
        return;
      }
      quoteButton.disabled = true;
      review.hidden = true;
      resultLink.hidden = true;
      setStatus('Reading the live Pump curve and simulating the exact buy…', 'busy');
      try {
        const hardMaximumLamports = parseSolToLamports(amountInput.value);
        prepared = await buildBuy(mint, session, hardMaximumLamports);
        preparedInput = amountInput.value.trim();
        reviewed.checked = false;
        submit.disabled = true;
        renderPrepared(prepared);
      } catch (error) {
        prepared = null;
        setStatus(error instanceof Error ? error.message : 'Could not build the NEAL quote.', 'error');
      } finally {
        quoteButton.disabled = false;
      }
    })();
  });

  submit.addEventListener('click', () => {
    void (async () => {
      const session = walletController.getTransactionSession();
      if (!prepared || !session || !reviewed.checked) return;
      if (amountInput.value.trim() !== preparedInput) {
        invalidate('Amount changed. Build a new quote.');
        return;
      }
      submit.disabled = true;
      setStatus('Refreshing the blockhash and re-simulating the reviewed buy…', 'busy');
      try {
        prepared = await refreshPreparedBuy(prepared);
        setStatus('Fresh simulation passed. Review and approve promptly in your wallet.', 'busy');
        const result = await signAndSend(prepared, session);
        resultLink.href = `https://solscan.io/tx/${result.signature}`;
        resultLink.hidden = false;
        setStatus(
          result.confirmationStatus === 'submitted'
            ? 'Buy submitted. Check the explorer before attempting anything again.'
            : `Buy ${result.confirmationStatus}. Welcome to the mob.`,
          'success',
        );
        reviewed.checked = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'NEAL purchase failed.';
        setStatus(/expired|block height exceeded|blockhash not found/iu.test(message)
          ? 'Confirmation was inconclusive. Do not retry until you check your wallet and the explorer.'
          : message, 'error');
        submit.disabled = !reviewed.checked;
      }
    })();
  });

  renderWallet();
  if (!getCanonicalMint()) setStatus('Canonical NEAL mint is unavailable. Buying is disabled.', 'error');
}
