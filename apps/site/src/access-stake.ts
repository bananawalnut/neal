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
import { getRuntimeConfig } from './runtime-config';

const CONFIG_DISCRIMINATOR = 'NEALACFG';
const STAKE_DISCRIMINATOR = 'NEALSTAK';
const NEAL_SERVER = getRuntimeConfig()?.matrix.serverName ?? 'matrix.nealtheseal.org';
const MANUAL_BROWSER_WALLET = getRuntimeConfig()?.browserWallet ?? null;
const UPGRADEABLE_LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const ACCESS_OPERATION_KEY = 'neal.matrix-access-operation.v2';

type AccessOperation = {
  schema: 'neal.matrix-access-operation-tab/v1';
  endpoint: string;
  operationId: string;
  receipt: string;
};

const saveAccessOperation = (value: AccessOperation): void => {
  sessionStorage.setItem(ACCESS_OPERATION_KEY, JSON.stringify(value));
};

const readAccessOperation = (): AccessOperation | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(ACCESS_OPERATION_KEY) ?? 'null') as Partial<AccessOperation> | null;
    if (
      value?.schema !== 'neal.matrix-access-operation-tab/v1'
      || typeof value.endpoint !== 'string'
      || typeof value.operationId !== 'string'
      || typeof value.receipt !== 'string'
    ) return null;
    return value as AccessOperation;
  } catch {
    return null;
  }
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const registrationStageEndpoint = (endpoint: string): string => {
  const url = new URL(endpoint, window.location.origin);
  url.pathname = url.pathname.replace(/\/v2\/access-token$/u, '/v2/registration-stage');
  if (!url.pathname.endsWith('/v2/registration-stage')) throw new Error('Invalid account-access endpoint.');
  url.search = '';
  url.hash = '';
  return url.toString();
};

const reportRegistrationStage = async (stage: 'registration_in_progress' | 'registration_completed'): Promise<void> => {
  const operation = readAccessOperation();
  if (!operation) return;
  const response = await fetch(registrationStageEndpoint(operation.endpoint), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema: 'neal.matrix-registration-stage/v2',
      operationId: operation.operationId,
      stage,
    }),
  });
  if (!response.ok && response.status !== 409) return;
  if (stage === 'registration_completed') sessionStorage.removeItem(ACCESS_OPERATION_KEY);
};

type AccessStakePolicy = {
  status: 'planned' | 'active' | 'paused';
  contractVersion: 2;
  programId: string | null;
  programDataAddress: string | null;
  programSha256: string | null;
  configAddress: string | null;
  configRevision: string | null;
  issuerAuthority: string | null;
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
  verification: { mode: 'single-rpc-devnet-preview' | 'quorum-2-of-3'; providerCount: number; threshold: number };
  holderProof: { rpcEndpoint: string; commitment: 'confirmed' | 'finalized' };
  accessStake?: AccessStakePolicy;
};

type ConfiguredPolicy = AccessStakePolicy & {
  status: 'active' | 'paused';
  programId: string;
  programDataAddress: string;
  programSha256: string;
  configAddress: string;
  configRevision: string;
  issuerAuthority: string;
  requiredAtomicAmount: string;
  minimumLockSeconds: number;
};

type TokenOperationResponse = {
  schema?: unknown;
  state?: unknown;
  operationId?: unknown;
  receipt?: unknown;
  token?: unknown;
  expiresAt?: unknown;
  retryAfterMs?: unknown;
  code?: unknown;
  message?: unknown;
};

type ConfigState = {
  issuerAuthority: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  revision: bigint;
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
  issuedAt: number;
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

const validPublicKey = (value: string | null): boolean => {
  if (!value) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
};

const assertExpectedWallet = (address: string): void => {
  if (MANUAL_BROWSER_WALLET && address !== MANUAL_BROWSER_WALLET) {
    throw new Error(`Wrong devnet wallet. Connect ${MANUAL_BROWSER_WALLET.slice(0, 6)}…${MANUAL_BROWSER_WALLET.slice(-6)} to continue.`);
  }
};

const parseConfiguredPolicy = (walletPolicy: WalletPolicy, canonicalMint: string | null): ConfiguredPolicy | null => {
  const policy = walletPolicy.accessStake;
  if (!policy || policy.status === 'planned') return null;
  try {
    if (
      !['active', 'paused'].includes(policy.status)
      || walletPolicy.verification?.mode !== 'quorum-2-of-3'
      || walletPolicy.verification?.providerCount !== 3
      || walletPolicy.verification?.threshold !== 2
      || policy.contractVersion !== 2
      || !validPublicKey(policy.programId)
      || !validPublicKey(policy.programDataAddress)
      || !policy.programSha256
      || !validPublicKey(policy.configAddress)
      || policy.configRevision === null
      || !validPublicKey(policy.issuerAuthority)
      || !policy.requiredAtomicAmount
      || policy.minimumLockSeconds === null
      || !Number.isSafeInteger(policy.minimumLockSeconds)
      || policy.minimumLockSeconds <= 0
      || policy.minimumLockSeconds > 365 * 24 * 60 * 60
      || policy.tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()
      || policy.tokenDecimals !== 6
      || canonicalMint !== policy.mint
      || BigInt(policy.requiredAtomicAmount) <= 0n
      || BigInt(policy.configRevision) < 0n
      || !/^[0-9a-f]{64}$/u.test(policy.programSha256)
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

const formatPlannedTerms = (policy: AccessStakePolicy): string | null => {
  try {
    if (
      policy.requiredAtomicAmount === null
      || policy.minimumLockSeconds === null
      || !Number.isSafeInteger(policy.minimumLockSeconds)
      || policy.minimumLockSeconds <= 0
    ) return null;
    const amount = BigInt(policy.requiredAtomicAmount);
    if (amount <= 0n) return null;
    return `${formatAtomic(amount, policy.tokenDecimals)} NEAL · ${formatDuration(policy.minimumLockSeconds)} MINIMUM LOCK · NOT LIVE`;
  } catch {
    return null;
  }
};

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const discriminator = (data: Buffer, expected: string): boolean =>
  new TextDecoder().decode(data.subarray(0, 8)) === expected;

const attestProgram = async (
  connection: Connection,
  program: PublicKey,
  programDataAddress: PublicKey,
  expectedHash: string,
): Promise<void> => {
  const [programInfo, programDataInfo] = await Promise.all([
    connection.getAccountInfo(program, 'finalized'),
    connection.getAccountInfo(programDataAddress, 'finalized'),
  ]);
  if (
    !programInfo?.executable
    || !programInfo.owner.equals(UPGRADEABLE_LOADER_ID)
    || programInfo.data.length < 36
    || programInfo.data.readUInt32LE(0) !== 2
    || !new PublicKey(programInfo.data.subarray(4, 36)).equals(programDataAddress)
  ) throw new Error('The access-stake program does not match its reviewed ProgramData account.');
  if (
    !programDataInfo
    || !programDataInfo.owner.equals(UPGRADEABLE_LOADER_ID)
    || programDataInfo.data.length <= 45
    || programDataInfo.data.readUInt32LE(0) !== 3
    || programDataInfo.data[12] !== 0
  ) throw new Error('The access-stake program is missing, invalid, or still upgradeable.');
  const programBytes = new Uint8Array(programDataInfo.data.length - 45);
  programBytes.set(programDataInfo.data.subarray(45));
  const digest = await crypto.subtle.digest('SHA-256', programBytes.buffer);
  const actualHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actualHash !== expectedHash) throw new Error('The deployed access-stake program bytes do not match the reviewed release.');
};

const readConfig = async (
  connection: Connection,
  program: PublicKey,
  configAddress: PublicKey,
): Promise<ConfigState> => {
  const info = await connection.getAccountInfo(configAddress, 'finalized');
  if (!info || !info.owner.equals(program) || info.data.length !== 171 || !discriminator(info.data, CONFIG_DISCRIMINATOR) || info.data[8] !== 2) {
    throw new Error('The finalized access-stake config is invalid.');
  }
  const authority = new PublicKey(info.data.subarray(9, 41));
  const configId = info.data.subarray(73, 81);
  const bump = info.data[170];
  const expected = PublicKey.createProgramAddressSync(
    [new TextEncoder().encode('access-config'), authority.toBytes(), configId, Uint8Array.of(bump)],
    program,
  );
  if (!expected.equals(configAddress)) throw new Error('The access-stake config PDA does not match its contents.');
  return {
    issuerAuthority: new PublicKey(info.data.subarray(41, 73)),
    mint: new PublicKey(info.data.subarray(81, 113)),
    tokenProgram: new PublicKey(info.data.subarray(113, 145)),
    revision: info.data.readBigUInt64LE(145),
    requiredAmount: info.data.readBigUInt64LE(153),
    minimumLockSeconds: Number(info.data.readBigInt64LE(161)),
    paused: info.data[169] !== 0,
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
  if (!info.owner.equals(program) || info.data.length !== 163 || !discriminator(info.data, STAKE_DISCRIMINATOR) || info.data[8] !== 2) {
    throw new Error('The finalized access-stake receipt is invalid.');
  }
  if (
    !bytesEqual(info.data.subarray(9, 41), config.toBytes())
    || !bytesEqual(info.data.subarray(41, 73), staker.toBytes())
  ) throw new Error('The access-stake receipt belongs to a different wallet or config.');
  const bump = info.data[162];
  const expected = PublicKey.createProgramAddressSync(
    [new TextEncoder().encode('access-stake'), config.toBytes(), staker.toBytes(), Uint8Array.of(bump)],
    program,
  );
  if (!expected.equals(address)) throw new Error('The access-stake receipt PDA does not match its contents.');
  return {
    address,
    vault: new PublicKey(info.data.subarray(73, 105)),
    amount: info.data.readBigUInt64LE(105),
    unlockAt: Number(info.data.readBigInt64LE(129)),
    claimedAt: Number(info.data.readBigInt64LE(137)),
    issuedAt: Number(info.data.readBigInt64LE(145)),
    released: info.data[161] === 1,
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
      ui.manualTokenButton.textContent = 'USE AN EXISTING TOKEN';
      ui.manualTokenButton.setAttribute('aria-expanded', 'false');
      return;
    }
    const accessReady = Boolean(ui.tokenInput.value.trim());
    ui.tokenField.hidden = !manualTokenMode;
    ui.tokenInput.required = manualTokenMode;
    ui.manualTokenButton.hidden = !manualTokenMode && accessReady;
    ui.manualTokenButton.textContent = manualTokenMode
      ? 'BACK TO STAKE ACCESS'
      : 'USE AN EXISTING TOKEN';
    ui.manualTokenButton.setAttribute('aria-expanded', String(manualTokenMode));
    ui.createButton.disabled = !accessReady;
    ui.createButton.textContent = accessReady
      ? 'CREATE EMAIL-FREE MATRIX ACCOUNT'
      : manualTokenMode
        ? 'ENTER YOUR ONE-USE TOKEN'
        : registrationBlockLabel;
  };

  ui.manualTokenButton.addEventListener('click', () => {
    if (manualTokenMode) {
      manualTokenMode = false;
      ui.tokenInput.value = '';
      syncRegistrationGate();
      ui.manualTokenButton.focus();
      return;
    }
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
      const plannedTerms = formatPlannedTerms(advertisedPolicy);
      registrationBlockLabel = 'STAKING ACCESS NOT LIVE YET';
      ui.terms.textContent = plannedTerms ?? 'REFUNDABLE NEAL STAKE · TERMS PUBLISH BEFORE ACTIVATION';
      setStatus(
        ui,
        plannedTerms
          ? 'Stake terms are approved, but access is not live until the reviewed program and issuer are deployed.'
          : 'Stake access is not live yet. NEAL account creation will unlock here after activation.',
      );
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
  const programDataAddress = new PublicKey(policy.programDataAddress);
  const configAddress = new PublicKey(policy.configAddress);
  const mint = new PublicKey(policy.mint);
  const requiredAmount = BigInt(policy.requiredAtomicAmount);
  const connection = new Connection(walletPolicy.holderProof.rpcEndpoint, 'finalized');
  let receipt: ReceiptState | null = null;
  let rendering = false;
  let accessPaused = policy.status === 'paused';
  let programAttested = false;

  const assertConfig = async (allowPaused = false): Promise<ConfigState> => {
    if (!programAttested) {
      await attestProgram(connection, program, programDataAddress, policy.programSha256);
      programAttested = true;
    }
    const state = await readConfig(connection, program, configAddress);
    if (
      !state.mint.equals(mint)
      || !state.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      || !state.issuerAuthority.equals(new PublicKey(policy.issuerAuthority))
      || state.revision !== BigInt(policy.configRevision)
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
    if (MANUAL_BROWSER_WALLET && authentication.address !== MANUAL_BROWSER_WALLET) {
      receipt = null;
      ui.walletButton.hidden = false;
      ui.walletButton.textContent = 'SELECT TEST WALLET';
      registrationBlockLabel = 'WRONG DEVNET WALLET';
      setStatus(
        ui,
        `Wrong devnet wallet. Connect ${MANUAL_BROWSER_WALLET.slice(0, 6)}…${MANUAL_BROWSER_WALLET.slice(-6)}. No transaction was constructed.`,
        'bad',
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
      const authentication = walletController.getAuthenticationState();
      if (MANUAL_BROWSER_WALLET && authentication.address && authentication.address !== MANUAL_BROWSER_WALLET) {
        walletController.openWalletPicker();
        return;
      }
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
        const configState = await assertConfig();
        const staker = new PublicKey(session.account.address);
        assertExpectedWallet(staker.toBase58());
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
        const stakeData = Buffer.alloc(26);
        stakeData[0] = 3;
        stakeData[1] = policy.tokenDecimals;
        stakeData.writeBigUInt64LE(configState.requiredAmount, 2);
        stakeData.writeBigInt64LE(BigInt(configState.minimumLockSeconds), 10);
        stakeData.writeBigUInt64LE(configState.revision, 18);
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
          data: stakeData,
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
        assertExpectedWallet(staker.toBase58());
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
            data: Buffer.from([4]),
          });
          await sendInstructions(connection, session, [claim]);
        }
        setStatus(ui, 'Finalized claim found. Recovering the registration operation…', 'busy');
        let ready: TokenOperationResponse | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const tokenResponse = await fetch(policy.tokenEndpoint, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ schema: 'neal.matrix-access-token-request/v2' }),
          });
          const body = await tokenResponse.json() as TokenOperationResponse;
          if (tokenResponse.status === 401) {
            walletController.invalidateServerAuthentication();
            throw new Error('Wallet session expired. Verify the wallet again; the stake will not be repeated.');
          }
          if (
            tokenResponse.status === 202
            && body.state === 'processing'
            && typeof body.operationId === 'string'
            && typeof body.receipt === 'string'
          ) {
            saveAccessOperation({
              schema: 'neal.matrix-access-operation-tab/v1',
              endpoint: policy.tokenEndpoint,
              operationId: body.operationId,
              receipt: body.receipt,
            });
            const headerSeconds = Number(tokenResponse.headers.get('Retry-After'));
            const bodyDelay = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 2_000;
            const wait = Number.isFinite(headerSeconds) && headerSeconds > 0
              ? headerSeconds * 1_000
              : bodyDelay;
            setStatus(ui, 'The claim is safely processing. Waiting for finalized recovery…', 'busy');
            await delay(Math.min(8_000, Math.max(500, wait * 2 ** Math.min(attempt, 2))));
            continue;
          }
          if (
            tokenResponse.ok
            && body.state === 'token_ready'
            && typeof body.token === 'string'
            && body.token
            && typeof body.operationId === 'string'
            && typeof body.receipt === 'string'
          ) {
            saveAccessOperation({
              schema: 'neal.matrix-access-operation-tab/v1',
              endpoint: policy.tokenEndpoint,
              operationId: body.operationId,
              receipt: body.receipt,
            });
            ready = body;
            break;
          }
          throw new Error(typeof body.message === 'string' ? body.message : 'The access-token issuer rejected this receipt.');
        }
        if (!ready || typeof ready.token !== 'string') {
          throw new Error('The claim is still processing. Use GET ACCESS TOKEN again; the stake will not be repeated.');
        }
        ui.tokenInput.value = ready.token;
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
        assertExpectedWallet(staker.toBase58());
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
          data: Buffer.from([6, policy.tokenDecimals]),
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
  document.addEventListener('neal:matrix-registration-stage', (event) => {
    const stage = (event as CustomEvent<{ stage?: unknown }>).detail?.stage;
    if (stage === 'registration_in_progress' || stage === 'registration_completed') {
      void reportRegistrationStage(stage);
    }
  });
  await render();
}
