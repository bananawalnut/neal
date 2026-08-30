import './styles.css';
import './yahoos.css';
import { formatLocalStreak, getLocalYahooStats, onLocalYahooChange, recordLocalYahoo, type LocalYahooStats } from './local-yahoos';

type YahooPolicy = {
  localMode?: {
    enabled: boolean;
    storage: 'browser_local_storage';
    price: 'free';
    rankingScope: 'this_browser';
  };
  futureOnChainPolicyStatus?: 'undecided';
  dailyFreePerWallet: number;
  dailyWindow: string;
  paidPriceNumerator: string;
  paidPriceDenominator: string;
  acceptedPaymentAssets: Array<{ symbol: 'NEAL' | 'DREGG'; amountTokens: string }>;
  fastestConsecutiveCount: number;
  peakRateWindowSeconds?: number;
  programId: string | null;
  leaderboardRegistryUri: string | null;
  status: 'pre_launch' | 'active' | 'paused';
};

type LaunchRecord = {
  schema: 'neal.public-record/v1';
  status: 'pre_launch' | 'launched';
  programs: { yahoos?: YahooPolicy | null };
  secondaryLiquidity: { quoteMint: string | null };
};

type LeaderboardRecord = {
  schema: 'neal.yahoo-leaderboard/v1';
  asOfSlot: number | null;
  totalYahoos: Array<{ rank: number; address: string; totalYahoos: string }>;
  fastestConsecutiveYahoos: Array<{ rank: number; address: string; elapsedSlots: number }>;
  peakYahooRate?: Array<{ rank: number; address: string; yahoosInWindow: number }>;
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main class="shell yahoo-page">
    <nav class="topbar yahoo-nav">
      <a class="brand" href="/"><span class="brand-orb"><img src="/neal-token.png" alt="" /></span><span>NEAL</span><small>YAHOO YARD</small></a>
      <div class="nav-links"><a class="active" href="/yahoos/">Yahoos</a><a href="/leaderboards/">Leaderboards</a><a href="/#community-vote">Vote</a><a href="/#verify">Proof</a></div>
      <a class="wallet-button" href="/#wallet-identity">CONNECT WALLET</a>
    </nav>

    <header class="yahoo-page-hero">
      <p class="eyebrow">THE OFFICIAL LOCAL CARRY-ON</p>
      <h1>YAHOO!<br><em>YAHOO!</em><br>YAHOO!</h1>
      <div class="yahoo-hero-rule"><strong>ALL FREE.</strong><span>THIS BROWSER. RIGHT NOW.</span></div>
      <p>No wallet. No token. No daily cap. Smash the button and this browser remembers the racket. Future on-chain rules are still up for decision.</p>
      <a href="#yahoo-console">GET TO THE BIG RED BUTTON ↓</a>
    </header>

    <section class="yahoo-console-page" id="yahoo-console" aria-labelledby="yahoo-console-title">
      <div class="yahoo-console-copy">
        <p class="eyebrow">YOUR LOCAL RACKET</p>
        <h2 id="yahoo-console-title">LET ONE<br>RIP.</h2>
        <p id="yahoo-program-copy">Checking the local YAHOO switch…</p>
        <div class="yahoo-metrics">
          <article><span>PRICE</span><strong>FREE</strong></article>
          <article><span>YOUR LOCAL TOTAL</span><strong id="yahoo-local-total">0</strong></article>
          <article><span>FASTEST LOCAL THREE</span><strong id="yahoo-local-streak">—</strong></article>
          <article><span>LOCAL TOP SPEED</span><strong id="yahoo-local-rate">— / MIN</strong></article>
        </div>
      </div>
      <div class="yahoo-button-board">
        <span id="yahoo-program-state">CHECKING LOCAL MODE</span>
        <button id="yahoo-action" type="button" disabled>YAHOO!</button>
        <p id="yahoo-action-status" role="status">Getting the local racket ready…</p>
        <a href="/leaderboards/">OPEN YOUR LOCAL TABLES ↗</a>
      </div>
    </section>

    <section class="yahoo-rules">
      <article><b>01</b><h2>FREE AS A BIRD.</h2><p>Every local YAHOO is free for now. No wallet prompt, no transaction, no sneaky token charge.</p></article>
      <article><b>02</b><h2>LIVES IN YOUR BROWSER.</h2><p>Your racket stays on this device. Clear the site's browser data and the local record goes with it.</p></article>
      <article><b>03</b><h2>CLIMB YOUR TABLE.</h2><p>Chase your local total, fastest three-YAHOO streak, and biggest 60-second burst. Global and on-chain rules come later—if the mob wants them.</p></article>
    </section>

    <section class="yahoo-mini-tables">
      <header><div><p class="eyebrow">LIVE FROM THIS BROWSER</p><h2>TOP OF THE YAP.</h2></div><a href="/leaderboards/">FULL LOCAL TABLES ↗</a></header>
      <div class="yahoo-mini-grid">
        <article><h3>MOST LOCAL YAHOOS</h3><ol id="yahoo-total-preview"><li>NO LOCAL YAHOOS YET</li></ol></article>
        <article><h3>FASTEST LOCAL 3-YAHOO STREAK</h3><ol id="yahoo-fast-preview"><li>NO LOCAL STREAK YET</li></ol></article>
        <article><h3>LOCAL TOP SPEED</h3><ol id="yahoo-rate-preview"><li>NO LOCAL SPEED YET</li></ol></article>
      </div>
    </section>

    <footer><span>NEAL / GOOD CUNT</span><span id="yahoo-footer-state">LOCAL YAHOOS · FREE</span></footer>
  </main>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const shortWallet = (address: string): string => address.length > 10
  ? `${address.slice(0, 4)}…${address.slice(-4)}`
  : address;

function renderRows(target: HTMLOListElement, rows: string[], empty: string) {
  target.replaceChildren();
  for (const row of rows.length ? rows.slice(0, 3) : [empty]) {
    const item = document.createElement('li');
    item.textContent = row;
    target.append(item);
  }
}

function renderLocalStats(stats: LocalYahooStats) {
  byId('yahoo-local-total').textContent = stats.total.toLocaleString();
  byId('yahoo-local-streak').textContent = formatLocalStreak(stats.fastestThreeMs);
  byId('yahoo-local-rate').textContent = stats.peakPerMinute ? `${stats.peakPerMinute} / MIN` : '— / MIN';
  renderRows(byId<HTMLOListElement>('yahoo-total-preview'), stats.total ? [`1. THIS BROWSER — ${stats.total.toLocaleString()}`] : [], 'NO LOCAL YAHOOS YET');
  renderRows(byId<HTMLOListElement>('yahoo-fast-preview'), stats.fastestThreeMs === null ? [] : [`1. THIS BROWSER — ${formatLocalStreak(stats.fastestThreeMs)}`], 'NO LOCAL STREAK YET');
  renderRows(byId<HTMLOListElement>('yahoo-rate-preview'), stats.peakPerMinute ? [`1. THIS BROWSER — ${stats.peakPerMinute}/MIN`] : [], 'NO LOCAL SPEED YET');
}

function renderPolicy(record: LaunchRecord): boolean {
  const policy = record.programs.yahoos;
  const action = byId<HTMLButtonElement>('yahoo-action');
  action.disabled = true;
  if (!policy) {
    byId('yahoo-program-state').textContent = 'POLICY MISSING';
    byId('yahoo-program-copy').textContent = 'No public on-chain YAHOO policy is available.';
    byId('yahoo-action-status').textContent = 'Nothing can be submitted.';
    return false;
  }
  if (policy.localMode?.enabled && policy.localMode.price === 'free') {
    byId('yahoo-program-state').textContent = 'LOCAL MODE · FREE';
    byId('yahoo-program-copy').textContent = 'Every YAHOO is free and saved only in this browser. The future on-chain setup is deliberately undecided.';
    byId('yahoo-action-status').textContent = 'This makes a local browser record only. No wallet opens and nothing goes on-chain.';
    action.disabled = false;
    action.textContent = 'LET ONE RIP';
    renderLocalStats(getLocalYahooStats());
    return true;
  }
  const paid = policy.acceptedPaymentAssets.map((asset) => `${asset.amountTokens} ${asset.symbol}`).join(' or ');
  byId('yahoo-program-copy').textContent = `${policy.dailyFreePerWallet} free per wallet per UTC day. After that: ${paid}.`;

  if (record.status !== 'launched' || !policy.programId) {
    byId('yahoo-program-state').textContent = 'PRE-LAUNCH';
    action.textContent = 'YAHOOS START AFTER LAUNCH';
    byId('yahoo-action-status').textContent = 'The canonical mint, reviewed YAHOO program, and wallet transaction builder are not live yet. Nothing will be sent.';
  } else if (policy.status !== 'active') {
    byId('yahoo-program-state').textContent = policy.status.replaceAll('_', ' ').toUpperCase();
    action.textContent = 'YAHOOS PAUSED';
    byId('yahoo-action-status').textContent = 'The on-chain program is not accepting new YAHOOS.';
  } else {
    byId('yahoo-program-state').textContent = 'BUILDER PENDING';
    action.textContent = 'TRANSACTION BUILDER PENDING';
    byId('yahoo-action-status').textContent = 'The on-chain program exists, but the separately reviewed wallet builder is still required.';
  }
  return false;
}

let localMode = false;
byId<HTMLButtonElement>('yahoo-action').addEventListener('click', () => {
  if (!localMode) return;
  renderLocalStats(recordLocalYahoo());
  const action = byId<HTMLButtonElement>('yahoo-action');
  action.textContent = 'YAHOO!';
  window.setTimeout(() => { action.textContent = 'LET ANOTHER RIP'; }, 260);
});
onLocalYahooChange((stats) => {
  if (localMode) renderLocalStats(stats);
});

async function start() {
  try {
    const [launchResponse, boardResponse] = await Promise.all([
      fetch('/launch-record.json', { cache: 'no-store' }),
      fetch('/yahoo-leaderboard.json', { cache: 'no-store' }),
    ]);
    if (!launchResponse.ok || !boardResponse.ok) throw new Error('Public YAHOO records unavailable');
    const launch = await launchResponse.json() as LaunchRecord;
    const board = await boardResponse.json() as LeaderboardRecord;
    if (launch.schema !== 'neal.public-record/v1' || board.schema !== 'neal.yahoo-leaderboard/v1') throw new Error('Unsupported public record');
    localMode = renderPolicy(launch);
    if (!localMode) {
      renderRows(byId<HTMLOListElement>('yahoo-total-preview'), board.totalYahoos.map((row) => `${row.rank}. ${shortWallet(row.address)} — ${row.totalYahoos}`), 'NO ON-CHAIN YAHOOS YET');
      renderRows(byId<HTMLOListElement>('yahoo-fast-preview'), board.fastestConsecutiveYahoos.map((row) => `${row.rank}. ${shortWallet(row.address)} — ${row.elapsedSlots} SLOTS`), 'NO VERIFIED STREAKS YET');
      renderRows(byId<HTMLOListElement>('yahoo-rate-preview'), (board.peakYahooRate ?? []).map((row) => `${row.rank}. ${shortWallet(row.address)} — ${row.yahoosInWindow}/MIN`), 'NO VERIFIED SPEED YET');
      byId('yahoo-footer-state').textContent = board.asOfSlot ? `FINALIZED THROUGH SLOT ${board.asOfSlot}` : 'PRE-LAUNCH · NO ON-CHAIN YAHOOS';
    }
  } catch (error) {
    console.error(error);
    byId('yahoo-program-state').textContent = 'RECORD OFFLINE';
    byId('yahoo-program-copy').textContent = 'Public YAHOO verification is unavailable. Do not submit anything.';
  }
}

void start();
