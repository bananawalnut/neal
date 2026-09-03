# NEAL threat model

## Assets to protect

- Canonical mint identity and immutable metadata
- Dev, fee, treasury, and quest balances
- Launch and claim transaction integrity
- Eligibility records and claimant privacy
- Public trust in official links and disclosures

## Highest-priority threats

| Threat | Primary control |
| --- | --- |
| Imposter mint or copied site | Publish one mint and creation signature from pre-committed official channels |
| Metadata typo or malicious link | Asset freeze, checksums, exact preview review, two-person approval |
| Seed phrase or private-key theft | Wallet-standard signing only; never accept or persist secrets |
| Fake wallet connection treated as login | Distinguish connected, locally signature-verified, server-authenticated, and holder-verified states |
| SIWS replay or cross-site signature phishing | Server-issued single-use nonce, domain and URI binding, five-minute expiry, request ID, and server-side Ed25519 verification |
| Wallet account changes after authentication | Subscribe to `standard:events`; clear identity and holder proofs immediately when the account changes |
| Stale or fabricated holder status | Read the canonical mint at finalized commitment, record the slot, bind it to a wallet-proof digest, and re-check for gated actions |
| Malicious or unavailable RPC | Treat holder proof as unavailable on RPC errors; never infer a balance; support independent RPC verification before launch |
| Address privacy leakage | Keep identity state in memory; make RPC holder checks explicit; do not add analytics, email identity, or address storage by default |
| Compromised dependency | Exact pins, lockfiles, provenance review, simulation, minimal SDK surface |
| Front-running or unexpected create-and-buy terms | Display exact instructions, limits, fees, and initial purchase before signing |
| Hidden or free dev allocation | Require the dev's holdings to come from disclosed market purchases and publish the actual fill, spend, wallet, and receipt |
| Treasury single-key loss | Multisig custody and separated operational budgets |
| Unfunded reward promises | Inventory reconciliation gate before publication |
| Suggestion form charges without a durable record | Keep entry disabled until the public registry is writable; require an atomic payment-and-record flow or automatic refund |
| Suggestion fee uses an impostor treasury or DREGG mint | Build only from the public quest-treasury and canonical-mint records, show both mint and destination before signing, and assert both in the reviewed transaction builder |
| Suggestion spam, abuse, or paid-vote confusion | One-token entry policy, published moderation and appeals, clear separation between community support and NEAL's quest decision |
| Airdrop inventory exceeds 18% or is relabelled to evade the cap | Sum every treasury token account and purpose-labelled subaccount at finalized commitment; block new airdrop buys when earmarked holdings reach 18% of finalized supply; require a public proof of unanimous approval from all NEAL holders before accepting a higher cap |
| Fake or privacy-invasive open-source-developer eligibility | Publish objective eligibility, review, disclosure-minimization, sybil-resistance, and appeals rules before collecting submissions or distributing NEAL |
| Local YAHOOS mistaken for global or on-chain proof | Label every current table as local to this browser, never use local records for rewards or governance, and keep future policy explicitly undecided |
| Local storage is cleared, edited, or copied | Treat local records as disposable entertainment rather than trusted data; promise no durability, portability, uniqueness, or anti-cheat property |
| Future wallet or token rules inherit an obsolete draft | Require an explicit decision and contract review before enabling any charge, wallet gate, global rank, or on-chain claim |
| Missing or unstable timestamps distort top speed | Rate board consumes only finalized block times, excludes unresolved timestamps until reconciliation, uses a fixed rolling 60-second window, and resolves boundary ties deterministically |
| Fake or reorged leaderboard entries | Index only the published program at finalized commitment; record `asOfSlot`; rebuild deterministically from events |
| Wrong paid-YAHOO mint, amount, or treasury | Resolve canonical mint and treasury accounts from the public record, use integer atomic math, show all accounts before signing, and assert them in-program |
| UTC allowance boundary disagreement | Derive the day exclusively from Solana Clock Unix time; test before, at, and after the boundary |
| Sybil farming | Published eligibility rules, rate limits, clustering review, appeals |
| Merkle root over-allocation | Deterministic builder, independent recomputation, total-to-inventory assertion |
| Double claim or replay | On-chain claim state and domain-separated proofs |
| Malicious admin changing eligibility | Append-only signed snapshots and published root history |
| DREGG spoof mint | Exact mint verification and a separate pool decision record |
| Price manipulation or misleading promotion | No guaranteed-return language, wash trading, multi-wallet activity, or undisclosed paid promotion |

## Mandatory incident responses

- Wrong metadata before signing: cancel; rebuild the transaction.
- Wrong metadata after signing: do not create a replacement NEAL mint; publish the facts and obtain legal/security advice.
- Wallet compromise before launch: rotate addresses and invalidate the readiness report.
- Wallet compromise after launch: move controllable treasury funds through the approved recovery process and publish affected addresses.
- Bad claim root before activation: replace the unsigned artifact and rerun reconciliation.
- Bad claim root after activation: invoke only a pre-reviewed pause mechanism, publish the incident, and do not silently rewrite eligibility.
- Registry unavailable, wrong selected mint, or payment-record mismatch: pause new suggestions, reconcile the transaction, and refund according to the published policy.
- YAHOO indexer mismatch or same-slot acceptance: pause rankings, preserve raw events, publish the affected slot range, and rebuild from finalized chain history.
