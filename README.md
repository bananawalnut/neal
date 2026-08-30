# NEAL launch control sheet

The complete program is defined in [the master plan](docs/MASTER_PLAN.md), with separate [architecture](docs/ARCHITECTURE.md), [decisions](docs/DECISIONS.md), [threat model](docs/THREAT_MODEL.md), [contract](docs/CONTRACT.md), and [live status](docs/STATUS.md) documents.

To open the separate pre-launch verification site on macOS, double-click `Start NEAL Site.command`. Launch and wallet actions remain fail-closed and the site states that no official mint exists; the free local YAHOO toy is interactive.

Run the Rust launch guard from this directory:

```bash
cargo run -p neal-launch-guard -- launch-config.json
```

An exit status of `2` means unresolved launch blockers remain. This is expected until the final assets, addresses, purchase amount, and schedule are supplied.

Status: **blocked on immutable launch inputs and production wallet-auth endpoints**  
Canonical route: **Pump.fun**  
Custom Tidemark mint: **not NEAL**

The public site now discovers Solana wallets through Wallet Standard, puts Castalia first without creating a proprietary code path, verifies wallet control with SIWS or a signed-message fallback, and can produce finalized holder proofs after the canonical mint is published. See [the wallet identity contract](docs/WALLET_IDENTITY.md). Durable authenticated sessions remain disabled until the single-use challenge and verification endpoints are deployed.

The site also includes the [YAHOO Yard](apps/site/yahoos/index.html) and [local leaderboards](apps/site/leaderboards/index.html). YAHOOS are active now, entirely free, and stored only in the current browser. They do not require a wallet or create a transaction. Future on-chain and token rules are explicitly undecided; see [the YAHOO protocol](docs/YAHOOS.md) and [the open policy issue](docs/issues/001-decide-future-yahoo-policy.md).

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
- [ ] Final social links, or an explicit decision to omit them
- [ ] Optional banner, or an explicit decision to omit it
- [ ] Creator wallet selected and backed up
- [ ] Creator-fee recipient confirmed
- [x] Cash-back mode confirmed off
- [ ] Initial creator purchase confirmed as zero or a disclosed amount
- [ ] Launch date and coordinated announcement time
- [ ] Name, artwork, and copy cleared for use
- [ ] Final preview reviewed character by character

Pump.fun warns that the coin name, ticker, social links, banner, and related coin data should be chosen carefully at creation because they cannot be edited afterward. The official create screen currently accepts a square image or video and recommends a square image of at least 1000 × 1000 px.

## NEALonomics

NEAL does not use percentage-based genesis buckets. Pump.fun creates the canonical market, the dev buys his own NEAL from that market, and the quest treasury uses 42% of creator fees for NEAL buybacks that fund quest rewards. A community suggestion costs exactly 1 NEAL or 1 DREGG and sends the selected token to the quest treasury.

For the Pump.fun route:

- The dev purchase is a market buy, not a free allocation or fixed supply percentage.
- The quest treasury receives 42% of creator fees and uses them for disclosed NEAL market buybacks.
- Holders can spend 1 NEAL—or 1 DREGG after its canonical mint is verified—to publish a suggestion once the quest-treasury wallet, public registry, and reviewed transaction builder are live.
- Community support can surface an idea; Lord NEAL can turn it into a funded quest. Paying the entry fee does not promise adoption, a reward, or a vote outcome.
- Dev and treasury purchases can move the curve. Quote and simulate each material purchase before asking a wallet to sign.
- Publish the dev wallet, quest-treasury wallet, actual balances, and transaction IDs after they exist.

## Launch sequence

1. Freeze the image, name, ticker, description, banner, and social URLs.
2. Open the official Pump.fun create flow and verify the domain and connected wallet.
3. Keep Mayhem off and use SOL as the initial quote unless this sheet is deliberately revised.
4. Review the preview and every immutable metadata field.
5. Set the dev's integer-lamport purchase budget and slippage cap, and show the exact Pump.fun market buy before signing.
6. Stop at the final wallet confirmation for human review.
7. Sign once, record the mint address and transaction signature, and publish them through the official channels.
8. Do not create another NEAL mint.
9. Publish the dev fill, SOL paid, and wallet alongside the creation receipt. Publish the quest-treasury wallet and each buyback after the transactions exist.
10. Publish the 1-NEAL-or-1-DREGG suggestion policy and registry, then enable the reviewed wallet transaction only after its quest-treasury destination and selected token mint are independently verified.
11. Consider NEAL/DREGG liquidity only after DREGG’s canonical mint and the pool’s initial price are confirmed.

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
