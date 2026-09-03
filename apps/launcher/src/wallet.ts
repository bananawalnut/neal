import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features';

const CHAIN = 'solana:mainnet';

export type ConnectedWallet = { wallet: Wallet; account: WalletAccount };

export class LaunchWalletController {
  readonly #registry = getWallets();
  readonly #list: HTMLElement;
  readonly #status: HTMLElement;
  readonly #onChange: (value: ConnectedWallet | null) => void;
  #connected: ConnectedWallet | null = null;
  #removeListener: (() => void) | null = null;

  constructor(list: HTMLElement, status: HTMLElement, onChange: (value: ConnectedWallet | null) => void) {
    this.#list = list;
    this.#status = status;
    this.#onChange = onChange;
  }

  start(): void {
    this.#registry.on('register', () => this.#render());
    this.#registry.on('unregister', () => this.#render());
    this.#render();
  }

  get connected(): ConnectedWallet | null {
    return this.#connected;
  }

  #wallets(): readonly Wallet[] {
    return [...this.#registry.get()]
      .filter((wallet) => wallet.chains.includes(CHAIN))
      .filter((wallet) => StandardConnect in wallet.features)
      .filter((wallet) => StandardEvents in wallet.features)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  #render(): void {
    this.#list.replaceChildren();
    const wallets = this.#wallets();
    if (wallets.length === 0) {
      this.#list.textContent = 'No Solana Wallet Standard wallet detected.';
      return;
    }
    for (const wallet of wallets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wallet-choice';
      const image = document.createElement('img');
      image.src = wallet.icon;
      image.alt = '';
      const label = document.createElement('span');
      label.textContent = wallet.name;
      button.append(image, label);
      button.addEventListener('click', () => void this.#connect(wallet));
      this.#list.append(button);
    }
  }

  async #connect(wallet: Wallet): Promise<void> {
    this.#status.textContent = `Opening ${wallet.name}…`;
    try {
      const feature = wallet.features[StandardConnect] as StandardConnectFeature[typeof StandardConnect];
      const output = await feature.connect({ silent: false });
      const account = output.accounts.find((candidate) => candidate.chains.includes(CHAIN));
      if (!account) throw new Error('Wallet did not authorize a Solana mainnet account');

      this.#removeListener?.();
      this.#connected = { wallet, account };
      const events = wallet.features[StandardEvents] as StandardEventsFeature[typeof StandardEvents];
      this.#removeListener = events.on('change', ({ accounts }) => {
        if (!accounts) return;
        const next = accounts.find((candidate) => candidate.chains.includes(CHAIN));
        this.#connected = next ? { wallet, account: next } : null;
        this.#status.textContent = next
          ? `${wallet.name} · ${next.address}`
          : 'Wallet access removed. Reconnect before rebuilding.';
        this.#onChange(this.#connected);
      });
      this.#status.textContent = `${wallet.name} · ${account.address}`;
      this.#onChange(this.#connected);
    } catch (error) {
      this.#connected = null;
      this.#status.textContent = error instanceof Error ? error.message : 'Wallet connection failed';
      this.#onChange(null);
    }
  }
}
