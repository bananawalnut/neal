import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features';
import {
  SolanaSignAndSendTransaction,
  SolanaSignIn,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignInFeature,
  type SolanaSignInInput,
  type SolanaSignInOutput,
  type SolanaSignMessageFeature,
  type SolanaSignMessageOutput,
} from '@solana/wallet-standard-features';
import { createSignInMessage, verifySignIn, verifySignMessage } from '@solana/wallet-standard-util';
import { manualRequestHeaders } from './runtime-config';

type WalletPolicy = {
  schema: 'neal.wallet-policy/v1';
  chain: 'solana:mainnet' | 'solana:devnet';
  preferredWallets: readonly string[];
  identity: {
    subjectFormat: string;
    sessionStorage: 'memory-only';
    nonceTtlSeconds: number;
    statement: string;
    challengeEndpoint: string | null;
    verifyEndpoint: string | null;
  };
  holderProof: {
    rpcEndpoint: string;
    commitment: 'confirmed' | 'finalized';
    minimumAtomicBalance: string;
  };
  accessStake?: {
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
};

type WalletProof = {
  schema: 'neal.wallet-proof/v1';
  subject: string;
  address: string;
  chain: 'solana:mainnet' | 'solana:devnet';
  wallet: string;
  method: 'solana:signIn' | 'solana:signMessage';
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  signedMessage: string;
  signature: string;
  publicKey: string;
  digest: string;
  verification: 'local' | 'server';
  serverSessionExpiresAt: number | null;
};

type HolderProof = {
  schema: 'neal.holder-proof/v1';
  subject: string;
  address: string;
  chain: 'solana:mainnet' | 'solana:devnet';
  mint: string;
  amountAtomic: string;
  decimals: number;
  slot: number;
  commitment: 'confirmed' | 'finalized';
  observedAt: string;
  holder: boolean;
  walletProofDigest: string;
};

export type WalletTransactionSession = {
  wallet: Wallet;
  account: WalletAccount;
  rpcEndpoint: string;
  chain: 'solana:mainnet' | 'solana:devnet';
};

export type WalletAuthenticationState = {
  connected: boolean;
  address: string | null;
  serverVerified: boolean;
};

type SignOutput = SolanaSignInOutput | (SolanaSignMessageOutput & { account: WalletAccount });

type RpcEnvelope<T> = {
  jsonrpc: '2.0';
  result?: T;
  error?: { code: number; message: string };
};

type TokenSupplyResult = {
  context: { slot: number };
  value: { amount: string; decimals: number };
};

type TokenAccountsResult = {
  context: { slot: number };
  value: Array<{
    account: {
      data: {
        parsed?: {
          info?: {
            tokenAmount?: { amount?: string };
          };
        };
      };
    };
  }>;
};

const requireElement = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const randomHex = (length = 16): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const digestProof = async (message: Uint8Array, signature: Uint8Array): Promise<string> => {
  const joined = new Uint8Array(message.length + signature.length);
  joined.set(message);
  joined.set(signature, message.length);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)));
};

const shortAddress = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`;

const formatAtomic = (amount: bigint, decimals: number): string => {
  if (decimals === 0) return amount.toString();
  const raw = amount.toString().padStart(decimals + 1, '0');
  const whole = raw.slice(0, -decimals);
  const fraction = raw.slice(-decimals).replace(/0+$/u, '').slice(0, 6);
  return fraction ? `${whole}.${fraction}` : whole;
};

const isCastalia = (wallet: Wallet): boolean => wallet.name.toLowerCase().includes('castalia');

const hasChain = (account: WalletAccount, chain: string): boolean => account.chains.some((value) => value === chain);

const hasAccountFeature = (account: WalletAccount, feature: string): boolean =>
  account.features.some((value) => value === feature);

const featureVersion = (wallet: Wallet, feature: `${string}:${string}`): string | null => {
  const candidate = wallet.features[feature] as { version?: unknown } | undefined;
  return typeof candidate?.version === 'string' ? candidate.version : null;
};

export class WalletIdentityController {
  readonly #policy: WalletPolicy;
  readonly #getCanonicalMint: () => string | null;
  readonly #registry = getWallets();
  #wallet: Wallet | null = null;
  #account: WalletAccount | null = null;
  #walletProof: WalletProof | null = null;
  #holderProof: HolderProof | null = null;
  #removeWalletListener: (() => void) | null = null;

  readonly #dialog = requireElement<HTMLDialogElement>('wallet-dialog');
  readonly #walletList = requireElement<HTMLElement>('wallet-list');
  readonly #topButton = requireElement<HTMLButtonElement>('wallet-button');
  readonly #panelButton = requireElement<HTMLButtonElement>('wallet-connect');
  readonly #verifyButton = requireElement<HTMLButtonElement>('wallet-verify');
  readonly #holderButton = requireElement<HTMLButtonElement>('wallet-holder-check');
  readonly #disconnectButton = requireElement<HTMLButtonElement>('wallet-disconnect');
  readonly #copyProofButton = requireElement<HTMLButtonElement>('wallet-copy-proof');
  readonly #closeDialogButton = requireElement<HTMLButtonElement>('wallet-dialog-close');
  readonly #status = requireElement<HTMLElement>('wallet-status');
  readonly #provider = requireElement<HTMLElement>('wallet-provider');
  readonly #address = requireElement<HTMLElement>('wallet-address');
  readonly #auth = requireElement<HTMLElement>('wallet-auth-state');
  readonly #balance = requireElement<HTMLElement>('wallet-balance');
  readonly #slot = requireElement<HTMLElement>('wallet-slot');
  readonly #capabilities = requireElement<HTMLElement>('wallet-capabilities');

  constructor(policy: WalletPolicy, getCanonicalMint: () => string | null) {
    this.#policy = policy;
    this.#getCanonicalMint = getCanonicalMint;
  }

  openWalletPicker(): void {
    this.#openDialog();
  }

  getTransactionSession(): WalletTransactionSession | null {
    if (!this.#wallet || !this.#account) return null;
    return {
      wallet: this.#wallet,
      account: this.#account,
      rpcEndpoint: this.#policy.holderProof.rpcEndpoint,
      chain: this.#policy.chain,
    };
  }

  invalidateServerAuthentication(): void {
    if (this.#walletProof?.verification !== 'server') return;
    this.#clearProofs();
    this.#setStatus('Wallet session expired. Sign again to continue.', 'connected');
    this.#render();
  }

  getAuthenticationState(): WalletAuthenticationState {
    this.#expireServerProof();
    return {
      connected: Boolean(this.#wallet && this.#account),
      address: this.#account?.address ?? null,
      serverVerified: this.#walletProof?.verification === 'server',
    };
  }

  async authenticateForAccess(): Promise<boolean> {
    if (!this.#wallet || !this.#account) {
      this.#openDialog();
      return false;
    }
    this.#expireServerProof();
    if (this.#walletProof?.verification === 'server') return true;
    await this.#verifyWallet();
    return this.getAuthenticationState().serverVerified;
  }

  async start(): Promise<void> {
    this.#topButton.addEventListener('click', () => this.#openDialog());
    this.#panelButton.addEventListener('click', () => this.#openDialog());
    this.#closeDialogButton.addEventListener('click', () => this.#dialog.close());
    this.#dialog.addEventListener('click', (event) => {
      if (event.target === this.#dialog) this.#dialog.close();
    });
    this.#verifyButton.addEventListener('click', () => void this.#verifyWallet());
    this.#holderButton.addEventListener('click', () => void this.#checkHolder());
    this.#disconnectButton.addEventListener('click', () => void this.#disconnect());
    this.#copyProofButton.addEventListener('click', () => void this.#copyProof());

    this.#registry.on('register', () => this.#renderWalletList());
    this.#registry.on('unregister', () => this.#renderWalletList());
    await this.#registerMobileWalletAdapter();
    this.#renderWalletList();
    this.#render();
  }

  #wallets(): readonly Wallet[] {
    return [...this.#registry.get()]
      .filter((wallet) => wallet.chains.some((chain) => chain === this.#policy.chain))
      .filter((wallet) => Boolean(featureVersion(wallet, StandardConnect)))
      .filter((wallet) => Boolean(featureVersion(wallet, StandardEvents)))
      .sort((a, b) => {
        const preferredA = isCastalia(a) ? -1 : this.#policy.preferredWallets.indexOf(a.name);
        const preferredB = isCastalia(b) ? -1 : this.#policy.preferredWallets.indexOf(b.name);
        const rankA = preferredA < 0 ? (isCastalia(a) ? 0 : 100) : preferredA + 1;
        const rankB = preferredB < 0 ? (isCastalia(b) ? 0 : 100) : preferredB + 1;
        return rankA - rankB || a.name.localeCompare(b.name);
      });
  }

  #openDialog(): void {
    this.#renderWalletList();
    if (!this.#dialog.open) this.#dialog.showModal();
  }

  #renderWalletList(): void {
    this.#walletList.replaceChildren();
    const wallets = this.#wallets();
    if (wallets.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'wallet-empty';
      empty.textContent = 'No Wallet Standard wallet found yet. Install a Solana wallet or open this page in its browser.';
      this.#walletList.append(empty);
      return;
    }

    for (const wallet of wallets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `wallet-choice${isCastalia(wallet) ? ' castalia' : ''}`;
      const icon = document.createElement('img');
      icon.src = wallet.icon;
      icon.alt = '';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = wallet.name;
      const standard = document.createElement('small');
      standard.textContent = isCastalia(wallet) ? 'CASTALIA FIRST · WALLET STANDARD' : 'SOLANA WALLET STANDARD';
      copy.append(name, standard);
      button.append(icon, copy);
      button.addEventListener('click', () => void this.#connect(wallet));
      this.#walletList.append(button);
    }
  }

  async #connect(wallet: Wallet): Promise<void> {
    this.#setStatus(`Opening ${wallet.name}…`, 'busy');
    try {
      const feature = wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect] | undefined;
      if (!feature) throw new Error('Wallet does not advertise standard:connect');
      const output = await feature.connect({ silent: false });
      const account = output.accounts.find((candidate) => hasChain(candidate, this.#policy.chain));
      if (!account) throw new Error(`${wallet.name} did not authorize an account for ${this.#policy.chain}`);

      this.#removeWalletListener?.();
      this.#wallet = wallet;
      this.#account = account;
      this.#clearProofs();

      const events = wallet.features[StandardEvents] as StandardEventsFeature[typeof StandardEvents] | undefined;
      if (events) {
        this.#removeWalletListener = events.on('change', ({ accounts }) => {
          if (!accounts) return;
          const next = accounts.find((candidate) => hasChain(candidate, this.#policy.chain)) ?? null;
          const previousAddress = this.#account?.address;
          this.#account = next;
          if (next?.address !== previousAddress) {
            this.#clearProofs();
            this.#setStatus(
              next
                ? 'Wallet account changed. Sign again to prove the new account.'
                : 'Wallet account access was removed. Connect again when ready.',
              next ? 'connected' : 'idle',
            );
          }
          this.#render();
        });
      }

      this.#dialog.close();
      this.#setStatus('Wallet connected. Sign once to prove it is yours.', 'connected');
      this.#render();
    } catch (error) {
      this.#setStatus(error instanceof Error ? error.message : 'Wallet connection failed', 'error');
    }
  }

  async #verifyWallet(): Promise<void> {
    if (!this.#wallet || !this.#account) return;
    this.#setStatus('Check the message, then sign. This costs nothing.', 'busy');
    this.#verifyButton.disabled = true;

    try {
      const input = await this.#createSignInInput(this.#account.address);
      let method: WalletProof['method'];
      let output: SignOutput;

      const signIn = this.#wallet.features[SolanaSignIn] as SolanaSignInFeature[typeof SolanaSignIn] | undefined;
      if (signIn && hasAccountFeature(this.#account, SolanaSignIn)) {
        const result = (await signIn.signIn(input))[0];
        if (!result || !verifySignIn(input, result)) throw new Error('Wallet returned an invalid SIWS proof');
        output = result;
        method = 'solana:signIn';
      } else {
        const signMessage = this.#wallet.features[SolanaSignMessage] as
          | SolanaSignMessageFeature[typeof SolanaSignMessage]
          | undefined;
        if (!signMessage || !hasAccountFeature(this.#account, SolanaSignMessage)) {
          throw new Error('This wallet cannot sign a Wallet Standard identity message');
        }
        const message = createSignInMessage({ ...input, domain: location.host, address: this.#account.address });
        const result = (await signMessage.signMessage({ account: this.#account, message }))[0];
        if (!result || !verifySignMessage({ account: this.#account, message }, result)) {
          throw new Error('Wallet returned an invalid message proof');
        }
        output = { ...result, account: this.#account };
        method = 'solana:signMessage';
      }

      if (output.account.address !== this.#account.address) throw new Error('Signed account changed during verification');
      const serverVerification = await this.#verifyWithServer(input, output, method);
      const digest = await digestProof(output.signedMessage, output.signature);
      this.#walletProof = {
        schema: 'neal.wallet-proof/v1',
        subject: this.#policy.identity.subjectFormat.replace('{address}', this.#account.address),
        address: this.#account.address,
        chain: this.#policy.chain,
        wallet: this.#wallet.name,
        method,
        requestId: input.requestId ?? '',
        issuedAt: input.issuedAt ?? '',
        expiresAt: input.expirationTime ?? '',
        signedMessage: encodeBase64Url(output.signedMessage),
        signature: encodeBase64Url(output.signature),
        publicKey: encodeBase64Url(new Uint8Array(this.#account.publicKey)),
        digest,
        verification: serverVerification.verification,
        serverSessionExpiresAt: serverVerification.sessionExpiresAt,
      };
      this.#holderProof = null;
      this.#setStatus(
        serverVerification.verification === 'server'
          ? 'Wallet authenticated. No email. No password.'
          : 'Signature verified in this tab. Server session is not live yet.',
        'verified',
      );
      this.#render();
      if (this.#getCanonicalMint()) await this.#checkHolder();
    } catch (error) {
      this.#setStatus(error instanceof Error ? error.message : 'Wallet verification failed', 'error');
    } finally {
      this.#render();
    }
  }

  async #createSignInInput(address: string): Promise<SolanaSignInInput> {
    if (this.#policy.identity.challengeEndpoint) {
      const response = await fetch(this.#policy.identity.challengeEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...manualRequestHeaders() },
        body: JSON.stringify({ schema: 'neal.wallet-challenge-request/v1', address, chain: this.#policy.chain }),
      });
      if (!response.ok) throw new Error('Wallet challenge service is unavailable');
      const body = await response.json() as { signInInput?: SolanaSignInInput };
      if (!body.signInInput) throw new Error('Wallet challenge service returned no SIWS input');
      return body.signInInput;
    }

    const issuedAt = new Date();
    const expirationTime = new Date(issuedAt.getTime() + this.#policy.identity.nonceTtlSeconds * 1000);
    const nonce = randomHex();
    return {
      domain: location.host,
      address,
      statement: this.#policy.identity.statement,
      uri: location.origin,
      version: '1',
      chainId: this.#policy.chain,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expirationTime.toISOString(),
      requestId: `neal-${nonce}`,
      resources: [new URL('/wallet-policy.json', location.origin).href],
    };
  }

  async #verifyWithServer(
    input: SolanaSignInInput,
    output: SignOutput,
    method: WalletProof['method'],
  ): Promise<{ verification: WalletProof['verification']; sessionExpiresAt: number | null }> {
    const endpoint = this.#policy.identity.verifyEndpoint;
    if (!endpoint) return { verification: 'local', sessionExpiresAt: null };
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...manualRequestHeaders() },
      body: JSON.stringify({
        schema: 'neal.wallet-verification/v1',
        method,
        signInInput: input,
        output: {
          account: {
            address: output.account.address,
            publicKey: encodeBase64Url(new Uint8Array(output.account.publicKey)),
          },
          signedMessage: encodeBase64Url(output.signedMessage),
          signature: encodeBase64Url(output.signature),
          signatureType: output.signatureType ?? 'ed25519',
        },
      }),
    });
    if (!response.ok) throw new Error('Wallet proof was rejected by the authentication service');
    const body = await response.json() as { authenticated?: boolean; sessionExpiresAt?: unknown };
    if (!body.authenticated) throw new Error('Wallet proof was not authenticated');
    if (typeof body.sessionExpiresAt !== 'number' || body.sessionExpiresAt <= Date.now()) {
      throw new Error('Wallet authentication service returned an invalid session expiry');
    }
    return { verification: 'server', sessionExpiresAt: body.sessionExpiresAt };
  }

  async #checkHolder(): Promise<void> {
    if (!this.#account || !this.#walletProof) {
      this.#setStatus('Verify wallet control before checking the bag.', 'error');
      return;
    }
    const mint = this.#getCanonicalMint();
    if (!mint) {
      this.#setStatus('No canonical NEAL mint yet. Holder proof unlocks after launch.', 'connected');
      this.#render();
      return;
    }

    this.#holderButton.disabled = true;
    this.#setStatus('Reading the chain. No signature required.', 'busy');
    try {
      const supply = await this.#rpc<TokenSupplyResult>('getTokenSupply', [
        mint,
        { commitment: this.#policy.holderProof.commitment },
      ]);
      const accounts = await this.#rpc<TokenAccountsResult>('getTokenAccountsByOwner', [
        this.#account.address,
        { mint },
        {
          encoding: 'jsonParsed',
          commitment: this.#policy.holderProof.commitment,
          minContextSlot: supply.context.slot,
        },
      ]);
      const amount = accounts.value.reduce((sum, entry) => {
        const raw = entry.account.data.parsed?.info?.tokenAmount?.amount;
        return sum + (typeof raw === 'string' ? BigInt(raw) : 0n);
      }, 0n);
      const holder = amount >= BigInt(this.#policy.holderProof.minimumAtomicBalance);
      this.#holderProof = {
        schema: 'neal.holder-proof/v1',
        subject: this.#walletProof.subject,
        address: this.#account.address,
        chain: this.#policy.chain,
        mint,
        amountAtomic: amount.toString(),
        decimals: supply.value.decimals,
        slot: accounts.context.slot,
        commitment: this.#policy.holderProof.commitment,
        observedAt: new Date().toISOString(),
        holder,
        walletProofDigest: this.#walletProof.digest,
      };
      this.#setStatus(
        holder
          ? `Bag verified at finalized slot ${accounts.context.slot.toLocaleString()}.`
          : `Wallet verified; no NEAL found at slot ${accounts.context.slot.toLocaleString()}.`,
        holder ? 'verified' : 'connected',
      );
      this.#render();
    } catch (error) {
      this.#setStatus(error instanceof Error ? error.message : 'Holder proof failed', 'error');
    } finally {
      this.#render();
    }
  }

  async #rpc<T>(method: string, params: readonly unknown[]): Promise<T> {
    const response = await fetch(this.#policy.holderProof.rpcEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...manualRequestHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomHex(4), method, params }),
    });
    if (!response.ok) throw new Error(`Solana RPC returned ${response.status}`);
    const body = await response.json() as RpcEnvelope<T>;
    if (body.error) throw new Error(`Solana RPC: ${body.error.message}`);
    if (!body.result) throw new Error('Solana RPC returned no result');
    return body.result;
  }

  async #disconnect(): Promise<void> {
    if (this.#wallet) {
      const disconnect = this.#wallet.features[StandardDisconnect] as
        | StandardDisconnectFeature[typeof StandardDisconnect]
        | undefined;
      if (disconnect) {
        try {
          await disconnect.disconnect();
        } catch (error) {
          console.warn('Wallet disconnect cleanup failed', error);
        }
      }
    }
    this.#removeWalletListener?.();
    this.#removeWalletListener = null;
    this.#wallet = null;
    this.#account = null;
    this.#clearProofs();
    this.#setStatus('Not connected. Your identity stays in your wallet.', 'idle');
    this.#render();
  }

  async #copyProof(): Promise<void> {
    if (!this.#walletProof) return;
    await navigator.clipboard.writeText(JSON.stringify({ walletProof: this.#walletProof, holderProof: this.#holderProof }, null, 2));
    this.#copyProofButton.textContent = 'PROOF COPIED';
    window.setTimeout(() => { this.#copyProofButton.textContent = 'COPY PROOF RECEIPT'; }, 1600);
  }

  #clearProofs(): void {
    this.#walletProof = null;
    this.#holderProof = null;
  }

  #expireServerProof(): void {
    if (
      this.#walletProof?.verification === 'server'
      && (this.#walletProof.serverSessionExpiresAt ?? 0) <= Date.now()
    ) {
      this.#clearProofs();
      this.#setStatus('Wallet session expired. Sign again to continue.', 'connected');
    }
  }

  #render(): void {
    this.#expireServerProof();
    const connected = Boolean(this.#wallet && this.#account);
    const verified = Boolean(this.#walletProof);
    const mint = this.#getCanonicalMint();
    this.#provider.textContent = this.#wallet?.name ?? '—';
    this.#address.textContent = this.#account?.address ?? '—';
    this.#auth.textContent = this.#walletProof
      ? `${this.#walletProof.method} · ${this.#walletProof.verification === 'server' ? 'SERVER VERIFIED' : 'VERIFIED THIS TAB'}`
      : connected ? 'SIGNATURE REQUIRED' : '—';
    this.#balance.textContent = this.#holderProof
      ? `${formatAtomic(BigInt(this.#holderProof.amountAtomic), this.#holderProof.decimals)} NEAL`
      : mint ? 'CHECK REQUIRED' : 'WAITS FOR MINT';
    this.#slot.textContent = this.#holderProof ? this.#holderProof.slot.toLocaleString() : '—';
    this.#topButton.textContent = this.#account
      ? `${verified ? 'VERIFIED' : 'CONNECTED'} · ${shortAddress(this.#account.address)}`
      : 'CONNECT WALLET';
    this.#panelButton.hidden = connected;
    this.#panelButton.disabled = connected;
    this.#verifyButton.hidden = !connected || verified;
    this.#verifyButton.disabled = !connected || verified;
    this.#holderButton.hidden = !verified;
    this.#holderButton.disabled = !verified || !mint;
    this.#holderButton.textContent = mint ? 'CHECK NEAL HOLDINGS' : 'HOLDER PROOF AFTER LAUNCH';
    this.#disconnectButton.hidden = !connected;
    this.#disconnectButton.disabled = !connected;
    this.#copyProofButton.hidden = !verified;
    this.#copyProofButton.disabled = !verified;
    this.#renderCapabilities();
    document.dispatchEvent(new CustomEvent('neal:wallet-session-change'));
  }

  #renderCapabilities(): void {
    this.#capabilities.replaceChildren();
    const features = [
      [SolanaSignIn, 'SIWS'],
      [SolanaSignMessage, 'MESSAGES'],
      [SolanaSignTransaction, 'SIGN TX'],
      [SolanaSignAndSendTransaction, 'SEND TX'],
    ] as const;
    for (const [feature, label] of features) {
      const badge = document.createElement('span');
      const supported = Boolean(this.#wallet && featureVersion(this.#wallet, feature));
      badge.className = supported ? 'on' : '';
      badge.textContent = label;
      this.#capabilities.append(badge);
    }
  }

  #setStatus(message: string, state: 'idle' | 'busy' | 'connected' | 'verified' | 'error'): void {
    this.#status.className = `wallet-status ${state}`;
    this.#status.textContent = message;
  }

  async #registerMobileWalletAdapter(): Promise<void> {
    if (!/Android/iu.test(navigator.userAgent)) return;
    try {
      const { registerMwa } = await import('@solana-mobile/wallet-standard-mobile');
      let authorization: unknown;
      registerMwa({
        appIdentity: {
          name: 'NEAL',
          uri: location.origin,
          icon: '/neal-favicon.png',
        },
        authorizationCache: {
          clear: async () => { authorization = undefined; },
          get: async () => authorization as never,
          set: async (value) => { authorization = value; },
        },
        chains: [this.#policy.chain],
        chainSelector: { select: async () => this.#policy.chain },
        onWalletNotFound: async () => {
          this.#setStatus('No compatible mobile wallet app found.', 'error');
        },
      });
    } catch (error) {
      console.warn('Mobile Wallet Adapter registration failed', error);
    }
  }
}

export async function mountWalletIdentity(getCanonicalMint: () => string | null): Promise<WalletIdentityController | null> {
  try {
    const response = await fetch('/wallet-policy.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Wallet policy returned ${response.status}`);
    const policy = await response.json() as WalletPolicy;
    if (policy.schema !== 'neal.wallet-policy/v1') throw new Error('Unsupported wallet policy');
    const controller = new WalletIdentityController(policy, getCanonicalMint);
    await controller.start();
    return controller;
  } catch (error) {
    const status = document.querySelector<HTMLElement>('#wallet-status');
    if (status) {
      status.className = 'wallet-status error';
      status.textContent = error instanceof Error ? error.message : 'Wallet identity layer failed to start';
    }
    return null;
  }
}
