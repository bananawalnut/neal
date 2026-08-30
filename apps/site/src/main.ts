import './styles.css';
import { mountWalletIdentity } from './wallet';
import { formatLocalStreak, getLocalYahooStats, onLocalYahooChange, recordLocalYahoo, type LocalYahooStats } from './local-yahoos';

type PublicRecord = {
  schema: 'neal.public-record/v1';
  status: 'pre_launch' | 'launched';
  token: {
    name: string;
    symbol: string;
    description: string | null;
    website: string | null;
    socialLinks: unknown[];
  };
  launch: {
    network: string;
    canonicalRoute: string;
    quoteAsset: string;
    mayhemMode: boolean;
  };
  execution: {
    mintAddress: string | null;
    creationTransaction: string | null;
  };
  programs: {
    genesisAllocationAvailable: boolean;
    economics: {
      devPurchase: {
        method: string;
        wallet: string | null;
        transactions: string[];
      };
      questTreasury: {
        creatorFeeShareBasisPoints: number;
        purchaseMethod: string;
        wallet: string | null;
        transactions: string[];
      };
    };
    communitySuggestions: {
      entryFeeTokens: string;
      acceptedEntryAssets?: Array<{
        symbol: 'NEAL' | 'DREGG';
        amountTokens: string;
        canonicalMintSource: 'execution.mintAddress' | 'secondaryLiquidity.quoteMint';
      }>;
      destination: 'quest_treasury';
      registryUri: string | null;
      status: 'pre_launch' | 'active' | 'paused';
    } | null;
    yahoos?: {
      localMode?: {
        enabled: boolean;
        storage: 'browser_local_storage';
        price: 'free';
        rankingScope: 'this_browser';
      };
      futureOnChainPolicyStatus?: 'undecided';
      dailyFreePerWallet: number;
      dailyWindow: 'solana_clock_utc_day';
      paidPriceNumerator: string;
      paidPriceDenominator: string;
      acceptedPaymentAssets: Array<{
        symbol: 'NEAL' | 'DREGG';
        amountTokens: string;
        canonicalMintSource: 'execution.mintAddress' | 'secondaryLiquidity.quoteMint';
      }>;
      fastestConsecutiveCount: number;
      peakRateWindowSeconds?: number;
      programId: string | null;
      leaderboardRegistryUri: string | null;
      status: 'pre_launch' | 'active' | 'paused';
    } | null;
    fundingMethod: string;
    fundedInventory: unknown | null;
  };
  secondaryLiquidity: {
    enabledAtLaunch: boolean;
    plannedQuoteSymbol: string;
    quoteMint: string | null;
    status: string;
  };
};

type YahooLeaderboardRecord = {
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

let canonicalMintAddress: string | null = null;
let localYahooMode = false;

app.innerHTML = `
  <main class="shell">
    <nav class="topbar">
      <a class="brand" href="#top" aria-label="Neal the Seal home"><span class="brand-orb"><img src="/neal-token.png" alt="" /></span><span>NEAL</span><small>LOCAL UNIT</small></a>
      <div class="nav-links"><a href="#quests">Quests</a><a href="#community-vote">Vote</a><a href="/yahoos/">Yahoos</a><a href="#attitude">Lore</a><a href="#verify">Proof</a></div>
      <div class="topbar-actions">
        <a class="network-chip" id="mint-nav-state" href="#verify">NO MINT YET · CHECK HERE</a>
        <button class="wallet-button" id="wallet-button" type="button">CONNECT WALLET</button>
      </div>
    </nav>

    <header class="hero-chaos" id="top">
      <div class="hero-marquee hero-marquee--top" aria-hidden="true"><span>NOT HERE TO FUCK SPIDERS&nbsp; ✦ &nbsp;NOT HERE TO FUCK SPIDERS&nbsp; ✦ &nbsp;NOT HERE TO FUCK SPIDERS&nbsp; ✦ &nbsp;NOT HERE TO FUCK SPIDERS&nbsp; ✦</span></div>
      <div class="hero-stage">
        <div class="hero-copy">
          <p class="hero-kicker"><span>EST. TASMANIA</span><span>BUILT ON SOLANA</span><span>VIBE: UNREASONABLE</span></p>
          <h1><span>NEAL</span><em>HAS</em><strong>ENTERED</strong><i>THE CHAT</i></h1>
          <p id="description">One tonne of coastal beef. Sunnies on. Chain out. Here for elite memes, proper missions, and a deeply irresponsible amount of community spirit.</p>
          <div class="hero-actions"><a class="primary-action" href="#quests">GET IN THE QUEST PIT ↓</a><a class="secondary-action" href="/yahoos/">YAHOO YARD ↗</a><a class="secondary-action" href="#verify">CHECK THE BLOODY MINT</a></div>
        </div>

        <div class="neal-monument" aria-label="Neal the Seal wearing sunglasses and a gold chain">
          <div class="neal-halo" aria-hidden="true">BIG UNIT · BIG UNIT · BIG UNIT ·</div>
          <div class="neal-frame">
            <img src="/neal-token.png" alt="Neal the Seal wearing sunglasses and a gold chain" />
          </div>
          <img class="neal-name-tag" src="/neal-name-tag.png" alt="Hello, my name is Neal. Title: Good Cunt." />
          <span class="sticker sticker--one">ABSOLUTE<br>SCENES</span>
          <span class="sticker sticker--two">1 TONNE<br>OF TALENT</span>
          <span class="sticker sticker--three">THE<br>MONARCH</span>
        </div>
      </div>

      <div class="hero-control-deck">
        <div class="hype-console" tabindex="0" aria-label="Local YAHOO counter. Hover or focus to see this browser's records.">
          <div><p class="console-label">LOCAL YAHOOS</p><strong id="hype-count" aria-live="polite">0</strong><span>ALL FREE</span></div>
          <div class="hype-gauge" id="hype-gauge" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <button id="hype-button" type="button">LET ONE RIP</button>
          <small id="yahoo-rule-copy">Free. Saved only in this browser. No wallet. No chain. No drama.</small>
          <div class="yahoo-peek" aria-label="This browser's local YAHOO records">
            <header><span>THIS BROWSER'S BIGGEST YAHOOS</span><b>LOCAL</b></header>
            <div><strong>MOST LOCAL YAHOOS</strong><ol id="yahoo-top-total"><li><span>NO LOCAL YAHOOS YET</span><b>—</b></li></ol></div>
            <div><strong>FASTEST LOCAL 3-YAHOO STREAK</strong><ol id="yahoo-top-fast"><li><span>NO LOCAL STREAK YET</span><b>—</b></li></ol></div>
            <div><strong>LOCAL TOP SPEED</strong><ol id="yahoo-top-rate"><li><span>NO LOCAL SPEED YET</span><b>—</b></li></ol></div>
            <a href="/leaderboards/">OPEN THE FULL BLOODY TABLE ↗</a>
          </div>
        </div>

        <div class="hero-quests" aria-labelledby="hero-quests-title">
          <div class="hero-quests-head"><div><span>THE KINGDOM / QUESTS</span><h2 id="hero-quests-title">The mob pitches. LORD NEAL seals the decree.</h2></div><b>GC COMING SOON</b></div>
          <a class="hero-quest-callout" href="#quest-process"><strong>JOIN THE ARMY OF DEBAUCHERY. CAUSE A SCENE.</strong><small>Community quests + submission streams coming</small></a>
        </div>
      </div>
      <div class="hero-marquee hero-marquee--bottom" aria-hidden="true"><span>LONG LIVE NEAL ✦ THE MOB IS YAPPING ✦ ARMY OF DEBAUCHERY ✦ CAUSE A SCENE ✦ LONG LIVE NEAL ✦ COMMUNITY QUESTS ARE COMING ✦</span></div>
    </header>

    <section class="wallet-identity" id="wallet-identity" aria-labelledby="wallet-title">
      <div class="wallet-identity-copy">
        <p class="eyebrow">WALLET FIRST / NO EMAIL CARRY-ON</p>
        <h2 id="wallet-title">PROVE YOUR BAG.<br><em>JOIN THE MOB.</em></h2>
        <p>Your wallet is your identity. A signature proves you control it. Solana proves whether it holds NEAL. Castalia gets pride of place, but any standards-compliant Solana wallet gets through the same gate.</p>
        <div class="wallet-standard-note"><strong>CASTALIA FIRST.</strong><span>NOT CASTALIA-ONLY.</span></div>
      </div>
      <div class="wallet-proof-board">
        <p class="wallet-status idle" id="wallet-status" role="status">Not connected. Your identity stays in your wallet.</p>
        <div class="wallet-proof-grid">
          <article><span>WALLET</span><strong id="wallet-provider">—</strong></article>
          <article><span>ADDRESS</span><strong id="wallet-address">—</strong></article>
          <article><span>IDENTITY PROOF</span><strong id="wallet-auth-state">—</strong></article>
          <article><span>NEAL BALANCE</span><strong id="wallet-balance">WAITS FOR MINT</strong></article>
          <article><span>FINALIZED SLOT</span><strong id="wallet-slot">—</strong></article>
        </div>
        <div class="wallet-capability-row"><span>WALLET CAPABILITIES</span><div id="wallet-capabilities"><span>SIWS</span><span>MESSAGES</span><span>SIGN TX</span><span>SEND TX</span></div></div>
        <div class="wallet-actions">
          <button id="wallet-connect" type="button">PICK A WALLET</button>
          <button id="wallet-verify" type="button" hidden>PROVE THIS WALLET</button>
          <button id="wallet-holder-check" type="button" hidden>HOLDER PROOF AFTER LAUNCH</button>
          <button id="wallet-copy-proof" type="button" hidden>COPY PROOF RECEIPT</button>
          <button id="wallet-disconnect" class="quiet" type="button" hidden>DISCONNECT</button>
        </div>
        <small class="wallet-privacy">No account database. No email. No password. Identity proofs live in memory only; holder checks read public Solana state when you ask.</small>
      </div>
    </section>

    <section class="attitude" id="attitude">
      <div class="attitude-lead"><p class="eyebrow">The NEAL thesis / written in sand</p><h2>Not here to<br>fuck spiders.</h2><span>A one-tonne monument to having a crack.</span></div>
      <div class="attitude-grid">
        <article><span>COMMANDMENT 01</span><h3>MAKE<br>A RACKET</h3><p>Cook something funny, useful, or gloriously cooked. Beige behaviour can get in the bin.</p></article>
        <article><span>COMMANDMENT 02</span><h3>PULL YOUR<br>WEIGHT</h3><p>The mob rewards people who have a crack—not mystery wallets farming imaginary points.</p></article>
        <article><span>COMMANDMENT 03</span><h3>SHOW THE<br>RECEIPTS</h3><p>Big claims need public proof. Quest work, reward wallets, and the one real mint. No sauce? Rack off.</p></article>
      </div>
    </section>

    <section class="verification" id="verify" aria-live="polite">
      <div class="verification-head">
        <div><p class="eyebrow">The boring bit that saves your wallet</p><h2>Check the bloody mint.</h2><p class="verification-sub">One official address. Character for character. No vibes-based verification.</p></div>
        <span class="status-chip loading" id="status-chip"><i></i>Loading record</span>
      </div>
      <div class="record-grid">
        <article class="primary-record">
          <span class="record-label">Canonical mint</span>
          <strong id="mint-address">Checking public record…</strong>
          <button id="copy-mint" type="button" hidden>Copy mint address</button>
        </article>
        <article><span class="record-label">Network</span><strong id="network">—</strong></article>
        <article><span class="record-label">Launch route</span><strong id="route">—</strong></article>
        <article><span class="record-label">Creation transaction</span><strong id="transaction">—</strong></article>
      </div>
      <p class="record-warning" id="record-warning">Don't get stitched up. If there is no verified address here, there is no official NEAL mint. We will never guess or substitute one.</p>
    </section>

    <section class="principles" id="principles">
      <div class="real-neal-copy">
        <p class="eyebrow">Fair dinkum royal decree</p>
        <h2>THE REAL<br><em>NEAL.</em></h2>
        <p>One mint. One launch. One bloody big unit.</p>
        <a href="#verify">CHECK THE REAL SEAL <span aria-hidden="true">↗</span></a>
      </div>
      <div class="neal-decree">
        <span>LORD NEAL SEALS THE DEAL</span>
        <strong>IF IT AIN'T ON THIS SITE,<br>IT AIN'T NEAL.</strong>
        <small>Pump.fun → Solana. No DMs. No replacement mint. No seed phrase. Rack off.</small>
      </div>
      <div class="receipt-strip" aria-label="NEAL launch promises">
        <span>ONE CANONICAL MINT</span><span>PUBLIC RECEIPTS</span><span>YOUR WALLET, YOUR CALL</span>
      </div>
    </section>

    <section class="quests" id="quests">
      <div class="quests-intro">
        <div class="quests-copy">
          <p class="eyebrow">NEAL's kingdom / the GC is coming</p>
          <h2>THE MOB YAPS.<br><em>LORD NEAL SEALS THE DECREE.</em></h2>
          <p>NEAL is the monarch. Holders are the mob. Together, we're the Army of Debauchery. The GC will be the royal court: chuck in your ideas, dumb bits, good bits, and local nonsense. If the mob gets around one, NEAL might bless it as an official quest.</p>
        </div>
        <div class="program-state" id="program-state">
          <span class="record-label">NEAL's quest treasury / buybacks</span>
          <strong id="program-status">42% OF CREATOR FEES → QUEST BUYBACKS</strong>
          <p>NEAL's quest treasury uses its share of creator fees to buy NEAL for quest rewards. The wallet and every buy go up here once they exist.</p>
        </div>
      </div>

      <div class="nealonomics" aria-labelledby="nealonomics-title">
        <p class="eyebrow">THE NEAL LOOP / ACTUAL TOKENOMICS</p>
        <h3 id="nealonomics-title">ONE NEAL OR DREGG TO YAP.<br>QUESTS PAY THE MOB.</h3>
        <p class="nealonomics-truth">The dev buys his own NEAL. The mob spends 1 NEAL—or 1 DREGG once the real mint is verified—to put an idea on the ballot. It lands in the quest treasury, while 42% of creator fees buy more NEAL for quest rewards.</p>
        <div class="nealonomics-wallets" aria-label="Wallet publication status">
          <span><strong>DEV WALLET</strong><i id="dev-wallet-state">POSTS HERE ONCE LIVE</i></span>
          <span><strong>QUEST TREASURY</strong><i id="quest-wallet-state">POSTS HERE ONCE LIVE</i></span>
        </div>
        <p class="nealonomics-racket" aria-hidden="true">BUY NEAL ✦ 1 NEAL OR 1 DREGG TO YAP ✦ TREASURY BUYBACKS ✦ QUESTS PAY</p>
      </div>

      <section class="community-vote" id="community-vote" aria-labelledby="community-vote-title">
        <div class="community-vote-copy">
          <p class="eyebrow">THE MOB'S BALLOT BOX</p>
          <h3 id="community-vote-title">GOT A COOKED IDEA?<br><em>PUT ONE TOKEN ON IT.</em></h3>
          <p>A quest. A stunt. A stream. A fresh royal decree. Spend 1 NEAL or 1 DREGG to put it before the mob. If it causes enough racket, Lord NEAL can seal it.</p>
          <div class="vote-loop" aria-label="Suggestion flow"><span>1 NEAL / 1 DREGG</span><i>→</i><span>THE MOB WEIGHS IN</span><i>→</i><span>NEAL MAY COOK</span></div>
        </div>
        <form class="suggestion-entry" id="suggestion-form">
          <header><span>COMMUNITY SUGGESTION</span><strong id="suggestion-gate">PRE-LAUNCH</strong></header>
          <fieldset id="suggestion-fields" disabled>
            <label><span>NAME THE NONSENSE</span><input id="suggestion-title" name="title" maxlength="80" placeholder="EG. SEND NEAL TO PARLIAMENT" required /></label>
            <label><span>MAKE YOUR CASE</span><textarea id="suggestion-pitch" name="pitch" maxlength="500" placeholder="WHAT SHOULD NEAL DO, AND WHY WOULD THE MOB LOSE IT?" required></textarea></label>
            <div class="suggestion-assets" aria-label="Choose suggestion entry token">
              <label id="suggestion-neal-option"><input type="radio" name="entryAsset" value="NEAL" checked /><strong>1 NEAL</strong><small>THE REAL NEAL</small></label>
              <label id="suggestion-dregg-option"><input id="suggestion-dregg-input" type="radio" name="entryAsset" value="DREGG" /><strong>1 DREGG</strong><small id="suggestion-dregg-state">WAITS FOR REAL MINT</small></label>
            </div>
            <div class="suggestion-cost"><span>ENTRY</span><strong id="suggestion-entry-fee">1 NEAL OR 1 DREGG</strong><span>GOES TO</span><strong>QUEST TREASURY</strong></div>
            <button id="suggestion-submit" type="submit">PAY SELECTED TOKEN &amp; YAP</button>
          </fieldset>
          <button class="suggestion-connect" id="suggestion-connect" type="button">CONNECT WALLET TO GET READY</button>
          <p id="suggestion-status" role="status">Opens after the canonical mint, quest treasury, and public suggestion registry are live.</p>
        </form>
      </section>

      <div class="quest-process gc-manifesto" id="quest-process" aria-labelledby="quest-process-title">
        <span class="gc-coming">THE GC + QUEST STREAMS ARE COMING</span>
        <h3 id="quest-process-title">THE MOB PITCHES.<br>LORD NEAL SEALS THE DECREE.<br><em>THE ARMY CAUSES A SCENE.</em></h3>
        <p>Cook up a quest for the community. If the mob gets around it, NEAL can make it official. Some missions will be built for stream so everyone can watch the submissions roll in, roast the carry-on, cheer the lunatics, and see the winners crowned.</p>
        <a class="gc-cta" href="#community-vote"><strong>PUT ONE TOKEN ON IT <span aria-hidden="true">↗</span></strong><small>1 NEAL OR 1 DREGG</small></a>
        <div class="quest-tease" aria-label="Coming quest features"><span>COMMUNITY-COOKED QUESTS</span><span>WATCH SUBMISSIONS LIVE</span><span>REWARDS FROM NEAL'S WALLET</span></div>
      </div>

      <aside class="quest-guardrails quest-runbook">
        <div class="runbook-lead">
          <p class="eyebrow">HOW A QUEST GETS LOOSE</p>
          <h3>ONE IDEA.<br>ONE DECREE.<br>ABSOLUTE SCENES.</h3>
          <span class="guardrail-stamp">THE GC IS THE COOKER</span>
        </div>
        <ol class="quest-steps">
          <li><strong>THE GC THROWS IT IN</strong><span>Pitch the bit. If the mob gets around it, NEAL hears the racket.</span></li>
          <li><strong>LORD NEAL SEALS IT</strong><span>NEAL drops the mission, the reward, and the closing time.</span></li>
          <li><strong>THE MOB LETS RIP</strong><span>Entries roll in, the best carry-on hits stream, and winners get crowned.</span></li>
        </ol>
        <details class="quest-rules">
          <summary><span>THE FAIR DINKUM BITS</span><strong><i>OPEN THE QUEST RULES +</i><i>CLOSE THE QUEST RULES −</i></strong></summary>
          <div>
            <p>Every live quest gets a dated brief, reward, deadline, proof rules, and reviewer.</p>
            <p>No purchase, wash trading, or paid engagement disguised as participation.</p>
            <p>Eligibility, snapshot logic, limits, and appeals go up before entries close.</p>
            <p>NEAL's program wallets and every payout stay visible on-chain.</p>
          </div>
        </details>
      </aside>
    </section>

    <footer><span>NEAL / GOOD CUNT</span><span id="footer-state">CHECKING THE BORING BITS</span></footer>
  </main>

  <dialog class="wallet-dialog" id="wallet-dialog" aria-labelledby="wallet-dialog-title">
    <div class="wallet-dialog-head">
      <div><span>WALLET STANDARD / SOLANA</span><h2 id="wallet-dialog-title">PICK YOUR KEYRING.</h2></div>
      <button id="wallet-dialog-close" type="button" aria-label="Close wallet picker">×</button>
    </div>
    <p>Castalia goes first when it is installed. Every wallet below enters through the same public standard.</p>
    <div class="wallet-list" id="wallet-list"></div>
    <small>We never ask for a seed phrase. Ever. Anyone who does can rack off.</small>
  </dialog>
`;

const questsSection = app.querySelector<HTMLElement>('#quests');
const verificationSection = app.querySelector<HTMLElement>('#verify');
const attitudeSection = app.querySelector<HTMLElement>('#attitude');
if (!questsSection || !verificationSection || !attitudeSection) throw new Error('Missing primary site sections');
attitudeSection.before(questsSection);

const hypeButton = app.querySelector<HTMLButtonElement>('#hype-button');
const hypeCount = app.querySelector<HTMLElement>('#hype-count');
const hypeGauge = [...app.querySelectorAll<HTMLElement>('#hype-gauge i')];
if (!hypeButton || !hypeCount) throw new Error('Missing YAHOO controls');
const yahooButton = hypeButton;
const yahooCount = hypeCount;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

byId<HTMLButtonElement>('suggestion-connect').addEventListener('click', () => {
  byId<HTMLButtonElement>('wallet-button').click();
});
byId<HTMLFormElement>('suggestion-form').addEventListener('submit', (event) => {
  event.preventDefault();
  byId<HTMLElement>('suggestion-status').textContent = 'The real suggestion transaction builder is not live yet. Nothing was sent.';
});

const shortWallet = (address: string): string => address === 'THIS BROWSER' ? address : address.length > 10
  ? `${address.slice(0, 4)}…${address.slice(-4)}`
  : address;

function renderYahooRows(
  target: HTMLElement,
  rows: Array<{ rank: number; address: string; value: string }>,
  emptyText: string,
) {
  target.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement('li');
    const label = document.createElement('span');
    const value = document.createElement('b');
    label.textContent = emptyText;
    value.textContent = '—';
    empty.append(label, value);
    target.append(empty);
    return;
  }
  for (const row of rows.slice(0, 3)) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const value = document.createElement('b');
    label.textContent = `${row.rank}. ${shortWallet(row.address)}`;
    value.textContent = row.value;
    item.append(label, value);
    target.append(item);
  }
}

function renderYahooLeaderboard(record: YahooLeaderboardRecord) {
  renderYahooRows(
    byId<HTMLOListElement>('yahoo-top-total'),
    record.totalYahoos.map((row) => ({ rank: row.rank, address: row.address, value: row.totalYahoos })),
    'NO ON-CHAIN YAHOOS YET',
  );
  renderYahooRows(
    byId<HTMLOListElement>('yahoo-top-fast'),
    record.fastestConsecutiveYahoos.map((row) => ({ rank: row.rank, address: row.address, value: `${row.elapsedSlots} SLOTS` })),
    'NO VERIFIED STREAKS YET',
  );
  renderYahooRows(
    byId<HTMLOListElement>('yahoo-top-rate'),
    (record.peakYahooRate ?? []).map((row) => ({ rank: row.rank, address: row.address, value: `${row.yahoosInWindow}/MIN` })),
    'NO VERIFIED SPEED YET',
  );
}

function renderLocalYahooStats(stats: LocalYahooStats) {
  yahooCount.textContent = stats.total.toLocaleString();
  hypeGauge.forEach((bar, index) => bar.classList.toggle('on', index < Math.min(stats.total, hypeGauge.length)));
  renderYahooRows(
    byId<HTMLOListElement>('yahoo-top-total'),
    stats.total ? [{ rank: 1, address: 'THIS BROWSER', value: stats.total.toLocaleString() }] : [],
    'NO LOCAL YAHOOS YET',
  );
  renderYahooRows(
    byId<HTMLOListElement>('yahoo-top-fast'),
    stats.fastestThreeMs === null ? [] : [{ rank: 1, address: 'THIS BROWSER', value: formatLocalStreak(stats.fastestThreeMs) }],
    'NO LOCAL STREAK YET',
  );
  renderYahooRows(
    byId<HTMLOListElement>('yahoo-top-rate'),
    stats.peakPerMinute ? [{ rank: 1, address: 'THIS BROWSER', value: `${stats.peakPerMinute}/MIN` }] : [],
    'NO LOCAL SPEED YET',
  );
}

yahooButton.addEventListener('click', () => {
  if (!localYahooMode) return;
  renderLocalYahooStats(recordLocalYahoo());
  yahooButton.textContent = 'YAHOO!';
  window.setTimeout(() => { yahooButton.textContent = 'LET ANOTHER RIP'; }, 260);
});
onLocalYahooChange((stats) => {
  if (localYahooMode) renderLocalYahooStats(stats);
});

function present(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderRecord(record: PublicRecord) {
  if (record.schema !== 'neal.public-record/v1') {
    throw new Error('Unsupported public record schema');
  }

  const launched = record.status === 'launched'
    && Boolean(record.execution.mintAddress)
    && Boolean(record.execution.creationTransaction);
  canonicalMintAddress = launched ? record.execution.mintAddress : null;
  const status = byId<HTMLElement>('status-chip');
  status.className = `status-chip ${launched ? 'launched' : 'prelaunch'}`;
  status.innerHTML = `<i></i>${launched ? 'Canonical mint verified' : 'Pre-launch · no mint'}`;
  byId<HTMLElement>('mint-nav-state').textContent = launched ? 'MINT VERIFIED · CHECK HERE' : 'NO MINT YET · CHECK HERE';

  byId<HTMLElement>('network').textContent = present(record.launch.network);
  byId<HTMLElement>('route').textContent = present(record.launch.canonicalRoute);

  if (record.token.description) {
    byId<HTMLElement>('description').textContent = record.token.description;
  }

  const mint = byId<HTMLElement>('mint-address');
  const transaction = byId<HTMLElement>('transaction');
  const copyButton = byId<HTMLButtonElement>('copy-mint');
  if (launched && record.execution.mintAddress && record.execution.creationTransaction) {
    mint.textContent = record.execution.mintAddress;
    transaction.textContent = record.execution.creationTransaction;
    copyButton.hidden = false;
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(record.execution.mintAddress ?? '');
      copyButton.textContent = 'Copied';
      window.setTimeout(() => { copyButton.textContent = 'Copy mint address'; }, 1800);
    });
    byId<HTMLElement>('record-warning').textContent = 'Match this mint address character for character before interacting with NEAL.';
    byId<HTMLElement>('footer-state').textContent = 'CANONICAL MINT VERIFIED';
  } else {
    mint.textContent = 'Not launched — no official mint address';
    transaction.textContent = 'Not available before launch';
    byId<HTMLElement>('footer-state').textContent = 'PRE-LAUNCH · NO OFFICIAL MINT';
  }

  const questShare = record.programs.economics.questTreasury.creatorFeeShareBasisPoints / 100;
  byId<HTMLElement>('program-status').textContent = `${questShare}% of creator fees → quest buybacks`;
  byId<HTMLElement>('dev-wallet-state').textContent = record.programs.economics.devPurchase.wallet ?? 'POSTS HERE ONCE LIVE';
  byId<HTMLElement>('quest-wallet-state').textContent = record.programs.economics.questTreasury.wallet ?? 'POSTS HERE ONCE LIVE';

  const yahoos = record.programs.yahoos;
  localYahooMode = Boolean(yahoos?.localMode?.enabled && yahoos.localMode.price === 'free');
  yahooButton.disabled = true;
  if (!yahoos) {
    yahooCount.textContent = '—';
    hypeGauge.forEach((bar) => bar.classList.remove('on'));
    yahooButton.textContent = 'YAHOO POLICY MISSING';
    byId<HTMLElement>('yahoo-rule-copy').textContent = 'No public on-chain YAHOO policy is available.';
  } else if (localYahooMode) {
    yahooButton.disabled = false;
    yahooButton.textContent = 'LET ONE RIP';
    byId<HTMLElement>('yahoo-rule-copy').textContent = 'Free. Saved only in this browser. No wallet. No chain. Future rules are still up for decision.';
    renderLocalYahooStats(getLocalYahooStats());
  } else if (!launched || !yahoos.programId) {
    yahooButton.textContent = 'YAHOOS START AFTER LAUNCH';
    byId<HTMLElement>('yahoo-rule-copy').textContent = `${yahoos.dailyFreePerWallet} free per wallet daily. Then 0.1 NEAL or 0.1 DREGG.`;
  } else if (yahoos.status !== 'active') {
    yahooButton.textContent = `YAHOOS ${yahoos.status.replaceAll('_', ' ').toUpperCase()}`;
    byId<HTMLElement>('yahoo-rule-copy').textContent = 'The on-chain YAHOO program is not accepting new entries.';
  } else {
    yahooButton.textContent = 'TRANSACTION BUILDER PENDING';
    byId<HTMLElement>('yahoo-rule-copy').textContent = 'Program published. The separately reviewed wallet transaction builder is the remaining gate.';
  }

  const suggestion = record.programs.communitySuggestions;
  const suggestionAssets = suggestion?.acceptedEntryAssets?.length
    ? suggestion.acceptedEntryAssets
    : [{ symbol: 'NEAL' as const, amountTokens: suggestion?.entryFeeTokens ?? '1', canonicalMintSource: 'execution.mintAddress' as const }];
  const suggestionFee = suggestionAssets.map((asset) => `${asset.amountTokens} ${asset.symbol}`).join(' OR ');
  const acceptsDregg = suggestionAssets.some((asset) => asset.symbol === 'DREGG');
  const dreggMintReady = Boolean(record.secondaryLiquidity.quoteMint);
  const treasuryReady = Boolean(record.programs.economics.questTreasury.wallet);
  const registryReady = Boolean(suggestion?.registryUri);
  const suggestionFields = byId<HTMLFieldSetElement>('suggestion-fields');
  suggestionFields.disabled = true;
  byId<HTMLElement>('suggestion-entry-fee').textContent = suggestionFee;
  byId<HTMLButtonElement>('suggestion-submit').textContent = 'PAY SELECTED TOKEN & YAP';
  byId<HTMLElement>('suggestion-dregg-option').hidden = !acceptsDregg;
  byId<HTMLInputElement>('suggestion-dregg-input').disabled = !dreggMintReady;
  byId<HTMLElement>('suggestion-dregg-state').textContent = dreggMintReady ? 'CANONICAL MINT VERIFIED' : 'WAITS FOR REAL MINT';

  if (!suggestion) {
    byId<HTMLElement>('suggestion-gate').textContent = 'POLICY MISSING';
    byId<HTMLElement>('suggestion-status').textContent = 'No public community-suggestion policy is available.';
  } else if (!launched) {
    byId<HTMLElement>('suggestion-gate').textContent = 'PRE-LAUNCH';
    byId<HTMLElement>('suggestion-status').textContent = 'Opens after the canonical NEAL mint, quest treasury, and public suggestion registry are live. DREGG unlocks only after its real mint is verified.';
  } else if (!treasuryReady) {
    byId<HTMLElement>('suggestion-gate').textContent = 'TREASURY NEXT';
    byId<HTMLElement>('suggestion-status').textContent = 'The quest-treasury wallet must be published before any paid suggestion entry can be built.';
  } else if (!registryReady) {
    byId<HTMLElement>('suggestion-gate').textContent = 'REGISTRY NEXT';
    byId<HTMLElement>('suggestion-status').textContent = 'The public suggestion registry must be published before entries open.';
  } else if (suggestion.status !== 'active') {
    byId<HTMLElement>('suggestion-gate').textContent = suggestion.status.replaceAll('_', ' ').toUpperCase();
    byId<HTMLElement>('suggestion-status').textContent = 'Community suggestions are currently paused.';
  } else {
    byId<HTMLElement>('suggestion-gate').textContent = 'BUILDER PENDING';
    byId<HTMLElement>('suggestion-status').textContent = 'Infrastructure is recorded. The reviewed dual-token suggestion builder is the remaining gate.';
  }
}

function renderFailure() {
  canonicalMintAddress = null;
  const status = byId<HTMLElement>('status-chip');
  status.className = 'status-chip failed';
  status.innerHTML = '<i></i>Record unavailable';
  byId<HTMLElement>('mint-address').textContent = 'Verification unavailable — do not trust any mint';
  byId<HTMLElement>('transaction').textContent = 'Unavailable';
  byId<HTMLElement>('program-status').textContent = 'Quest-wallet record unavailable';
  byId<HTMLElement>('footer-state').textContent = 'VERIFICATION UNAVAILABLE';
  byId<HTMLElement>('mint-nav-state').textContent = 'MINT CHECK OFFLINE';
}

async function start() {
  try {
    const response = await fetch('/launch-record.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Public record returned ${response.status}`);
    renderRecord(await response.json() as PublicRecord);
  } catch (error) {
    console.error(error);
    renderFailure();
  } finally {
    if (!localYahooMode) {
      try {
        const leaderboardResponse = await fetch('/yahoo-leaderboard.json', { cache: 'no-store' });
        if (!leaderboardResponse.ok) throw new Error(`YAHOO leaderboard returned ${leaderboardResponse.status}`);
        const leaderboard = await leaderboardResponse.json() as YahooLeaderboardRecord;
        if (leaderboard.schema !== 'neal.yahoo-leaderboard/v1') throw new Error('Unsupported YAHOO leaderboard schema');
        renderYahooLeaderboard(leaderboard);
      } catch (error) {
        console.error(error);
        renderYahooRows(byId<HTMLOListElement>('yahoo-top-total'), [], 'LEADERBOARD UNAVAILABLE');
        renderYahooRows(byId<HTMLOListElement>('yahoo-top-fast'), [], 'LEADERBOARD UNAVAILABLE');
        renderYahooRows(byId<HTMLOListElement>('yahoo-top-rate'), [], 'LEADERBOARD UNAVAILABLE');
      }
    }
    await mountWalletIdentity(() => canonicalMintAddress);
  }
}

void start();
