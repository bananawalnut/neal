import initWasm, { inspect_manifest } from './wasm-pkg/neal_launch_wasm.js';
import './styles.css';
import {
  buildLaunchTransaction,
  refreshPreparedLaunch,
  signAndSendPreparedLaunch,
  type PreparedLaunch,
} from './transaction';
import type { AssetManifest, Check, LaunchControl, MetadataDocument, ReviewInput } from './types';
import { LaunchWalletController, type ConnectedWallet } from './wallet';

const MAINNET_RPC = 'https://solana-rpc.publicnode.com';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main class="console-shell">
    <header class="masthead">
      <div><span class="eyebrow">NEAL / MAINNET LAUNCH CONTROL</span><h1>BUILD IT.<br><i>REVIEW IT.</i><br>APPROVE IN PHANTOM.</h1></div>
      <img src="/neal-token.png" width="320" height="320" alt="Neal the Seal" />
      <p class="danger-chip">NO AUTOMATIC SIGNING</p>
    </header>

    <section class="status-strip" aria-label="Safety boundaries">
      <span>OFFICIAL PUMP SDK</span><span>SOLANA WALLET STANDARD</span><span>PHANTOM APPROVAL</span><span>MAINNET FAILS CLOSED</span>
    </section>

    <section class="panel panel--cream" id="immutable-panel">
      <header><span>01</span><div><p>IMMUTABLE ASSET REVIEW</p><h2>Exactly what becomes NEAL.</h2></div></header>
      <div class="asset-grid">
        <div class="asset-previews">
          <img class="token-preview" src="/neal-token.png" alt="Final NEAL token artwork" />
          <img class="banner-preview" id="banner-preview" src="/neal-banner.jpg" alt="Final NEAL banner artwork" hidden />
        </div>
        <dl class="facts" id="asset-facts"></dl>
      </div>
      <details><summary>SHOW GENERATED METADATA</summary><pre id="metadata-preview"></pre></details>
      <div class="decision-row">
        <label><input id="omit-socials" type="checkbox" /> SOCIAL LINKS INTENTIONALLY OMITTED</label>
        <label><input id="omit-banner" type="checkbox" /> BANNER INTENTIONALLY OMITTED</label>
        <label><input id="rights-cleared" type="checkbox" /> NAME, ARTWORK & COPY CLEARED FOR USE</label>
      </div>
    </section>

    <section class="panel panel--yellow">
      <header><span>02</span><div><p>EXACT LAUNCH INPUTS</p><h2>No percentage target. One disclosed spend ceiling.</h2></div></header>
      <div class="form-grid">
        <label>METADATA URI<input id="metadata-uri" type="url" spellcheck="false" /></label>
        <label>MAXIMUM INITIAL DEV PURCHASE (SOL)<input id="purchase-sol" type="text" inputmode="decimal" placeholder="0 or exact SOL maximum" /></label>
        <label>COORDINATED LAUNCH TIME<input id="launch-at" type="datetime-local" /></label>
        <label>SOLANA RPC<input id="rpc-endpoint" type="url" spellcheck="false" value="${MAINNET_RPC}" /></label>
      </div>
      <p class="plain-note">The purchase field is a hard SOL ceiling, not a supply percentage. The builder reserves Pump's internal 1% tolerance inside that ceiling.</p>
    </section>

    <section class="panel panel--cyan">
      <header><span>03</span><div><p>PHANTOM WALLET</p><h2>Connect the disclosed creator account.</h2></div></header>
      <div id="wallet-list" class="wallet-list"></div>
      <p id="wallet-status" class="wallet-status">No wallet connected.</p>
      <dl class="route-review">
        <div><dt>DEV / CREATOR</dt><dd id="dev-wallet"></dd></div>
        <div><dt>QUEST TREASURY</dt><dd id="treasury-wallet"></dd></div>
        <div><dt>POST-LAUNCH CREATOR FEES</dt><dd>58% DEV · 42% QUESTS</dd></div>
      </dl>
    </section>

    <section class="panel panel--coral">
      <header><span>04</span><div><p>PREFLIGHT</p><h2>Blockers first. Transaction second.</h2></div></header>
      <ul id="checks" class="checks"></ul>
      <button class="big-action" id="prepare" type="button" disabled>BUILD & SIMULATE EXACT TRANSACTION</button>
      <p id="prepare-status" class="action-status">Waiting for immutable decisions and the disclosed wallet.</p>
    </section>

    <section class="panel panel--black" id="review-panel" hidden>
      <header><span>05</span><div><p>FINAL HUMAN REVIEW</p><h2>This is the signing boundary.</h2></div></header>
      <div id="transaction-summary" class="transaction-summary"></div>
      <details><summary>SHOW PROGRAM INSTRUCTIONS</summary><div id="instruction-review"></div></details>
      <details><summary>SHOW SIMULATION LOGS</summary><pre id="simulation-logs"></pre></details>
      <div class="sign-lock">
        <label><input id="reviewed" type="checkbox" /> I REVIEWED THE MINT, METADATA, WALLET, HARD MAXIMUM AND SIMULATION.</label>
        <label>TYPE <b>LAUNCH NEAL</b><input id="confirmation-phrase" type="text" autocomplete="off" /></label>
        <button class="sign-action" id="sign" type="button" disabled>REVIEW & APPROVE IN PHANTOM</button>
      </div>
      <p id="sign-status" class="action-status">Nothing has been signed or sent.</p>
    </section>

    <section class="panel panel--cream">
      <header><span>06</span><div><p>AFTER CONFIRMATION</p><h2>The next two signatures are already specified.</h2></div></header>
      <ol class="after-list">
        <li>Record the canonical mint and creation signature atomically.</li>
        <li>Publish the mint, dev fill and public receipt.</li>
        <li>Create Pump's fee-sharing configuration.</li>
        <li>Review and sign the one-time immutable 58/42 recipient update.</li>
      </ol>
      <p class="plain-note">The console will never combine the immutable fee-share update with an unreviewed transaction.</p>
    </section>
  </main>
`;

const required = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const shortAddress = (value: string): string => `${value.slice(0, 6)}…${value.slice(-6)}`;
const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const lamportsToSol = (value: bigint): string => {
  const raw = value.toString().padStart(10, '0');
  const whole = raw.slice(0, -9);
  const fraction = raw.slice(-9).replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : whole;
};

const parseSolToLamports = (value: string): string | null => {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return `${whole}${fraction.padEnd(9, '0')}`.replace(/^0+(?=\d)/u, '');
};

const localDateTime = (value: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const config = (await fetch('/launch-config.json').then((response) => response.json())) as LaunchControl;
const assets = (await fetch('/asset-manifest.json').then((response) => response.json())) as AssetManifest;
const metadata = (await fetch('/token-metadata.json').then((response) => response.json())) as MetadataDocument;
await initWasm();

required<HTMLImageElement>('banner-preview').hidden = !config.token.bannerPath;

required<HTMLElement>('asset-facts').innerHTML = `
  <div><dt>NAME</dt><dd>${escapeHtml(config.token.name)}</dd></div>
  <div><dt>TICKER</dt><dd>${escapeHtml(config.token.symbol)}</dd></div>
  <div><dt>DESCRIPTION</dt><dd>${escapeHtml(config.token.description ?? '')}</dd></div>
  <div><dt>WEBSITE</dt><dd>${escapeHtml(config.token.website ?? '')}</dd></div>
  <div><dt>SOCIAL LINKS</dt><dd>${config.token.socialLinks.map((link) => escapeHtml(JSON.stringify(link))).join('<br>')}</dd></div>
  <div><dt>BANNER</dt><dd>${escapeHtml(config.token.bannerUrl ?? 'OMITTED')}</dd></div>
  <div><dt>IMAGE SHA-256</dt><dd class="mono">${assets.image.sha256}</dd></div>
  <div><dt>IMAGE BYTES</dt><dd>${assets.image.bytes.toLocaleString()}</dd></div>
`;
required<HTMLElement>('metadata-preview').textContent = JSON.stringify(metadata, null, 2);
required<HTMLInputElement>('metadata-uri').value = config.token.metadataUri ?? assets.metadataUri;
required<HTMLInputElement>('purchase-sol').value = config.pumpfun.initialCreatorPurchaseLamports
  ? lamportsToSol(BigInt(config.pumpfun.initialCreatorPurchaseLamports))
  : '';
required<HTMLInputElement>('launch-at').value = localDateTime(config.pumpfun.launchAt);
required<HTMLElement>('dev-wallet').textContent = config.pumpfun.creatorWallet ?? 'MISSING';
required<HTMLElement>('treasury-wallet').textContent = config.programs.economics.questTreasury.wallet ?? 'MISSING';

let connected: ConnectedWallet | null = null;
let prepared: PreparedLaunch | null = null;
let preparedInputDigest = '';

const walletController = new LaunchWalletController(
  required('wallet-list'),
  required('wallet-status'),
  (value) => {
    connected = value;
    invalidatePrepared('Wallet state changed. Rebuild the transaction.');
    renderChecks();
  },
);
walletController.start();

const inputs = (): ReviewInput | null => {
  const maximumPurchaseLamports = parseSolToLamports(required<HTMLInputElement>('purchase-sol').value);
  if (maximumPurchaseLamports === null) return null;
  const launchValue = required<HTMLInputElement>('launch-at').value;
  const launchAt = launchValue ? new Date(launchValue).toISOString() : '';
  return {
    metadataUri: required<HTMLInputElement>('metadata-uri').value.trim(),
    maximumPurchaseLamports,
    launchAt,
    rpcEndpoint: required<HTMLInputElement>('rpc-endpoint').value.trim(),
  };
};

const inputDigest = (input: ReviewInput, address: string): string => JSON.stringify({ input, address });

const checks = (): Check[] => {
  const current = inputs();
  const socialDecision = config.token.socialLinks.length > 0 || required<HTMLInputElement>('omit-socials').checked;
  const bannerDecision = Boolean(config.token.bannerPath) || required<HTMLInputElement>('omit-banner').checked;
  const purchaseValue = required<HTMLInputElement>('purchase-sol').value.trim();
  const launchValue = required<HTMLInputElement>('launch-at').value;
  const metadataValue = required<HTMLInputElement>('metadata-uri').value.trim();
  const connectedAddress = connected?.account.address ?? null;
  const creator = config.pumpfun.creatorWallet;
  const feeShares = config.programs.economics.creatorFeeRouting.shares.reduce(
    (sum, share) => sum + share.shareBasisPoints,
    0,
  );
  const purchasePersisted = Boolean(current && config.pumpfun.initialCreatorPurchaseLamports === current.maximumPurchaseLamports);
  const launchTimePersisted = Boolean(current && config.pumpfun.launchAt === current.launchAt);
  return [
    { status: config.token.name === 'Neal the Seal' && config.token.symbol === 'NEAL' ? 'pass' : 'blocker', label: 'CANONICAL IDENTITY', detail: `${config.token.name} / ${config.token.symbol}` },
    { status: config.canonicalRoute === 'pumpfun' && config.network === 'solana' ? 'pass' : 'blocker', label: 'CANONICAL ROUTE', detail: 'Pump.fun / Solana / SOL quote' },
    { status: !config.pumpfun.mayhemMode && !config.pumpfun.cashBack ? 'pass' : 'blocker', label: 'CREATION MODES', detail: 'Mayhem off / cashback off' },
    { status: socialDecision ? 'pass' : 'blocker', label: 'SOCIAL LINKS', detail: config.token.socialLinks.length > 0 ? 'Included in frozen configuration' : 'Confirm intentional omission' },
    { status: bannerDecision ? 'pass' : 'blocker', label: 'BANNER', detail: config.token.bannerPath ? 'Included in frozen configuration' : 'Confirm intentional omission' },
    { status: required<HTMLInputElement>('rights-cleared').checked ? 'pass' : 'blocker', label: 'RIGHTS / COPY', detail: 'Human confirmation required' },
    { status: metadataValue.startsWith('https://') || metadataValue.startsWith('ipfs://') ? 'pass' : 'blocker', label: 'METADATA URI', detail: metadataValue || 'Missing' },
    { status: current ? 'pass' : 'blocker', label: 'INITIAL PURCHASE', detail: purchaseValue ? `${purchaseValue} SOL hard maximum` : 'Set zero or an exact maximum' },
    { status: launchValue ? 'pass' : 'blocker', label: 'LAUNCH TIME', detail: launchValue || 'Missing' },
    { status: purchasePersisted ? 'pass' : 'blocker', label: 'PERSISTED PURCHASE CEILING', detail: purchasePersisted ? `${current?.maximumPurchaseLamports ?? ''} lamports matches launch-config.json` : 'Stage the selected SOL ceiling into launch-config.json' },
    { status: launchTimePersisted ? 'pass' : 'blocker', label: 'PERSISTED LAUNCH TIME', detail: launchTimePersisted ? `${current?.launchAt ?? ''} matches launch-config.json` : 'Stage the selected launch time into launch-config.json' },
    { status: connectedAddress === creator ? 'pass' : 'blocker', label: 'CONNECTED SIGNER', detail: connectedAddress ? `${shortAddress(connectedAddress)}${connectedAddress === creator ? ' matches creator' : ' does not match creator'}` : 'Connect the disclosed creator account in Phantom' },
    { status: feeShares === 10_000 ? 'pass' : 'blocker', label: 'POST-LAUNCH FEE SHARES', detail: '58% dev / 42% quest treasury / one-time final update' },
    { status: 'warning', label: 'REMOTE ASSET PROBE', detail: 'Run the deployment verifier immediately before signing; local preview alone is not proof of hosting.' },
  ];
};

const renderChecks = (): void => {
  const values = checks();
  required<HTMLElement>('checks').innerHTML = values.map((check) => `<li class="check check--${check.status}"><b>${check.status.toUpperCase()}</b><span><strong>${escapeHtml(check.label)}</strong><small>${escapeHtml(check.detail)}</small></span></li>`).join('');
  const blocked = values.some((check) => check.status === 'blocker');
  required<HTMLButtonElement>('prepare').disabled = blocked;
  if (!prepared) required<HTMLElement>('prepare-status').textContent = blocked ? 'Resolve every blocker before transaction construction.' : 'Inputs are complete. Build and simulate when ready.';
};

const invalidatePrepared = (message = 'Inputs changed. Rebuild and re-simulate before signing.'): void => {
  prepared = null;
  preparedInputDigest = '';
  required<HTMLElement>('review-panel').hidden = true;
  required<HTMLElement>('prepare-status').textContent = message;
  required<HTMLInputElement>('reviewed').checked = false;
  required<HTMLInputElement>('confirmation-phrase').value = '';
  required<HTMLButtonElement>('sign').disabled = true;
};

for (const id of ['omit-socials', 'omit-banner', 'rights-cleared', 'metadata-uri', 'purchase-sol', 'launch-at', 'rpc-endpoint']) {
  required<HTMLInputElement>(id).addEventListener('input', () => { invalidatePrepared(); renderChecks(); });
}

required<HTMLButtonElement>('prepare').addEventListener('click', () => {
  void (async () => {
    const current = inputs();
    if (!current || !connected) return;
    const button = required<HTMLButtonElement>('prepare');
    button.disabled = true;
    required<HTMLElement>('prepare-status').textContent = 'Fetching Pump state, constructing instructions and simulating…';
    try {
      const manifestReport = JSON.parse(inspect_manifest(JSON.stringify({
        name: config.token.name,
        symbol: config.token.symbol,
        metadataUri: current.metadataUri,
        creatorWallet: connected.account.address,
        quoteAsset: config.pumpfun.quoteAsset,
        mayhemMode: config.pumpfun.mayhemMode,
        cashback: config.pumpfun.cashBack,
        maxQuoteLamports: current.maximumPurchaseLamports,
      }))) as { valid: boolean; blockers: string[]; digestHex: string };
      if (!manifestReport.valid) throw new Error(manifestReport.blockers.join('; '));

      prepared = await buildLaunchTransaction(config, current, connected.account.address);
      preparedInputDigest = inputDigest(current, connected.account.address);
      if (!prepared.simulation.ok) throw new Error(`Simulation failed: ${prepared.simulation.error}`);

      const fee = BigInt(prepared.simulation.networkFeeLamports ?? 0);
      const estimatedOut = Number(prepared.estimatedTokenBaseUnits) / 1_000_000;
      required<HTMLElement>('transaction-summary').innerHTML = `<dl>
        <div><dt>NEW MINT</dt><dd class="mono">${prepared.mint.publicKey.toBase58()}</dd></div>
        <div><dt>METADATA</dt><dd class="mono">${escapeHtml(current.metadataUri)}</dd></div>
        <div><dt>HARD PURCHASE MAX</dt><dd>${lamportsToSol(prepared.maximumPurchaseLamports)} SOL</dd></div>
        <div><dt>CURVE INPUT</dt><dd>${lamportsToSol(prepared.curveInputLamports)} SOL</dd></div>
        <div><dt>ESTIMATED TOKENS</dt><dd>${estimatedOut.toLocaleString(undefined, { maximumFractionDigits: 6 })} NEAL</dd></div>
        <div><dt>EST. NETWORK FEE</dt><dd>${lamportsToSol(fee)} SOL</dd></div>
        <div><dt>CONNECTED BALANCE</dt><dd>${lamportsToSol(BigInt(prepared.simulation.walletBalanceLamports))} SOL</dd></div>
        <div><dt>COMPUTE UNITS</dt><dd>${prepared.simulation.unitsConsumed?.toLocaleString() ?? 'RPC DID NOT REPORT'}</dd></div>
        <div><dt>MANIFEST DIGEST</dt><dd class="mono">${manifestReport.digestHex}</dd></div>
      </dl>`;
      required<HTMLElement>('instruction-review').innerHTML = prepared.instructions.map((instruction) => `<article><b>IX ${instruction.index}</b><code>${instruction.programId}</code><span>${instruction.signerCount} signer · ${instruction.writableCount} writable · ${instruction.dataBytes} data bytes</span></article>`).join('');
      required<HTMLElement>('simulation-logs').textContent = prepared.simulation.logs.join('\n');
      required<HTMLElement>('review-panel').hidden = false;
      required<HTMLElement>('prepare-status').textContent = 'Simulation passed. Final human review is now required.';
      required<HTMLElement>('review-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      prepared = null;
      required<HTMLElement>('prepare-status').textContent = error instanceof Error ? error.message : 'Transaction preparation failed';
    } finally {
      renderChecks();
    }
  })();
});

const updateSignLock = (): void => {
  const current = inputs();
  const stillCurrent = Boolean(current && connected && prepared && preparedInputDigest === inputDigest(current, connected.account.address));
  required<HTMLButtonElement>('sign').disabled = !(stillCurrent && required<HTMLInputElement>('reviewed').checked && required<HTMLInputElement>('confirmation-phrase').value.trim() === 'LAUNCH NEAL');
};

required<HTMLInputElement>('reviewed').addEventListener('change', updateSignLock);
required<HTMLInputElement>('confirmation-phrase').addEventListener('input', updateSignLock);

required<HTMLButtonElement>('sign').addEventListener('click', () => {
  void (async () => {
    if (!prepared || !connected) return;
    const button = required<HTMLButtonElement>('sign');
    button.disabled = true;
    required<HTMLElement>('sign-status').textContent = 'Refreshing the blockhash and re-simulating immediately before Phantom…';
    try {
      const current = inputs();
      if (!current || preparedInputDigest !== inputDigest(current, connected.account.address)) {
        throw new Error('Launch inputs or wallet changed after review; rebuild the transaction');
      }
      prepared = await refreshPreparedLaunch(prepared);
      required<HTMLElement>('simulation-logs').textContent = prepared.simulation.logs.join('\n');
      required<HTMLElement>('sign-status').textContent = 'Fresh simulation passed. Approve promptly in Phantom before the blockhash expires…';
      const signature = await signAndSendPreparedLaunch(prepared, connected.wallet, connected.account);
      const receipt = { schema: 'neal.launch-receipt/v1', mintAddress: prepared.mint.publicKey.toBase58(), creationTransaction: signature, confirmedAt: new Date().toISOString() };
      const receiptJson = JSON.stringify(receipt, null, 2);
      required<HTMLElement>('sign-status').innerHTML = `CONFIRMED. SAVE THIS RECEIPT INTO THE LAUNCH RECORD:<pre>${escapeHtml(receiptJson)}</pre><button id="download-receipt" type="button">DOWNLOAD VERIFIED RECEIPT</button>`;
      required<HTMLButtonElement>('download-receipt').addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([`${receiptJson}\n`], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `neal-launch-receipt-${prepared?.mint.publicKey.toBase58() ?? 'confirmed'}.json`;
        link.click();
        URL.revokeObjectURL(url);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Signing failed';
      required<HTMLElement>('sign-status').textContent = /expired|block height exceeded|blockhash not found/iu.test(message)
        ? 'Confirmation expired without a conclusive chain result. DO NOT RETRY: check the wallet address or signature on an explorer first.'
        : message;
      updateSignLock();
    }
  })();
});

renderChecks();
