# Build status

## Completed

- End-to-end master plan and component architecture
- Decision record and threat model
- Versioned `neal.launch-control/v1` contract
- Backward-compatible integer-lamport migration path
- Rust launch-readiness guard with tests
- Public-record privacy projection
- Vanilla TypeScript pre-launch verification site
- Public quest-program explainer with the actual dev-purchase and creator-fee-funded quest-buyback flow
- Public NEALonomics loop and fail-closed 1-NEAL-or-1-DREGG community-suggestion ballot box
- Active, all-free browser-local YAHOO button with local persistence and no wallet or token transaction
- Three-board local hover/focus overlay, dedicated `/yahoos/` page, and `/leaderboards/` page covering local total, fastest local three-YAHOO streak, and local 60-second top speed
- Additive `localMode` public policy with the future on-chain policy explicitly marked undecided
- Fail-closed “no official mint” state
- Desktop and mobile browser verification
- Castalia-first, wallet-agnostic Solana Wallet Standard discovery and connection UI
- SIWS-first wallet-control proof with a signed-message compatibility fallback
- Finalized, mint-bound NEAL holder proof receipts
- Memory-only identity state and Android Mobile Wallet Adapter bridge

## In progress

- Final immutable launch copy; photographic bogan token art v1 is visually approved, rights-confirmed by user attestation, and wired into launch metadata and the public site
- Operations-console design and official Pump SDK adapter
- Single-use challenge/verification service for durable wallet-authenticated sessions
- Public suggestion registry, ranking/moderation rules, and reviewed dual-asset entry transaction builder
- Community/product decision on whether YAHOOS should ever move on-chain, followed by a reviewed program, indexer, and wallet transaction builder only if approved
- Castalia Wallet Standard and Mobile Wallet Adapter conformance testing when its implementation repository is available

## Current launch blockers

The Rust guard currently reports five blockers:

1. Final description
2. Creator wallet address
3. Creator-fee recipient address
4. Exact integer-lamport budget and slippage cap for the dev's launch purchase
5. Launch date and time

Warnings remain for missing public links, the not-yet-published dev and quest-treasury wallets, and unconfirmed quest inventory.

Separate web-app blocker: wallet signatures are cryptographically verified in the current tab, but durable authentication is intentionally not claimed until the single-use nonce challenge and server verification endpoints are deployed.

The image gate is cleared by user attestation: the approved master is `assets/final/neal-token.png`, recorded in `launch-config.json`, and copied into the public site's static assets. See `assets/source/SOURCES.md` for the provenance record.

Pump.fun cashback is explicitly off. The dev buys NEAL from the market. The quest treasury uses 42% of creator fees for NEAL buybacks and receives the selected 1-NEAL or 1-DREGG community-suggestion entry once that program is active. DREGG stays unavailable until its canonical mint is verified. Neither wallet, balance, suggestion receipt, nor transaction is represented as confirmed until its public record exists.

## Not started

- Wallet/RPC simulation console
- Treasury inventory indexer
- Quest ledger and eligibility rules
- Community-suggestion registry and on-chain entry transaction
- YAHOO program ID, treasury token accounts, program audit, and finalized leaderboard indexer
- Monitoring and alerting
- Independent contract/security review
- Mainnet transaction preparation
- Deferred DREGG pool analysis
