import './styles.css';
import './yahoos.css';
import { formatLocalStreak, getLocalYahooStats, onLocalYahooChange, type LocalYahooStats } from './local-yahoos';

type LaunchRecord = {
  schema: 'neal.public-record/v1';
  programs: {
    yahoos?: {
      localMode?: { enabled: boolean; price: 'free' };
    } | null;
  };
};

type LeaderboardRecord = {
  schema: 'neal.yahoo-leaderboard/v1';
  status: string;
  programId: string | null;
  asOfSlot: number | null;
  fastestConsecutiveCount: number;
  peakRateWindowSeconds?: number;
  totalYahoos: Array<{ rank: number; address: string; totalYahoos: string }>;
  fastestConsecutiveYahoos: Array<{ rank: number; address: string; elapsedSlots: number }>;
  peakYahooRate?: Array<{ rank: number; address: string; yahoosInWindow: number }>;
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main class="shell yahoo-page leaderboard-page">
    <nav class="topbar yahoo-nav">
      <a class="brand" href="/"><span class="brand-orb"><img src="/neal-token.png" alt="" /></span><span>NEAL</span><small>THE TABLES</small></a>
      <div class="nav-links"><a href="/yahoos/">Yahoos</a><a class="active" href="/leaderboards/">Leaderboards</a><a href="/#community-vote">Vote</a><a href="/#verify">Proof</a></div>
      <a class="wallet-button" href="/#wallet-identity">CONNECT WALLET</a>
    </nav>

    <header class="leaderboard-hero">
      <div><p class="eyebrow">LOCAL YAHOOS / FREE FOR NOW</p><h1>YOUR BIGGEST<br><em>YAHOOS.</em></h1></div>
      <aside><span>RECORD SCOPE</span><strong id="board-state">THIS BROWSER</strong><small id="board-slot">SAVED ON THIS DEVICE</small></aside>
    </header>

    <section class="leaderboard-grid">
      <article class="leaderboard-card total-board">
        <header><div><span>THIS BROWSER'S CARRY-ON</span><h2>MOST LOCAL YAHOOS</h2></div><b>∞</b></header>
        <ol id="total-board"><li class="empty-row">NO LOCAL YAHOOS YET</li></ol>
      </article>
      <article class="leaderboard-card speed-board">
        <header><div><span>THE THREE-YAHOO SPRINT</span><h2>FASTEST LOCAL 3-YAHOO STREAK</h2></div><b>3×</b></header>
        <ol id="speed-board"><li class="empty-row">NO LOCAL STREAK YET</li></ol>
      </article>
      <article class="leaderboard-card rate-board">
        <header><div><span>ROLLING 60-SECOND LOCAL RECORD</span><h2>LOCAL TOP SPEED</h2></div><b>60s</b></header>
        <ol id="rate-board"><li class="empty-row">NO LOCAL SPEED YET</li></ol>
      </article>
    </section>

    <section class="leaderboard-method">
      <p class="eyebrow">HOW THE BLOODY THING WORKS FOR NOW</p>
      <h2>LOCAL RACKET.<br>ZERO TOKENS.</h2>
      <div>
        <p><strong>MOST LOCAL YAHOOS</strong> counts every free button smash saved by this browser.</p>
        <p><strong>FASTEST LOCAL THREE</strong> measures the browser time between your first and third consecutive local YAHOO.</p>
        <p><strong>LOCAL TOP SPEED</strong> is your biggest burst inside any rolling 60-second window, shown as YAHOOS/MIN.</p>
        <p><strong>NO BULLSHIT</strong> these records are local, not verified, not global, and not on-chain. Future rules remain undecided.</p>
      </div>
      <a href="/yahoos/">BACK TO THE BIG RED BUTTON ↗</a>
    </section>

    <footer><span>NEAL / GOOD CUNT</span><span>LOCAL BROWSER RECORD · NOT ON-CHAIN</span></footer>
  </main>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const shortWallet = (address: string): string => address === 'THIS BROWSER' ? address : address.length > 16
  ? `${address.slice(0, 7)}…${address.slice(-7)}`
  : address;

function renderBoard(target: HTMLOListElement, rows: Array<{ rank: number; address: string; value: string }>, empty: string) {
  target.replaceChildren();
  if (!rows.length) {
    const item = document.createElement('li');
    item.className = 'empty-row';
    item.textContent = empty;
    target.append(item);
    return;
  }
  for (const row of rows) {
    const item = document.createElement('li');
    const rank = document.createElement('b');
    const wallet = document.createElement('span');
    const value = document.createElement('strong');
    rank.textContent = row.rank.toString().padStart(2, '0');
    wallet.textContent = shortWallet(row.address);
    value.textContent = row.value;
    item.append(rank, wallet, value);
    target.append(item);
  }
}

function renderLocalBoards(stats: LocalYahooStats) {
  byId('board-state').textContent = 'THIS BROWSER';
  byId('board-slot').textContent = stats.lastAt ? `LAST YAHOO ${new Date(stats.lastAt).toLocaleTimeString()}` : 'NO LOCAL YAHOOS YET';
  renderBoard(byId<HTMLOListElement>('total-board'), stats.total ? [{ rank: 1, address: 'THIS BROWSER', value: `${stats.total.toLocaleString()} YAHOOS` }] : [], 'NO LOCAL YAHOOS YET');
  renderBoard(byId<HTMLOListElement>('speed-board'), stats.fastestThreeMs === null ? [] : [{ rank: 1, address: 'THIS BROWSER', value: formatLocalStreak(stats.fastestThreeMs) }], 'NO LOCAL STREAK YET');
  renderBoard(byId<HTMLOListElement>('rate-board'), stats.peakPerMinute ? [{ rank: 1, address: 'THIS BROWSER', value: `${stats.peakPerMinute} YAHOOS/MIN` }] : [], 'NO LOCAL SPEED YET');
}

async function start() {
  try {
    const launchResponse = await fetch('/launch-record.json', { cache: 'no-store' });
    if (!launchResponse.ok) throw new Error(`Launch record returned ${launchResponse.status}`);
    const launch = await launchResponse.json() as LaunchRecord;
    if (launch.schema !== 'neal.public-record/v1') throw new Error('Unsupported launch record schema');
    if (launch.programs.yahoos?.localMode?.enabled && launch.programs.yahoos.localMode.price === 'free') {
      renderLocalBoards(getLocalYahooStats());
      onLocalYahooChange(renderLocalBoards);
      return;
    }
    const response = await fetch('/yahoo-leaderboard.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Leaderboard returned ${response.status}`);
    const record = await response.json() as LeaderboardRecord;
    if (record.schema !== 'neal.yahoo-leaderboard/v1') throw new Error('Unsupported leaderboard schema');
    byId('board-state').textContent = record.programId ? record.status.replaceAll('_', ' ').toUpperCase() : 'PRE-LAUNCH';
    byId('board-slot').textContent = record.asOfSlot ? `FINALIZED THROUGH SLOT ${record.asOfSlot}` : 'NO FINALIZED SLOT YET';
    renderBoard(
      byId<HTMLOListElement>('total-board'),
      record.totalYahoos.map((row) => ({ rank: row.rank, address: row.address, value: `${row.totalYahoos} YAHOOS` })),
      'NO ON-CHAIN YAHOOS YET',
    );
    renderBoard(
      byId<HTMLOListElement>('speed-board'),
      record.fastestConsecutiveYahoos.map((row) => ({ rank: row.rank, address: row.address, value: `${row.elapsedSlots} SLOTS` })),
      'NO VERIFIED STREAKS YET',
    );
    renderBoard(
      byId<HTMLOListElement>('rate-board'),
      (record.peakYahooRate ?? []).map((row) => ({ rank: row.rank, address: row.address, value: `${row.yahoosInWindow} YAHOOS/MIN` })),
      'NO VERIFIED SPEED YET',
    );
  } catch (error) {
    console.error(error);
    byId('board-state').textContent = 'RECORD OFFLINE';
  }
}

void start();
