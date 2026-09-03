# NEAL launch control sheet

The complete program is defined in [the master plan](docs/MASTER_PLAN.md), with separate [architecture](docs/ARCHITECTURE.md), [decisions](docs/DECISIONS.md), [threat model](docs/THREAT_MODEL.md), [contract](docs/CONTRACT.md), and [live status](docs/STATUS.md) documents.

To open the separate pre-launch verification site on macOS, double-click `Start NEAL Site.command`. Launch and wallet actions remain fail-closed and the site states that no official mint exists; the free local YAHOO toy is interactive.

Run the Rust launch guard from this directory:

```bash
cargo run -p neal-launch-guard -- launch-config.json
```

An exit status of `2` means unresolved launch blockers remain. This is expected until the final assets, addresses, purchase amount, and schedule are supplied.

Run the separate local launch console at `http://127.0.0.1:4290/`:

```bash
npm run launcher:dev
```

The console generates the exact Pump V2 create or create-and-buy transaction with the official pinned SDK, checks the disclosed creator address, applies the selected SOL amount as a hard purchase ceiling, simulates against mainnet, and stops at an explicit Phantom approval boundary through Wallet Standard. It never stores or loads a wallet private key. A Ledger-backed account can still hand the final confirmation through Phantom. Immediately before review, verify the deployed metadata and image byte-for-byte with `npm run launcher:verify-assets`. After a confirmed launch, download the console receipt and record it with `npm run launcher:record -- /absolute/path/to/receipt.json`; the recorder verifies the confirmed transaction before atomically writing the mint and signature.

Status: **launched on Solana; direct on-site Pump buying is ready for wallet review**
Canonical route: **Pump.fun**  
Canonical mint: **`8JBYSxrFRMf1Y4NcbjyEsxGPFe4AXzHXELmXh4WYDCBE`**
Creation transaction: **`3iP9Gza1xtgAiNAdEwJz7TdV3n3VsLuNkYvFmRhWnditqN2R95r7FaU83TMSEhpjGbgNrf1YF1FKPSJ23a7onDBh`**
Custom Tidemark mint: **not NEAL**

The public site now discovers Solana wallets through Wallet Standard, puts Castalia first without creating a proprietary code path, verifies wallet control with SIWS or a signed-message fallback, and can produce finalized holder proofs after the canonical mint is published. See [the wallet identity contract](docs/WALLET_IDENTITY.md). Durable authenticated sessions remain disabled until the single-use challenge and verification endpoints are deployed.

The single launch page includes a small local YAHOO toy. YAHOOS are active now, entirely free, and stored only in the current browser. They do not require a wallet or create a transaction. Future on-chain and token rules are explicitly undecided; see [the YAHOO protocol](docs/YAHOOS.md) and [the open policy issue](docs/issues/001-decide-future-yahoo-policy.md).

## Locked decisions

- Name: `Neal the Seal`
- Ticker: `NEAL`
- Network: Solana
- Canonical mint creator: Pump.fun
- Initial quote: SOL
- Mayhem mode: off; it may change supply behavior and is inconsistent with a predictable launch
- DREGG pairing: deferred until after NEAL launches and the canonical DREGG mint is verified
- A later NEAL/DREGG pool would be secondary, not Pump.fun’s canonical pool
- SEAL: outside this launch

## Required before opening the final wallet prompt

- [x] Final square token image, at least 1000 × 1000 px and no more than 15 MB
- [x] Final description
- [x] Final website recorded (`https://nealtheseal.org`)
- [x] Final social links: website and GitHub; X intentionally omitted
- [x] Banner: hosted Open Graph artwork
- [x] Creator wallet selected and backed up (`5p7H68DeSmg7LhRg5PvTph8H8HPsaNHKWboBzsLV39eu`)
- [x] Initial creator-fee recipient confirmed
- [x] Cash-back mode confirmed off
- [x] Initial creator purchase confirmed with a 0.9999 SOL hard transaction ceiling
- [x] Launch recorded on mainnet
- [ ] Name, artwork, and copy cleared for use
- [ ] Final preview reviewed character by character

Pump.fun warns that the coin name, ticker, social links, banner, and related coin data should be chosen carefully at creation because they cannot be edited afterward. The official create screen currently accepts a square image or video and recommends a square image of at least 1000 × 1000 px.

## NEALonomics

NEAL does not use percentage-based genesis buckets. Pump.fun creates the canonical market, the dev buys his own NEAL from that market, and the treasury uses 42% of creator fees for market buys that fund quest rewards and airdrops to open-source developers. NEAL earmarked for those airdrops may not exceed 18% of total supply in the treasury at any moment unless every NEAL holder approves a higher cap. A community suggestion costs exactly 1 NEAL or 1 DREGG and sends the selected token to the treasury.

For the Pump.fun route:

- The dev purchase is a market buy, not a free allocation or fixed supply percentage.
- Pump's final V2 sharing configuration uses two recipients: 58% to the disclosed dev recipient and 42% to the disclosed quest treasury.
- The treasury uses its 42% share for disclosed NEAL market buys funding quests and open-source-developer airdrops. Airdrop-earmarked holdings are capped at 18% of total supply at all times unless every NEAL holder approves more; this is a treasury-balance ceiling, not a free allocation.
- Any fees collected before the on-chain split activates follow the same 42% obligation through public manual sweeps.
- Holders can spend 1 NEAL—or 1 DREGG after its canonical mint is verified—to publish a suggestion once the quest-treasury wallet, public registry, and reviewed transaction builder are live.
- Community support can surface an idea; Lord NEAL can turn it into a funded quest. Paying the entry fee does not promise adoption, a reward, or a vote outcome.
- Dev and treasury purchases can move the curve. Quote and simulate each material purchase before asking a wallet to sign.
- The dev wallet is `5p7H68DeSmg7LhRg5PvTph8H8HPsaNHKWboBzsLV39eu`; the treasury is `7voXHusYTMQoZgrEJBgheRPYCrG1mhwSpn1voX6r4x3q`.
- Publish actual balances, market-buy receipts, airdrop eligibility rules, recipient lists, and distribution transaction IDs.

## Launch sequence

1. Freeze the image, name, ticker, description, banner, and social URLs.
2. Open the official Pump.fun create flow and verify the domain and connected wallet.
3. Keep Mayhem off and use SOL as the initial quote unless this sheet is deliberately revised.
4. Review the preview and every immutable metadata field.
5. Set the dev's integer-lamport purchase budget and slippage cap, and show the exact Pump.fun market buy before signing.
6. Stop at the final wallet confirmation for human review.
7. Sign once, record the mint address and transaction signature, and publish them through the official channels.
8. Do not create another NEAL mint.
9. Publish the dev fill, SOL paid, and wallet alongside the creation receipt. Reconfirm the published treasury address before building any routing transaction.
10. Create Pump's fee-sharing config, review the exact 58/42 recipients, perform the one-time final update, and publish the sharing-config address plus both receipts. Manually sweep 42% of any earlier creator fees.
11. Publish each treasury market buy after it settles, labelling whether it funds quests or open-source-developer airdrops and proving the airdrop-earmarked balance remains within the live 18% supply cap.
12. Publish the 1-NEAL-or-1-DREGG suggestion policy and registry, then enable the reviewed wallet transaction only after its quest-treasury destination and selected token mint are independently verified.
13. Consider NEAL/DREGG liquidity only after DREGG’s canonical mint and the pool’s initial price are confirmed.

## Current official platform facts

- Coin creation is listed as `0 SOL / 0 USDC`; network and wallet costs remain separate.
- Graduation to PumpSwap is listed as `0.015 SOL`.
- The current create flow supports either SOL or USDC as the paired asset.
- Mayhem is a creation-time mode active for 24 hours and may increase supply.

Sources: [Pump.fun create](https://pump.fun/create), [Pump.fun fees](https://pump.fun/docs/fees), [Solana token basics](https://solana.com/docs/tokens/basics).

## Do not do

- Do not create a custom NEAL mint before or after the Pump.fun mint.
- Do not advertise quest inventory that has not been bought and received on-chain.
- Do not seed a DREGG pool before verifying the exact DREGG mint.
- Do not share a seed phrase or private key with Tidemark, a website form, or an automation.
- Do not promise price, returns, guaranteed liquidity, or exchange listings.
- Do not represent local button clicks or local tables as verified, global, durable, or on-chain YAHOOS.
