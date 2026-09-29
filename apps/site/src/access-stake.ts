import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SolanaSignAndSendTransaction,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionFeature,
  type SolanaSignTransactionFeature,
} from '@solana/wallet-standard-features';
import bs58 from 'bs58';
import type { WalletIdentityController, WalletTransactionSession } from './wallet';

const CONFIG_DISCRIMINATOR = 'NEALACFG';
const STAKE_DISCRIMINATOR = 'NEALSTAK';
const NEAL_SERVER = 'matrix.nealtheseal.org';

type AccessStakePolicy = {
  status: 'planned' | 'active' | 'paused';
  programId: string | null;
  configAddress: string | null;
  mint: string;
  tokenProgram: string;
  tokenDecimals: number;
  requiredAtomicAmount: string | null;
  minimumLockSeconds: number | null;
  tokenEndpoint: string | null;
};

type WalletPolicy = {
  schema: 'neal.wallet-policy/v1';
  identity: { challengeEndpoint: string | null; verifyEndpoint: string | null };
  holderProof: { rpcEndpoint: string; commitment: 'confirmed' | 'finalized' };
  accessStake?: AccessStakePolicy;
};

type ConfiguredPolicy = AccessStakePolicy & {
  status: 'active' | 'paused';
  programId: string;
  configAddress: string;
  requiredAtomicAmount: string;
  minimumLockSeconds: number;
};

type ConfigState = {
  mint: PublicKey;
  tokenProgram: PublicKey;
  requiredAmount: bigint;
  minimumLockSeconds: number;
  paused: boolean;
};

type ReceiptState = {
  address: PublicKey;
  vault: PublicKey;
  amount: bigint;
  unlockAt: number;
  claimedAt: number;
  released: boolean;
};

type Ui = {
  panel: HTMLElement;
  terms: HTMLElement;
  status: HTMLElement;
  walletButton: HTMLButtonElement;
  stakeButton: HTMLButtonElement;
  claimButton: HTMLButtonElement;
  releaseButton: HTMLButtonElement;
  manualTokenButton: HTMLButtonElement;
  createButton: HTMLButtonElement;
  domainInput: HTMLInputElement;
  tokenField: HTMLElement;
  tokenInput: HTMLInputElement;
};

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const parseConfiguredPolicy = (walletPolicy: WalletPolicy, canonicalMint: string | null): ConfiguredPolicy | null => {
  const policy = walletPolicy.accessStake;
  if (!policy || policy.status === 'planned') return null;
  try {
    if (
      !policy.programId
      || !policy.configAddress
      || !policy.requiredAtomicAmount
      || policy.minimumLockSeconds === null
      || !Number.isSafeInteger(policy.minimumLockSeconds)
      || policy.minimumLockSeconds <= 0
      || policy.minimumLockSeconds > 365 * 24 * 60 * 60
      || policy.tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()
      || policy.tokenDecimals !== 6
      || canonicalMint !== policy.mint
      || BigInt(policy.requiredAtomicAmount) <= 0n
      || (policy.status === 'active' && (
        !policy.tokenEndpoint
        || !walletPolicy.identity.challengeEndpoint
        || !walletPolicy.identity.verifyEndpoint
      ))
    ) return null;
  } catch {
    return null;
  }
  return policy as ConfiguredPolicy;
};

const formatAtomic = (amount: bigint, decimals: number): string => {
  const raw = amount.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const fraction = raw.slice(-decimals).replace(/0+$/u, '');
  return `${BigInt(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
};

const formatDuration = (seconds: number): string => {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} DAY${seconds === 86_400 ? '' : 'S'}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} HOUR${seconds === 3_600 ? '' : 'S'}`;
  return `${seconds.toLocaleString()} SECONDS`;
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const discriminator = (data: Buffer, expected: string): boolean =>
  new TextDecoder().decode(data.subarray(0, 8)) === expected;

const readConfig = async (
  connection: Connection,
  program: PublicKey,
  configAddress: PublicKey,
): Promise<ConfigState> => {
  const info = await connection.getAccountInfo(configAddress, 'finalized');
  if (!info || !info.owner.equals(program) || info.data.length !== 131 || !discriminator(info.data, CONFIG_DISCRIMINATOR) || info.data[8] !== 1) {
    throw new Error('The finalized access-stake config is invalid.');
  }
  const authority = new PublicKey(info.data.subarray(9, 41));
  const configId = info.data.subarray(41, 49);
  const bump = info.data[130];
  const expected = PublicKey.createProgramAddressSync(
    [new TextEncoder().encode('access-config'), authority.toBytes(), configId, Uint8Array.of(bump)],
    program,
  );
  if (!expected.equals(configAddress)) throw new Error('The access-stake config PDA does not match its contents.');
  return {
    mint: new PublicKey(info.data.subarray(49, 81)),
    tokenProgram: new PublicKey(info.data.subarray(81, 113)),
    requiredAmount: info.data.readBigUInt64LE(113),
    minimumLockSeconds: Number(info.data.readBigInt64LE(121)),
    paused: info.data[129] !== 0,
  };
};

const receiptAddress = (program: PublicKey, config: PublicKey, staker: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('access-stake'), config.toBytes(), staker.toBytes()],
    program,
  )[0];

const readReceipt = async (
  connection: Connection,
  program: PublicKey,
  config: PublicKey,
  staker: PublicKey,
): Promise<ReceiptState | null> => {
  const address = receiptAddress(program, config, staker);
  const info = await connection.getAccountInfo(address, 'finalized');
  if (!info) return null;
  if (!info.owner.equals(program) || info.data.length !== 147 || !discriminator(info.data, STAKE_DISCRIMINATOR) || info.data[8] !== 1) {
    throw new Error('The finalized access-stake receipt is invalid.');
  }
  if (
    !bytesEqual(info.data.subarray(9, 41), config.toBytes())
    || !bytesEqual(info.data.subarray(41, 73), staker.toBytes())
  ) throw new Error('The access-stake receipt belongs to a different wallet or config.');
  const bump = info.data[146];
  const expected = PublicKey.createProgramAddressSync(
    [new TextEncoder().encode('access-stake'), config.toBytes(), staker.toBytes(), Uint8Array.of(bump)],
    program,
  );
  if (!expected.equals(address)) throw new Error('The access-stake receipt PDA does not match its contents.');
  return {
    address,
    vault: new PublicKey(info.data.subarray(73, 105)),
    amount: info.data.readBigUInt64LE(105),
    unlockAt: Number(info.data.readBigInt64LE(121)),
    claimedAt: Number(info.data.readBigInt64LE(129)),
    released: info.data[145] === 1,
  };
};

const sendInstructions = async (
  connection: Connection,
  session: WalletTransactionSession,
  instructions: TransactionInstruction[],
): Promise<string> => {
  const payer = new PublicKey(session.account.address);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const wire = transaction.serialize();
  const sendFeature = session.wallet.features[SolanaSignAndSendTransaction] as
    | SolanaSignAndSendTransactionFeature[typeof SolanaSignAndSendTransaction]
    | undefined;
  let signature: string;

  if (sendFeature && session.account.features.includes(SolanaSignAndSendTransaction)) {
    const output = (await sendFeature.signAndSendTransaction({
      account: session.account,
      transaction: wire,
      chain: session.chain,
      options: { commitment: 'confirmed', skipPreflight: false, maxRetries: 3 },
    }))[0];
    if (!output) throw new Error('Wallet returned no transaction signature.');
    signature = bs58.encode(output.signature);
  } else {
    const signFeature = session.wallet.features[SolanaSignTransaction] as
      | SolanaSignTransactionFeature[typeof SolanaSignTransaction]
      | undefined;
    if (!signFeature || !session.account.features.includes(SolanaSignTransaction)) {
      throw new Error('This wallet cannot sign a Solana transaction through Wallet Standard.');
    }
    const output = (await signFeature.signTransaction({
      account: session.account,
      transaction: wire,
      chain: session.chain,
    }))[0];
    if (!output) throw new Error('Wallet returned no signed transaction.');
    signature = await connection.sendRawTransaction(output.signedTransaction, {
      skipPreflight: false,
      maxRetries: 3,
    });
  }

  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'finalized');
  if (confirmation.value.err) throw new Error(`Stake transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
};

const setStatus = (ui: Ui, message: string, state: 'idle' | 'busy' | 'good' | 'bad' = 'idle'): void => {
  ui.status.className = `matrix-stake-status matrix-stake-status--${state}`;
  ui.status.textContent = message;
};

export async function mountMatrixAccessStake(
  getCanonicalMint: () => string | null,
  walletController: WalletIdentityController,
): Promise<void> {
  const response = await fetch('/wallet-policy.json', { cache: 'no-store' });
  if (!response.ok) return;
  const walletPolicy = await response.json() as WalletPolicy;
  const ui: Ui = {
    panel: required('matrix-stake-access'),
    terms: required('matrix-stake-terms'),
    status: required('matrix-stake-status'),
    walletButton: required('matrix-stake-wallet'),
    stakeButton: required('matrix-stake-submit'),
    claimButton: required('matrix-stake-claim'),
    releaseButton: required('matrix-stake-release'),
    manualTokenButton: required('matrix-stake-manual-token'),
    createButton: required('matrix-create'),
    domainInput: required('matrix-create-domain'),
    tokenField: required('matrix-token-field'),
    tokenInput: required('matrix-create-token'),
  };
  const advertisedPolicy = walletPolicy.accessStake;
  if (!advertisedPolicy) return;
  let manualTokenMode = false;
  let registrationBlockLabel = 'GET ACCOUNT ACCESS FIRST';

  const isNealProvider = (): boolean =>
    ui.domainInput.value.trim().toLowerCase() === NEAL_SERVER;
  const syncRegistrationGate = (): void => {
    if (!isNealProvider()) {
      manualTokenMode = false;
      ui.manualTokenButton.hidden = true;
      return;
    }
    const accessReady = Boolean(ui.tokenInput.value.trim());
    ui.tokenField.hidden = !manualTokenMode;
    ui.tokenInput.required = manualTokenMode;
    ui.manualTokenButton.hidden = manualTokenMode || accessReady;
    ui.createButton.disabled = !accessReady;
    ui.createButton.textContent = accessReady
      ? 'CREATE EMAIL-FREE MATRIX ACCOUNT'
      : manualTokenMode
        ? 'ENTER YOUR ONE-USE TOKEN'
        : registrationBlockLabel;
  };

  ui.manualTokenButton.addEventListener('click', () => {
    manualTokenMode = true;
    syncRegistrationGate();
    ui.tokenInput.focus();
  });
  ui.tokenInput.addEventListener('input', syncRegistrationGate);

  const hideTransactionActions = (): void => {
    ui.walletButton.hidden = true;
    ui.stakeButton.hidden = true;
    ui.claimButton.hidden = true;
    ui.releaseButton.hidden = true;
  };
  const renderUnavailable = (): void => {
    const isNeal = isNealProvider();
    ui.panel.hidden = !isNeal;
    hideTransactionActions();
    if (!isNeal) {
      syncRegistrationGate();
      return;
    }
    if (advertisedPolicy.status === 'planned') {
      registrationBlockLabel = 'STAKING ACCESS NOT LIVE YET';
      ui.terms.textContent = 'REFUNDABLE NEAL STAKE · TERMS PUBLISH BEFORE ACTIVATION';
      setStatus(ui, 'Stake access is not live yet. NEAL account creation will unlock here after activation.');
      syncRegistrationGate();
      return;
    }
    registrationBlockLabel = advertisedPolicy.status === 'paused'
      ? 'ACCOUNT ACCESS PAUSED'
      : 'ACCOUNT ACCESS UNAVAILABLE';
    ui.terms.textContent = 'STAKE ACCESS UNAVAILABLE';
    setStatus(ui, 'The published staking configuration did not pass browser verification. No transaction can be built.', 'bad');
    syncRegistrationGate();
  };

  const policy = parseConfiguredPolicy(walletPolicy, getCanonicalMint());
  if (!policy) {
    ui.domainInput.addEventListener('input', renderUnavailable);
    renderUnavailable();
    return;
  }

  const program = new PublicKey(policy.programId);
  const configAddress = new PublicKey(policy.configAddress);
  const mint = new PublicKey(policy.mint);
  const requiredAmount = BigInt(policy.requiredAtomicAmount);
  const connection = new Connection(walletPolicy.holderProof.rpcEndpoint, 'finalized');
  let receipt: ReceiptState | null = null;
  let rendering = false;
  let accessPaused = policy.status === 'paused';

  const assertConfig = async (allowPaused = false): Promise<ConfigState> => {
    const state = await readConfig(connection, program, configAddress);
    if (
      !state.mint.equals(mint)
      || !state.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      || state.requiredAmount !== requiredAmount
      || state.minimumLockSeconds !== policy.minimumLockSeconds
    ) throw new Error('Published stake terms do not match the finalized on-chain config.');
    if (!allowPaused && (policy.status === 'paused' || state.paused)) {
      throw new Error('New access staking is paused. Existing unlocked stakes can still be released.');
    }
    return state;
  };

  const render = async (): Promise<void> => {
    if (rendering) return;
    rendering = true;
    const isNeal = isNealProvider();
    ui.panel.hidden = !isNeal;
    if (!isNeal) {
      syncRegistrationGate();
      rendering = false;
      return;
    }
    registrationBlockLabel = accessPaused ? 'ACCOUNT ACCESS PAUSED' : 'COMPLETE STAKE ACCESS FIRST';
    syncRegistrationGate();
    ui.terms.textContent = `STAKE ${formatAtomic(requiredAmount, policy.tokenDecimals)} NEAL · REFUNDABLE AFTER ${formatDuration(policy.minimumLockSeconds)}`;
    const authentication = walletController.getAuthenticationState();
    ui.walletButton.hidden = authentication.serverVerified;
    ui.walletButton.textContent = authentication.connected ? 'VERIFY WALLET' : 'CONNECT WALLET';
    ui.stakeButton.hidden = true;
    ui.claimButton.hidden = true;
    ui.releaseButton.hidden = true;
    if (!authentication.address) {
      receipt = null;
      ui.walletButton.hidden = false;
      ui.walletButton.textContent = 'CONNECT WALLET';
      registrationBlockLabel = accessPaused ? 'ACCOUNT ACCESS PAUSED' : 'CONNECT WALLET TO CONTINUE';
      setStatus(
        ui,
        accessPaused
          ? 'New staking and token claims are paused. Connect only to check or recover an existing stake.'
          : 'Connect the wallet that will own and recover the stake.',
      );
      syncRegistrationGate();
      rendering = false;
      return;
    }
    try {
      const configState = await assertConfig(true);
      accessPaused = policy.status === 'paused' || configState.paused;
      ui.walletButton.hidden = accessPaused ? authentication.connected : authentication.serverVerified;
      ui.walletButton.textContent = accessPaused ? 'CONNECT WALLET' : 'VERIFY WALLET';
      receipt = await readReceipt(connection, program, configAddress, new PublicKey(authentication.address));
      if (!authentication.serverVerified && !accessPaused) {
        registrationBlockLabel = 'VERIFY WALLET TO CONTINUE';
        setStatus(ui, 'Verify this wallet with the server-issued message before staking.');
      } else if (!receipt) {
        if (accessPaused) {
          registrationBlockLabel = 'ACCOUNT ACCESS PAUSED';
          setStatus(ui, 'New staking and token claims are paused. No active stake receipt was found for this wallet.');
        } else {
          registrationBlockLabel = 'STAKE NEAL TO CONTINUE';
          ui.stakeButton.hidden = false;
          setStatus(ui, 'No receipt exists for this wallet. Review the terms, then stake.', 'idle');
        }
      } else if (receipt.released) {
        registrationBlockLabel = 'RECEIPT ALREADY USED';
        setStatus(ui, 'This wallet already used and released its receipt. A receipt cannot be reused.', 'bad');
      } else {
        ui.claimButton.hidden = accessPaused || Boolean(ui.tokenInput.value);
        ui.claimButton.textContent = receipt.claimedAt > 0 ? 'GET ACCESS TOKEN' : 'CLAIM ACCESS TOKEN';
        ui.releaseButton.hidden = false;
        const secondsLeft = Math.max(0, receipt.unlockAt - Math.floor(Date.now() / 1000));
        ui.releaseButton.disabled = secondsLeft > 0;
        ui.releaseButton.textContent = secondsLeft > 0
          ? `UNSTAKE IN ${formatDuration(secondsLeft)}`
          : 'UNSTAKE NEAL';
        setStatus(
          ui,
          accessPaused
            ? 'New token claims are paused. This stake can still be refunded when its displayed lock ends.'
            : ui.tokenInput.value
              ? 'One-use access token ready. Choose a username and password to create the account.'
              : receipt.claimedAt > 0
                ? 'Finalized claim found. Request its one-use access token.'
                : 'Stake finalized. Claim once to request the one-use access token.',
          ui.tokenInput.value ? 'good' : 'idle',
        );
        registrationBlockLabel = accessPaused ? 'ACCOUNT ACCESS PAUSED' : 'CLAIM ACCESS TOKEN FIRST';
      }
    } catch (error) {
      registrationBlockLabel = 'ACCOUNT ACCESS UNAVAILABLE';
      setStatus(ui, error instanceof Error ? error.message : 'Could not read the finalized stake state.', 'bad');
    } finally {
      syncRegistrationGate();
      rendering = false;
    }
  };

  ui.walletButton.addEventListener('click', () => {
    void (async () => {
      if (accessPaused && !walletController.getAuthenticationState().connected) {
        walletController.openWalletPicker();
        return;
      }
      ui.walletButton.disabled = true;
      setStatus(ui, 'Waiting for wallet verification…', 'busy');
      try {
        await walletController.authenticateForAccess();
      } finally {
        ui.walletButton.disabled = false;
        await render();
      }
    })();
  });

  ui.stakeButton.addEventListener('click', () => {
    void (async () => {
      const session = walletController.getTransactionSession();
      if (!session || !walletController.getAuthenticationState().serverVerified) {
        setStatus(ui, 'Connect and server-verify the staking wallet first.', 'bad');
        return;
      }
      ui.stakeButton.disabled = true;
      setStatus(ui, 'Checking finalized terms and preparing the refundable stake…', 'busy');
      try {
        await assertConfig();
        const staker = new PublicKey(session.account.address);
        const receiptKey = receiptAddress(program, configAddress, staker);
        const sourceAccounts = await connection.getParsedTokenAccountsByOwner(staker, { mint }, 'finalized');
        const source = sourceAccounts.value.find(({ account }) => {
          const amount = account.data.parsed.info.tokenAmount.amount as string;
          return BigInt(amount) >= requiredAmount;
        })?.pubkey;
        if (!source) throw new Error(`This wallet needs at least ${formatAtomic(requiredAmount, policy.tokenDecimals)} NEAL in one token account.`);
        const vault = getAssociatedTokenAddressSync(mint, receiptKey, true, TOKEN_2022_PROGRAM_ID);
        const createVault = createAssociatedTokenAccountIdempotentInstruction(
          staker,
          vault,
          receiptKey,
          mint,
          TOKEN_2022_PROGRAM_ID,
        );
        const stake = new TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: staker, isSigner: true, isWritable: true },
            { pubkey: configAddress, isSigner: false, isWritable: false },
            { pubkey: receiptKey, isSigner: false, isWritable: true },
            { pubkey: source, isSigner: false, isWritable: true },
            { pubkey: vault, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([2, policy.tokenDecimals]),
        });
        await sendInstructions(connection, session, [createVault, stake]);
        setStatus(ui, 'Stake finalized. The receipt is ready to claim.', 'good');
      } catch (error) {
        setStatus(ui, error instanceof Error ? error.message : 'Stake transaction failed.', 'bad');
      } finally {
        ui.stakeButton.disabled = false;
        await render();
      }
    })();
  });

  ui.claimButton.addEventListener('click', () => {
    void (async () => {
      if (policy.status !== 'active' || !policy.tokenEndpoint) {
        setStatus(ui, 'New access-token claims are paused. Existing unlocked stakes can still be released.', 'bad');
        return;
      }
      const session = walletController.getTransactionSession();
      if (!session || !walletController.getAuthenticationState().serverVerified) {
        setStatus(ui, 'Connect and server-verify the staking wallet first.', 'bad');
        return;
      }
      ui.claimButton.disabled = true;
      try {
        await assertConfig();
        const staker = new PublicKey(session.account.address);
        receipt = await readReceipt(connection, program, configAddress, staker);
        if (!receipt || receipt.released) throw new Error('No active stake receipt is available.');
        if (receipt.claimedAt === 0) {
          setStatus(ui, 'Writing the one-time claim to Solana and waiting for finality…', 'busy');
          const claim = new TransactionInstruction({
            programId: program,
            keys: [
              { pubkey: staker, isSigner: true, isWritable: false },
              { pubkey: configAddress, isSigner: false, isWritable: false },
              { pubkey: receipt.address, isSigner: false, isWritable: true },
              { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            ],
            data: Buffer.from([3]),
          });
          await sendInstructions(connection, session, [claim]);
        }
        setStatus(ui, 'Finalized claim found. Creating one short-lived registration token…', 'busy');
        const tokenResponse = await fetch(policy.tokenEndpoint, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schema: 'neal.matrix-access-token-request/v1' }),
        });
        const body = await tokenResponse.json() as { token?: unknown; error?: unknown };
        if (!tokenResponse.ok || typeof body.token !== 'string' || !body.token) {
          throw new Error(typeof body.error === 'string' ? body.error : 'The access-token issuer rejected this receipt.');
        }
        ui.tokenInput.value = body.token;
        ui.tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
        setStatus(ui, 'One-use access token ready. Choose a username and password to create the account.', 'good');
      } catch (error) {
        setStatus(ui, error instanceof Error ? error.message : 'Access-token claim failed.', 'bad');
      } finally {
        ui.claimButton.disabled = false;
        await render();
      }
    })();
  });

  ui.releaseButton.addEventListener('click', () => {
    void (async () => {
      const session = walletController.getTransactionSession();
      if (!session) return;
      ui.releaseButton.disabled = true;
      setStatus(ui, 'Preparing the full stake refund…', 'busy');
      try {
        const staker = new PublicKey(session.account.address);
        receipt = await readReceipt(connection, program, configAddress, staker);
        if (!receipt || receipt.released) throw new Error('No active stake is available to release.');
        if (Math.floor(Date.now() / 1000) < receipt.unlockAt) throw new Error('The minimum lock has not ended yet.');
        const destination = getAssociatedTokenAddressSync(mint, staker, false, TOKEN_2022_PROGRAM_ID);
        const createDestination = createAssociatedTokenAccountIdempotentInstruction(
          staker,
          destination,
          staker,
          mint,
          TOKEN_2022_PROGRAM_ID,
        );
        const unstake = new TransactionInstruction({
          programId: program,
          keys: [
            { pubkey: staker, isSigner: true, isWritable: false },
            { pubkey: configAddress, isSigner: false, isWritable: false },
            { pubkey: receipt.address, isSigner: false, isWritable: true },
            { pubkey: receipt.vault, isSigner: false, isWritable: true },
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
          ],
          data: Buffer.from([4, policy.tokenDecimals]),
        });
        await sendInstructions(connection, session, [createDestination, unstake]);
        setStatus(ui, 'Stake refund finalized.', 'good');
      } catch (error) {
        setStatus(ui, error instanceof Error ? error.message : 'Stake refund failed.', 'bad');
      } finally {
        await render();
      }
    })();
  });

  ui.domainInput.addEventListener('input', () => void render());
  document.addEventListener('neal:wallet-session-change', () => void render());
  await render();
}
