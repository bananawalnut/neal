# NEAL master build and launch plan

## Objective

Launch one canonical `NEAL` mint through Pump.fun, publish an authoritative verification surface, and operate quests only against NEAL bought by the disclosed quest treasury. Tidemark remains generic and never creates a second NEAL mint.

## System map

```text
Final metadata + creator decisions
                 |
                 v
        Rust launch-readiness guard
                 |
          no blockers allowed
                 |
                 v
Human-reviewed Pump.fun transaction -----> canonical NEAL mint
                 |                                  |
                 |                                  +--> public verification site
                 |                                  +--> monitoring / status records
                 |                                  +--> disclosed program inventory
                 |                                               |
                 |                1-NEAL-or-1-DREGG suggestions + quest rewards
                 |
                 +--> signed creation receipt

DREGG canonical mint + explicit price decision
                 |
                 +--> separately reviewed secondary pool, after launch only
```

## Critical path

### Phase 0 — decisions and safety gates

Deliverables:

- Versioned launch-control contract
- Rust readiness report with machine-enforced blockers
- Decision log and threat model
- Legal/name/art review gate
- Wallet and fee-recipient decision without storing private keys

Exit gate: the readiness report has zero blockers and all warnings are explicitly accepted.

### Phase 1 — identity and public verification

Deliverables:

- Final 1000 × 1000 or larger token image
- Optional banner
- Immutable description and public links
- Vanilla TypeScript public site with a pre-launch state
- Post-launch canonical mint and transaction verification state
- Signed checksum bundle of all immutable launch assets

Exit gate: copy and assets are frozen, rights-cleared, checksummed, and reviewed in the exact Pump.fun preview.

### Phase 2 — launch executor and operations console

Deliverables:

- Read-only Pump.fun state adapter using the official SDK
- Offline instruction preview for create or create-and-buy
- Live curve quote for the dev purchase, including integer-lamport budget and slippage cap
- RPC simulation and fee/slippage display
- Wallet-standard signing boundary; no seed phrases or private keys
- Final human confirmation interlock
- Creation receipt with mint, signature, slot, metadata hash, creator, and fee recipient

Exit gate: a rehearsal produces a deterministic preview and cannot submit without the connected wallet’s explicit signature.

### Phase 3 — treasury and program inventory

Deliverables:

- Treasury address policy, preferably multisig
- On-chain balance and transaction ledger
- Clear separation of dev, operations, and quest-treasury inventory
- Public distinction between creator-fee revenue, settled treasury buybacks, and confirmed quest balances
- No program announcement until inventory is proven

Exit gate: every advertised reward is backed by a recorded token account and approved program budget.

### Phase 4 — quests

Deliverables:

- Quest definitions, seasons, eligibility, anti-sybil policy, and appeals process
- Public community-suggestion registry and moderation trail
- Exact 1-NEAL-or-1-DREGG entry transaction routed to the published quest treasury
- Independent canonical-mint gate for each accepted entry asset
- Community support signal separated from Lord NEAL's final quest decree
- Append-only completion ledger
- Public quest briefs, reward budgets, proof rules, and payout receipts
- Rate limits, replay protection, expiry, and pause procedure

Exit gate: testnet rehearsal, independent transaction-builder review, destination-wallet assertion, registry reconciliation, reconciliation of quest rewards to funded inventory, and incident-response drill.

### Phase 4B — YAHOOS

Current deliverables:

- All-free local YAHOO button with browser-local persistence
- Local total, fastest-three, and rolling 60-second top-speed records
- Explicit local/not-on-chain labelling across the home page, YAHOO Yard, and tables
- Open decision issue for any future wallet, token, on-chain, or global form

Possible future work, not yet approved:

- Wallet-linked or on-chain YAHOOS
- Global indexing and leaderboards
- Daily limits, token pricing, or treasury routing
- Slot-based verification, replay protection, and sybil policy
- Public pause, upgrade-authority, reconciliation, and incident procedures

Exit gate: devnet clock-boundary tests, exact decimal conversion tests for both mints, same-slot replay rejection, indexer replay/reorg tests, independent program review, and human wallet preview review.

### Phase 5 — observability and launch operations

Deliverables:

- Mint/transaction verification monitor
- Bonding-curve and graduation status
- Public status page and internal runbook
- Alerts for metadata mismatch, creator/fee changes, failed claims, and treasury movements
- Launch-day roles, timing, announcement drafts, and rollback boundaries

Exit gate: monitors work from public RPC data and alerts contain no secrets.

### Phase 6 — secondary NEAL/DREGG liquidity

Deliverables:

- Verified canonical DREGG mint
- Pool venue, initial price, quantities, slippage, and custody decision
- Public disclosure that this is a secondary, non-canonical pool
- Separate transaction simulation and human signing gate

Exit gate: independent review of price and quantities. This phase cannot delay or alter the canonical NEAL mint.

## Definition of done

- Exactly one official NEAL mint exists.
- Immutable metadata and its checksums are public.
- The creation transaction is human-reviewed and recorded.
- The official website clearly identifies the mint and links to the transaction.
- Quest balances are funded before they are advertised.
- Every paid suggestion is publicly recorded or automatically refundable; a fee never implies adoption or reward.
- Every YAHOO shown in a ranking resolves to an accepted event from the published program at finalized commitment.
- No private key enters source code, browser storage, logs, WASM, CI, or a hosted service.
- Every on-chain program has passed testnet QA and independent review before mainnet use.
- DREGG remains deferred until its mint and pool terms are explicit.
