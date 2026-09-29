import './styles.css';
import { mountWalletIdentity } from './wallet';
import { mountNealPurchase } from './buy';
import { mountMatrixGc } from './matrix-gc';
import { mountMatrixAccessStake } from './access-stake';
import { formatLocalStreak, getLocalYahooStats, onLocalYahooChange, recordLocalYahoo, type LocalYahooStats } from './local-yahoos';

type PublicRecord = {
  schema: 'neal.public-record/v1';
  status: 'pre_launch' | 'launched';
  token: {
    name: string;
    symbol: string;
    metadataUri?: string | null;
    bannerUrl?: string | null;
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
        purposes?: Array<'quest_rewards' | 'open_source_developer_airdrops'>;
        openSourceDeveloperAirdrops?: {
          acquisitionMethod: 'market_buy';
          maxHoldingsSupplyBasisPoints: number;
          capMeasurement: 'airdrop_earmarked_balance_at_finalized_supply';
          capOverrideApproval: 'unanimous_neal_holder_approval';
          eligibilityPolicyUri: string | null;
          distributions: unknown[];
        };
        transactions: string[];
      };
      creatorFeeRouting?: {
        method: 'pump_fee_sharing_v2';
        status: 'planned' | 'ready_for_signature' | 'active';
        configurationAddress: string | null;
        createTransaction: string | null;
        finalizeTransaction: string | null;
        finalUpdateIsImmutable: boolean;
        preActivationPolicy: 'manual_pro_rata_sweep';
        shares: Array<{
          role: 'dev' | 'quest_treasury';
          shareBasisPoints: number;
          wallet: string | null;
        }>;
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
      <a class="brand" href="#top" aria-label="Neal the Seal home"><span class="brand-orb"><img src="/neal-favicon.png" width="96" height="96" alt="" /></span><span>NEAL</span><small>LOCAL UNIT</small></a>
      <p class="nav-meta"><span>EST. TASMANIA</span><span>BUILT ON SOLANA</span><span>VIBE: UNREASONABLE</span></p>
      <div class="topbar-actions">
        <a class="network-chip" id="mint-nav-state" href="#verify">NO MINT YET · CHECK HERE</a>
        <button class="wallet-button" id="wallet-button" type="button">CONNECT WALLET</button>
      </div>
    </nav>

    <header class="hero-chaos" id="top">
      <div class="hero-marquee hero-marquee--top" aria-hidden="true"><span>NOT HERE TO FUCK SPIDERS&nbsp; ✦ &nbsp;NOT HERE TO FUCK SPIDERS&nbsp; ✦ &nbsp;NOT HERE TO FUCK SPIDERS&nbsp; ✦ &nbsp;NOT HERE TO FUCK SPIDERS&nbsp; ✦</span></div>
      <div class="hero-stage">
        <div class="hero-copy">
          <div class="hero-intro">
            <h1><span>NEAL</span><em>HAS</em><strong>ENTERED</strong><i>THE CHAT</i></h1>
            <p id="description">One tonne of coastal beef. Sunnies on. Chain out. Here for elite memes, proper missions, and a deeply irresponsible amount of community spirit.</p>
          </div>
          <div class="hype-console" tabindex="0" aria-label="Local YAHOO counter">
            <div><p class="console-label">LOCAL YAHOOS</p><strong id="hype-count" aria-live="polite">0</strong><span>ALL FREE</span></div>
            <div class="hype-gauge" id="hype-gauge" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <button id="hype-button" type="button">LET ONE RIP</button>
            <small id="yahoo-rule-copy">Free. Saved only in this browser. No wallet. No chain. No drama.</small>
            <div class="yahoo-peek" aria-label="This browser's local YAHOO records">
              <header><span>THIS BROWSER'S BIGGEST YAHOOS</span><b>LOCAL</b></header>
              <div><strong>MOST LOCAL YAHOOS</strong><ol id="yahoo-top-total"><li><span>NO LOCAL YAHOOS YET</span><b>—</b></li></ol></div>
              <div><strong>FASTEST LOCAL 3-YAHOO STREAK</strong><ol id="yahoo-top-fast"><li><span>NO LOCAL STREAK YET</span><b>—</b></li></ol></div>
              <div><strong>LOCAL TOP SPEED</strong><ol id="yahoo-top-rate"><li><span>NO LOCAL SPEED YET</span><b>—</b></li></ol></div>
            </div>
          </div>
          <div class="hero-actions"><a class="primary-action" href="#quests">GET IN THE QUEST PIT ↓</a><a class="secondary-action buy-action" href="#buy">BUY NEAL</a><a class="secondary-action" href="#verify">CHECK THE BLOODY MINT</a><a class="secondary-action proof-action" href="#bounty-proof">SEE TEST PROOF</a></div>
        </div>

        <div class="hero-visual">
          <div class="neal-monument" aria-label="Neal the Seal wearing sunglasses and a gold chain">
            <div class="neal-halo" aria-hidden="true">BIG UNIT · BIG UNIT · BIG UNIT ·</div>
            <div class="dregg-egg" aria-hidden="true">
              <div class="dregg-egg__shell">
                <span class="dregg-egg__crack"></span>
                <span class="dregg-egg__eye"><i></i></span>
              </div>
            </div>
            <div class="neal-frame">
              <img src="/neal-token.jpg" width="1254" height="1254" loading="eager" decoding="async" fetchpriority="high" alt="Neal the Seal wearing sunglasses and a silver chain" />
            </div>
            <img class="neal-name-tag" src="/neal-name-tag.png" alt="Hello, my name is Neal. Title: Good Cunt." />
            <span class="sticker sticker--one">ABSOLUTE<br>SCENES</span>
            <span class="sticker sticker--two">1 TONNE<br>OF TALENT</span>
            <span class="sticker sticker--three">THE<br>MONARCH</span>
          </div>
        </div>
      </div>

      <div class="hero-control-deck">
        <div class="hero-quests" aria-labelledby="hero-quests-title">
          <div class="hero-quests-head"><div><span>THE KINGDOM / QUESTS</span><h2 id="hero-quests-title">The mob pitches. LORD NEAL seals the decree.</h2></div><b>FEDERATED GC · KNOCK TO JOIN</b></div>
          <a class="hero-quest-callout" href="#gc"><strong>ENTER THE NEAL MATRIX GC.</strong><small>FEDERATED · KNOCK TO JOIN ↓</small></a>
        </div>
      </div>
      <div class="hero-marquee hero-marquee--bottom" aria-hidden="true"><span>LONG LIVE NEAL ✦ THE MOB IS YAPPING ✦ ARMY OF DEBAUCHERY ✦ CAUSE A SCENE ✦ LONG LIVE NEAL ✦ COMMUNITY QUESTS ARE COMING ✦</span></div>
    </header>

    <section class="buy-pit" id="buy" aria-labelledby="buy-title">
      <div class="buy-pit-copy">
        <p class="eyebrow">LIVE ON SOLANA / OFFICIAL PUMP CURVE</p>
        <h2 id="buy-title">BUY NEAL.<br><em>JOIN THE MOB.</em></h2>
        <p>Buy from the official Pump curve without leaving NEAL's site. Your wallet remains in control, the exact transaction is simulated first, and nothing moves until you approve it.</p>
        <dl class="buy-canonical">
          <div><dt>CANONICAL MINT</dt><dd id="buy-mint">CHECKING PUBLIC RECORD…</dd></div>
          <div><dt>ROUTE</dt><dd>PUMP.FUN · SOL · TOKEN-2022</dd></div>
        </dl>
        <a class="buy-pump-link" id="buy-pump-link" href="https://pump.fun" target="_blank" rel="noreferrer">OPEN ON PUMP.FUN ↗</a>
      </div>
      <form class="buy-console" id="buy-form">
        <header><span>DIRECT NEAL BUY</span><strong id="buy-wallet-state">WALLET REQUIRED</strong></header>
        <label class="buy-amount"><span>MAXIMUM SOL TO SPEND</span><input id="buy-sol" type="text" inputmode="decimal" autocomplete="off" placeholder="0.10" /></label>
        <div class="buy-quick" aria-label="Quick maximum amounts">
          <button type="button" data-buy-sol="0.05">0.05 SOL</button>
          <button type="button" data-buy-sol="0.1">0.10 SOL</button>
          <button type="button" data-buy-sol="0.25">0.25 SOL</button>
        </div>
        <button class="buy-quote" id="buy-quote" type="button">BUILD & SIMULATE LIVE QUOTE</button>
        <section class="buy-review" id="buy-review" aria-label="NEAL purchase review" hidden>
          <dl>
            <div><dt>MINT</dt><dd id="buy-review-mint"></dd></div>
            <div><dt>QUOTED CURVE INPUT</dt><dd id="buy-review-input"></dd></div>
            <div><dt>HARD SOL MAXIMUM</dt><dd id="buy-review-max"></dd></div>
            <div><dt>ESTIMATED NEAL</dt><dd id="buy-review-output"></dd></div>
            <div><dt>NETWORK / ACCOUNT COST</dt><dd id="buy-review-fee"></dd></div>
            <div><dt>WALLET BALANCE</dt><dd id="buy-review-balance"></dd></div>
            <div><dt>SIMULATED COMPUTE</dt><dd id="buy-review-compute"></dd></div>
          </dl>
          <label class="buy-confirm"><input id="buy-reviewed" type="checkbox" /> <span>I REVIEWED THE MINT, ESTIMATE, HARD MAXIMUM AND SIMULATION.</span></label>
          <button class="buy-submit" id="buy-submit" type="button" disabled>APPROVE BUY IN WALLET</button>
        </section>
        <button class="buy-connect" id="buy-connect" type="button">CONNECT WALLET TO BUY</button>
        <p class="buy-status idle" id="buy-status" role="status">Connect a wallet and build a live quote. Nothing is signed automatically.</p>
        <a class="buy-result" id="buy-result" target="_blank" rel="noreferrer" hidden>VIEW BUY ON SOLSCAN ↗</a>
        <small>3% price-movement protection is contained inside your stated SOL maximum. Network fees and token-account rent, when needed, are additional and shown before approval. On-site buys are capped at 5 SOL; larger trades belong on Pump.</small>
      </form>
    </section>

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
        <article data-commandment="01"><span class="commandment-label">COMMANDMENT 01</span><span class="commandment-sigil" aria-hidden="true">OI!</span><h3>MAKE<br>A RACKET</h3><p>Cook something funny, useful, or gloriously cooked. Beige behaviour can get in the bin.</p><small>SEALED BY NEAL</small></article>
        <article data-commandment="02"><span class="commandment-label">COMMANDMENT 02</span><span class="commandment-sigil" aria-hidden="true">PULL</span><h3>PULL YOUR<br>WEIGHT</h3><p>The mob rewards people who have a crack—not mystery wallets farming imaginary points.</p><small>SEALED BY NEAL</small></article>
        <article data-commandment="03"><span class="commandment-label">COMMANDMENT 03</span><span class="commandment-sigil" aria-hidden="true">PROOF</span><h3>SHOW THE<br>RECEIPTS</h3><p>Big claims need public proof. Quest work, reward wallets, and the one real mint. No sauce? Rack off.</p><small>SEALED BY NEAL</small></article>
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
          <p class="eyebrow">NEAL's kingdom / the federated GC</p>
          <h2>THE MOB YAPS.<br><em>LORD NEAL SEALS THE DECREE.</em></h2>
          <p>NEAL is the monarch. Holders are the mob. Together, we're the Army of Debauchery. The federated GC is the royal court: chuck in your dumb bits, good bits, stories, and local nonsense. Every chat message feeds the NEAL egregore—the shared lore, running jokes, voice, and personality the mob builds around him. You're not issuing orders; you're helping shape what NEAL becomes. If the mob gets around an idea, NEAL might bless it as one of his official quests.</p>
        </div>
        <div class="program-state" id="program-state">
          <span class="record-label">NEAL's treasury / quests + dev drops</span>
          <strong id="program-status">42% OF CREATOR FEES → QUESTS + AIRDROPS</strong>
          <p id="fee-routing-state">The treasury market-buys NEAL for quests and airdrops to open-source devs. Airdrop holdings stay at or below 18% of supply unless every NEAL holder approves more. Wallets, buys, and drops go up here.</p>
        </div>
      </div>

      <div class="nealonomics" aria-labelledby="nealonomics-title">
        <p class="eyebrow">THE NEAL LOOP / ACTUAL TOKENOMICS</p>
        <h3 id="nealonomics-title">YAP IN THE GC.<br>NEAL'S QUESTS PAY THE MOB.</h3>
        <p class="nealonomics-truth">The dev buys his own NEAL. The mob shapes NEAL in the GC. When NEAL publishes one of his quests, its brief, reward, deadline, proof rules, and reviewer go up before anyone enters. The treasury gets 42% of creator fees, then market-buys NEAL for quests and open-source-dev airdrops. Airdrop holdings may not exceed 18% of supply unless every NEAL holder approves more.</p>
        <div class="nealonomics-wallets" aria-label="Wallet publication status">
          <span><strong>DEV WALLET</strong><i id="dev-wallet-state">POSTS HERE ONCE LIVE</i></span>
          <span><strong>QUEST TREASURY</strong><i id="quest-wallet-state">POSTS HERE ONCE LIVE</i></span>
        </div>
        <p class="nealonomics-racket" aria-hidden="true">BUY NEAL ✦ YAP IN THE GC ✦ NEAL'S QUESTS PAY ✦ OPEN-SOURCE DEVS GET DROPS</p>
      </div>

      <section class="gc-portal" id="gc" aria-labelledby="gc-title">
        <div class="gc-portal-copy">
          <p class="eyebrow">FIRST-PARTY NEAL CLIENT / FEDERATED MATRIX</p>
          <h3 id="gc-title">BRING YOUR ACCOUNT.<br>KNOCK ON THE DOOR.<br><em>JOIN THE RACKET.</em></h3>
          <p>Bring an existing account from any federated homeserver—or create one through an always-online provider. Chat with the mob, add stories and in-jokes, and help shape NEAL's egregore in real time. NEAL discovers the server and speaks Matrix directly: no Element detour and no NEAL credential backend.</p>
        </div>
        <div class="gc-room-board" id="matrix-client">
          <header class="gc-chat-header">
            <span class="gc-chat-room"><img src="/neal-favicon.png" alt="" /><span><b>NEAL GC</b><small>THE MOB · MATRIX</small></span></span>
            <strong><i aria-hidden="true"></i><span>LIVE</span></strong>
            <button class="gc-drawer-close" id="gc-drawer-close" type="button" aria-label="Close the NEAL group chat">×</button>
          </header>
          <code>#neal-gc:<wbr>matrix.nealtheseal.org</code>
          <div class="gc-room-badges" aria-label="Matrix room properties"><span>FIRST-PARTY CLIENT</span><span>KNOCK TO JOIN</span><span>FEDERATED</span><span>UNENCRYPTED</span></div>
          <ol class="matrix-public-messages" id="matrix-public-messages" aria-label="Public NEAL GC conversation">
            <li class="matrix-empty">LOADING THE PUBLIC CONVERSATION…</li>
          </ol>
          <div class="matrix-entry-tabs" id="matrix-entry-tabs" role="tablist" aria-label="Matrix account options">
            <button id="matrix-tab-login" type="button" role="tab" aria-selected="true" aria-controls="matrix-login-form">I HAVE AN ACCOUNT</button>
            <button id="matrix-tab-create" type="button" role="tab" aria-selected="false" aria-controls="matrix-create-form">CREATE AN ACCOUNT</button>
          </div>
          <button class="gc-login-toggle" id="gc-login-toggle" type="button" aria-expanded="false" aria-controls="matrix-login-form"><strong>SIGN IN TO SEND A MESSAGE</strong><span>Reading is public. Your credentials go directly to your Matrix homeserver.</span></button>
          <button class="gc-create-toggle" id="gc-create-toggle" type="button" aria-expanded="false" aria-controls="matrix-create-form"><strong>CREATE A NEAL ACCOUNT</strong><span>No email or phone. Stake NEAL to claim a short-lived, one-use access token.</span></button>
          <form class="matrix-login" id="matrix-login-form">
            <label><span>USERNAME OR MATRIX ID</span><input id="matrix-user-id" type="text" inputmode="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="neal or @you:matrix.org" required /></label>
            <label><span>PASSWORD</span><input id="matrix-password" type="password" autocomplete="current-password" placeholder="Your Matrix password" required /></label>
            <div class="matrix-login-actions">
              <button id="matrix-login" type="submit">SIGN IN TO CHAT</button>
              <button class="matrix-secondary" id="matrix-sso-login" type="button">USE HOMESERVER SIGN-IN</button>
            </div>
            <small>NEAL account? Enter just your username. Federated account? Enter the full Matrix ID. Credentials go directly to your homeserver; NEAL has no login API and stores no password.</small>
          </form>
          <form class="matrix-create" id="matrix-create-form" hidden>
            <label><span>ACCOUNT PROVIDER</span><input id="matrix-create-domain" type="text" inputmode="url" autocomplete="url" spellcheck="false" value="matrix.nealtheseal.org" list="matrix-provider-options" required /><datalist id="matrix-provider-options"><option value="matrix.nealtheseal.org"></option><option value="salix.host"></option><option value="matrix.org"></option><option value="unredacted.org"></option></datalist></label>
            <div class="matrix-provider-default"><strong>DEFAULT · MATRIX.NEALTHESEAL.ORG</strong><span>No email or phone. Account access uses a refundable NEAL stake and a short-lived, one-use token.</span></div>
            <div class="matrix-native-register" id="matrix-native-register">
              <section class="matrix-stake-access" id="matrix-stake-access" hidden aria-labelledby="matrix-stake-title">
                <div><strong id="matrix-stake-title">STAKE NEAL FOR ACCOUNT ACCESS</strong><span id="matrix-stake-terms">Stake terms load from the finalized on-chain config.</span></div>
                <p id="matrix-stake-status" role="status">Connect and verify the wallet that will hold the stake.</p>
                <div class="matrix-stake-actions">
                  <button id="matrix-stake-wallet" type="button">CONNECT WALLET</button>
                  <button id="matrix-stake-submit" type="button" hidden>STAKE NEAL</button>
                  <button id="matrix-stake-claim" type="button" hidden>CLAIM ACCESS TOKEN</button>
                  <button id="matrix-stake-release" type="button" hidden>UNSTAKE NEAL</button>
                </div>
                <small>When active, the stake is refundable after the displayed lock. One wallet/config receipt can issue one token. Creating an account does not store your wallet in Matrix.</small>
              </section>
              <div class="matrix-native-grid">
                <label><span>NEW USERNAME</span><input id="matrix-create-username" type="text" autocomplete="username" spellcheck="false" placeholder="YOUR_MATRIX_NAME" /></label>
                <label id="matrix-token-field"><span>ONE-USE ACCESS TOKEN</span><input id="matrix-create-token" type="text" autocomplete="off" spellcheck="false" placeholder="NEAL OR PROVIDER ACCESS TOKEN" /></label>
              </div>
              <div class="matrix-native-grid">
                <label><span>NEW PASSWORD</span><input id="matrix-create-password" type="password" autocomplete="new-password" placeholder="12+ CHARACTERS" /></label>
                <label><span>CONFIRM PASSWORD</span><input id="matrix-create-confirm" type="password" autocomplete="new-password" placeholder="SAME AGAIN" /></label>
              </div>
              <a class="matrix-token-link" href="https://salix.host/#matrix" target="_blank" rel="noopener noreferrer"><strong>FEDERATED ALTERNATIVE · SALIX ↗</strong><span>Independent account provider · no email or phone · self-serve token</span></a>
            </div>
            <button id="matrix-create" type="submit">CREATE MATRIX ACCOUNT</button>
            <small>For NEAL and Salix, the username, password, and access token go straight from this browser to the selected homeserver. Vercel receives and stores none of them. Other providers may open their own secure sign-up screen.</small>
          </form>
          <section class="matrix-session" id="matrix-session" hidden>
            <div class="matrix-session-head"><span>ACCOUNT <strong id="matrix-account">NOT SIGNED IN</strong></span><span>ROOM <strong id="matrix-membership">—</strong></span></div>
            <div class="matrix-room-actions"><button id="matrix-knock" type="button">KNOCK TO JOIN</button><button id="matrix-join" type="button" hidden>ACCEPT INVITE & ENTER</button></div>
            <ol class="matrix-messages" id="matrix-messages" aria-label="NEAL GC messages" hidden></ol>
            <form class="matrix-composer" id="matrix-composer" hidden><label for="matrix-message">MESSAGE THE GC</label><textarea id="matrix-message" maxlength="4000" placeholder="CHUCK SOMETHING INTO THE GC…" required></textarea><button id="matrix-send" type="submit">SEND MESSAGE</button></form>
            <aside class="matrix-moderation" id="matrix-moderation" hidden><strong>KNOCKS WAITING</strong><ul id="matrix-knocks"></ul></aside>
          </section>
          <div class="matrix-client-footer"><p id="matrix-status" role="status" data-state="idle">Loading the public conversation…</p><button id="matrix-logout" type="button" hidden>SIGN OUT</button></div>
          <p class="matrix-security-note"><strong>PUBLIC, UNENCRYPTED ROOM:</strong> anyone can read messages on the NEAL site. Sign in and join to post. Do not share secrets.</p>
        </div>
      </section>

      <div class="quest-process gc-manifesto" id="quest-process" aria-labelledby="quest-process-title">
        <span class="gc-coming">THE GC IS THE COOKER</span>
        <h3 id="quest-process-title">THE MOB PITCHES.<br>LORD NEAL SEALS THE DECREE.<br><em>THE ARMY CAUSES A SCENE.</em></h3>
        <p>Cook up a bit with the mob in the GC. If the racket catches NEAL's eye, he can publish it as one of his official quests. Some missions will be built for stream so everyone can watch the submissions roll in, roast the carry-on, cheer the lunatics, and see the winners crowned.</p>
        <a class="gc-cta" href="#gc"><strong>OPEN THE NEAL GC <span aria-hidden="true">↗</span></strong><small>LIVE · FEDERATED</small></a>
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

    <section class="bounty-proof" id="bounty-proof" aria-labelledby="bounty-proof-title">
      <header class="bounty-proof__head">
        <div>
          <p class="eyebrow">QUEST ENGINE / PUBLIC BUILD RECEIPTS</p>
          <h2 id="bounty-proof-title">DON'T TRUST THE BARK.<br><em>CHECK THE BLOODY PROOF.</em></h2>
          <p>The general-purpose bounty factory has been exercised inside a Solana validator with the official SPL Token processor. It can run ordinary bounties for any reviewed deployment; this site will use it for NEAL's quests. The suite proves the reward path, the ugly paths, and the rollback paths before a live program gets anywhere near the mob's funds.</p>
        </div>
        <div class="bounty-proof__stamp" aria-label="Current bounty factory release status">
          <span>DRAFT / V1</span>
          <strong>VALIDATOR<br>TESTED</strong>
          <small>NOT DEPLOYED · NOT AUDITED</small>
        </div>
      </header>

      <div class="proof-scoreboard" aria-label="Bounty factory verification summary">
        <article><strong>33</strong><span>RUST TESTS<br>GREEN ON MAIN</span></article>
        <article><strong>02</strong><span>VALIDATOR<br>LIFECYCLES</span></article>
        <article><strong>00</strong><span>FAILURES<br>OR IGNORES</span></article>
        <article><strong>V0</strong><span>COMPILED SBF<br>ARTIFACT PASS</span></article>
      </div>

      <div class="proof-grid">
        <article class="proof-ledger">
          <header><span>WHAT THE VALIDATOR SAW</span><strong>PASS</strong></header>
          <ol>
            <li><b>FEE DESTINATION LOCKED</b><span>The factory only accepts an authority-controlled fee token account. Self-transfer bypasses get rejected.</span></li>
            <li><b>ONE ATOMIC CREATION</b><span>Reward escrow and the fixed creation fee move together—or the whole transaction rolls back.</span></li>
            <li><b>PROOF BEFORE PAYOUT</b><span>Only the proof submitter can receive a completed bounty's full advertised reward.</span></li>
            <li><b>NO REPLAY RACKET</b><span>Completed bounties and proofs cannot be paid twice.</span></li>
            <li><b>EXPIRY MEANS REFUND</b><span>After expiry, only the creator gets the escrow back; the creation fee stays paid.</span></li>
            <li><b>PAUSE ACTUALLY PAUSES</b><span>Creation and completion stop while paused. Expired refunds remain available.</span></li>
          </ol>
        </article>

        <aside class="proof-receipt">
          <span class="proof-receipt__tape">RECEIPT / 48F2B26</span>
          <p class="record-label">LAST VERIFIED MAINLINE</p>
          <strong>COMMIT 48F2B26</strong>
          <dl>
            <div><dt>WORKSPACE SUITE</dt><dd>33 PASSED</dd></div>
            <div><dt>VALIDATOR SUITE</dt><dd>2 PASSED</dd></div>
            <div><dt>CLIPPY</dt><dd>0 WARNINGS</dd></div>
            <div><dt>CI RUN</dt><dd>#4 SUCCESS</dd></div>
          </dl>
          <code>cargo test --workspace --locked</code>
          <code>cargo clippy -p neal-bounty-factory --all-targets --locked -- -D warnings</code>
          <div class="proof-links">
            <a href="/bounty-contract.txt" target="_blank" rel="noopener">READ THE WIRE CONTRACT ↗</a>
            <a href="/bounty-testing.txt" target="_blank" rel="noopener">OPEN THE TEST MATRIX ↗</a>
          </div>
        </aside>
      </div>

      <p class="proof-caveat"><strong>FAIR DINKUM LIMIT:</strong> Validator and compiled-artifact tests are engineering evidence, not an audit. The exact deployment validator, devnet rehearsal, public program ID, transaction previews, incident runbook, and independent security review remain gates before production inventory.</p>
    </section>

    <footer><span>NEAL / GOOD CUNT</span><span id="footer-state">CHECKING THE BORING BITS</span></footer>
  </main>

  <button class="gc-drawer-backdrop" id="gc-drawer-backdrop" type="button" aria-label="Close the NEAL group chat" hidden></button>

  <aside class="gc-dock" id="gc-dock" aria-labelledby="gc-dock-title">
    <a href="#gc" aria-label="Open the NEAL Matrix group chat">
      <header><i aria-hidden="true"></i><strong id="gc-dock-title">NEAL GC</strong><span>LIVE</span></header>
      <p id="gc-dock-state" role="status">Public chat · tap to read</p>
      <ol id="gc-dock-activity" aria-label="Recent GC activity">
          <li><b aria-hidden="true">◆</b><span>Loading latest message…</span></li>
      </ol>
      <div class="gc-dock__open"><strong>Open chat</strong><span aria-hidden="true">→</span></div>
    </a>
  </aside>

  <dialog class="wallet-dialog" id="wallet-dialog" aria-labelledby="wallet-dialog-title">
    <div class="wallet-dialog-head">
      <div><span>WALLET STANDARD / SOLANA</span><h2 id="wallet-dialog-title">PICK YOUR KEYRING.</h2></div>
      <button id="wallet-dialog-close" type="button" aria-label="Close wallet picker">×</button>
    </div>
    <p>Castalia goes first when it is installed. Every wallet below enters through the same public standard.</p>
    <div class="wallet-list" id="wallet-list"></div>
    <section class="wallet-install" aria-labelledby="wallet-install-title">
      <div class="wallet-install-head">
        <strong id="wallet-install-title">GET A COMPATIBLE WALLET</strong>
        <span>OFFICIAL DOWNLOADS ONLY</span>
      </div>
      <div class="wallet-install-grid">
        <a href="https://phantom.com/download" target="_blank" rel="noopener noreferrer"><strong>PHANTOM</strong><span>BROWSER + MOBILE ↗</span></a>
        <a href="https://www.solflare.com/download/" target="_blank" rel="noopener noreferrer"><strong>SOLFLARE</strong><span>BROWSER + MOBILE ↗</span></a>
        <a href="https://backpack.app/download" target="_blank" rel="noopener noreferrer"><strong>BACKPACK</strong><span>BROWSER + MOBILE ↗</span></a>
        <a href="https://nightly.app/download" target="_blank" rel="noopener noreferrer"><strong>NIGHTLY</strong><span>BROWSER + MOBILE ↗</span></a>
      </div>
      <p><strong>LEDGER?</strong> Connect it through Phantom or Solflare. Castalia will appear automatically when its Wallet Standard build ships.</p>
    </section>
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
const yahooConsoleElement = yahooButton.closest<HTMLElement>('.hype-console');
if (!yahooConsoleElement) throw new Error('Missing YAHOO console');
const yahooConsole: HTMLElement = yahooConsoleElement;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element;
};

const gcPortal = byId<HTMLElement>('gc');
const gcBackdrop = byId<HTMLButtonElement>('gc-drawer-backdrop');
const gcClose = byId<HTMLButtonElement>('gc-drawer-close');
const gcLoginToggle = byId<HTMLButtonElement>('gc-login-toggle');
const gcCreateToggle = byId<HTMLButtonElement>('gc-create-toggle');
const gcMinimizedKey = 'neal.gc.minimized.v1';
let gcReturnFocus: HTMLElement | null = null;

const setGcDrawerOpen = (open: boolean, focusClose = false): void => {
  gcPortal.classList.toggle('gc-portal--drawer', open);
  gcBackdrop.hidden = !open;
  document.body.classList.toggle('gc-drawer-open', open);
  if (open) {
    gcPortal.setAttribute('role', 'dialog');
    gcPortal.setAttribute('aria-modal', 'true');
    if (focusClose) window.requestAnimationFrame(() => gcClose.focus());
  } else {
    gcPortal.removeAttribute('role');
    gcPortal.removeAttribute('aria-modal');
  }
};

const openGcDrawer = (trigger?: HTMLElement): void => {
  gcReturnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  sessionStorage.removeItem(gcMinimizedKey);
  if (window.location.hash !== '#gc') window.history.pushState(null, '', '#gc');
  setGcDrawerOpen(true, true);
};

const closeGcDrawer = (): void => {
  sessionStorage.setItem(gcMinimizedKey, 'true');
  if (window.location.hash === '#gc') {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  setGcDrawerOpen(false);
  gcPortal.classList.remove('gc-login-open');
  gcLoginToggle.setAttribute('aria-expanded', 'false');
  gcCreateToggle.setAttribute('aria-expanded', 'false');
  gcReturnFocus?.focus();
  gcReturnFocus = null;
};

document.querySelectorAll<HTMLAnchorElement>('a[href="#gc"]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openGcDrawer(link);
  });
});
gcClose.addEventListener('click', closeGcDrawer);
gcBackdrop.addEventListener('click', closeGcDrawer);
const openGcAccountForm = (mode: 'login' | 'create'): void => {
  gcPortal.classList.add('gc-login-open');
  const login = mode === 'login';
  gcLoginToggle.setAttribute('aria-expanded', String(login));
  gcCreateToggle.setAttribute('aria-expanded', String(!login));
  byId<HTMLButtonElement>(login ? 'matrix-tab-login' : 'matrix-tab-create').click();
  window.requestAnimationFrame(() => byId<HTMLInputElement>(login ? 'matrix-user-id' : 'matrix-create-username').focus());
};
gcLoginToggle.addEventListener('click', () => openGcAccountForm('login'));
gcCreateToggle.addEventListener('click', () => openGcAccountForm('create'));
window.addEventListener('popstate', () => setGcDrawerOpen(window.location.hash === '#gc'));
window.addEventListener('hashchange', () => setGcDrawerOpen(window.location.hash === '#gc'));
window.addEventListener('keydown', (event) => {
  if (!gcPortal.classList.contains('gc-portal--drawer')) return;
  if (event.key === 'Escape') {
    closeGcDrawer();
    return;
  }
  if (event.key !== 'Tab') return;

  const focusable = [...gcPortal.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hasAttribute('disabled') && !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
setGcDrawerOpen(window.location.hash === '#gc' || sessionStorage.getItem(gcMinimizedKey) !== 'true');

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

let yahooBurstId = 0;

function launchYahooHype() {
  const burstId = ++yahooBurstId;
  const burst = document.createElement('div');
  const stamp = document.createElement('span');
  const palette = ['var(--lime)', 'var(--aqua)', 'var(--blue)', 'var(--coral)', 'var(--pink)', 'white'];
  burst.className = 'yahoo-burst';
  burst.setAttribute('aria-hidden', 'true');
  stamp.className = 'yahoo-burst__stamp';
  stamp.textContent = 'YAHOO!';
  burst.append(stamp);

  for (let index = 0; index < 16; index += 1) {
    const particle = document.createElement('i');
    const angle = (Math.PI * 2 * index) / 16 - Math.PI / 2;
    const distance = 75 + (index % 4) * 18;
    particle.className = 'yahoo-burst__particle';
    particle.style.setProperty('--burst-x', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--burst-y', `${Math.sin(angle) * distance}px`);
    particle.style.setProperty('--burst-rotate', `${index * 47}deg`);
    particle.style.setProperty('--burst-delay', `${(index % 3) * 18}ms`);
    particle.style.setProperty('--burst-colour', palette[index % palette.length]);
    burst.append(particle);
  }

  yahooConsole.querySelectorAll('.yahoo-burst').forEach((effect) => effect.remove());
  yahooConsole.append(burst);
  yahooConsole.classList.remove('yahoo-hit');
  yahooCount.classList.remove('yahoo-count-pop');
  void yahooConsole.offsetWidth;
  yahooConsole.classList.add('yahoo-hit');
  yahooCount.classList.add('yahoo-count-pop');

  window.setTimeout(() => {
    burst.remove();
    if (burstId === yahooBurstId) {
      yahooConsole.classList.remove('yahoo-hit');
      yahooCount.classList.remove('yahoo-count-pop');
    }
  }, 900);
}

yahooButton.addEventListener('click', () => {
  if (!localYahooMode) return;
  renderLocalYahooStats(recordLocalYahoo());
  launchYahooHype();
  yahooButton.textContent = 'YAHOO!';
  window.setTimeout(() => { yahooButton.textContent = 'LET ANOTHER RIP'; }, 260);
});
yahooButton.addEventListener('dblclick', (event) => event.preventDefault());
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
  const mintNavState = byId<HTMLAnchorElement>('mint-nav-state');
  mintNavState.textContent = launched ? 'BUY NEAL · LIVE' : 'NO MINT YET · CHECK HERE';
  mintNavState.href = launched ? '#buy' : '#verify';
  byId<HTMLElement>('buy-mint').textContent = record.execution.mintAddress ?? 'NOT AVAILABLE';
  byId<HTMLAnchorElement>('buy-pump-link').href = record.execution.mintAddress
    ? `https://pump.fun/coin/${record.execution.mintAddress}`
    : 'https://pump.fun';

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
  const airdropCap = record.programs.economics.questTreasury.openSourceDeveloperAirdrops
    ? record.programs.economics.questTreasury.openSourceDeveloperAirdrops.maxHoldingsSupplyBasisPoints / 100
    : null;
  byId<HTMLElement>('program-status').textContent = `${questShare}% of creator fees → quests + dev airdrops`;
  byId<HTMLElement>('dev-wallet-state').textContent = record.programs.economics.devPurchase.wallet ?? 'POSTS HERE ONCE LIVE';
  byId<HTMLElement>('quest-wallet-state').textContent = record.programs.economics.questTreasury.wallet ?? 'POSTS HERE ONCE LIVE';
  const feeRouting = record.programs.economics.creatorFeeRouting;
  const routingCopy = byId<HTMLElement>('fee-routing-state');
  if (feeRouting?.status === 'active') {
    routingCopy.textContent = `Pump's on-chain split sends 42% to the published treasury and 58% to the dev. Treasury market buys fund quests and open-source-dev airdrops${airdropCap === null ? '' : `, with airdrop holdings capped at ${airdropCap}% of supply unless every NEAL holder approves more`}. Every receipt goes up here.`;
  } else if (feeRouting) {
    routingCopy.textContent = `Pump's 58/42 on-chain split is planned but not active yet. Both wallets are published; after the mint, the final setup sends 42% to treasury market buys for quests and open-source-dev airdrops${airdropCap === null ? '' : `, with airdrop holdings capped at ${airdropCap}% of supply unless every NEAL holder approves more`}.`;
  }

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
  byId<HTMLElement>('buy-mint').textContent = 'VERIFICATION UNAVAILABLE';
  byId<HTMLAnchorElement>('buy-pump-link').href = 'https://pump.fun';
}

async function start() {
  mountMatrixGc();
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
    const walletIdentity = await mountWalletIdentity(() => canonicalMintAddress);
    if (walletIdentity) {
      mountNealPurchase(() => canonicalMintAddress, walletIdentity);
      await mountMatrixAccessStake(() => canonicalMintAddress, walletIdentity);
    }
  }
}

void start();
