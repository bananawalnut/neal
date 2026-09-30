# Build status

## Completed

- End-to-end master plan and component architecture
- Decision record and threat model
- Versioned `neal.launch-control/v1` contract
- Backward-compatible integer-lamport migration path
- Rust launch-readiness guard with tests
- Public-record privacy projection
- Vanilla TypeScript pre-launch verification site
- Public treasury explainer with the actual dev-purchase, quest, and open-source-developer airdrop flow
- Public NEALonomics loop and fail-closed 1-NEAL-or-1-DREGG community-suggestion ballot box
- Active, all-free browser-local YAHOO button with local persistence and no wallet or token transaction
- Three-board local hover/focus overlay on the single launch page, covering local total, fastest local three-YAHOO streak, and local 60-second top speed
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
- Pump V2 creator-fee sharing is contractually planned at 58% dev / 42% treasury; both recipients are recorded and the one-time final update waits for the canonical mint
- Community/product decision on whether YAHOOS should ever move on-chain, followed by a reviewed program, indexer, and wallet transaction builder only if approved
- Castalia Wallet Standard and Mobile Wallet Adapter conformance testing when its implementation repository is available
- CoinDesk Tauri transaction-visualization implementation after its repository is attached; the portable initiative is recorded in `docs/initiatives/002-coindesk-neal-transaction-visualization.md`

## Current launch blockers

The Rust guard currently reports one blocker:

1. A new launch date and time; the earlier Pacific launch window elapsed before the mandatory simulation and Phantom review could complete

Warnings remain for the open-source-developer eligibility policy, suggestion registry, deliberately deferred on-chain YAHOO program, and unconfirmed treasury inventory.

Separate access-stake blockers: wallet signatures are cryptographically verified in the current tab, but durable authentication is intentionally not claimed until the single-use nonce challenge and server verification endpoints are deployed. The approved production terms are 69,000 NEAL (69,000,000,000 atomic units at six decimals) with a fixed 90-day (7,776,000-second) minimum lock. Program/config IDs, issuer deployment, devnet rehearsal, backup/restore drill, and independent security review are still required before `accessStake.status` can become `active`.

The image gate is cleared by user attestation: the approved master is `assets/final/neal-token.png`, recorded in `launch-config.json`, and copied into the public site's static assets. See `assets/source/SOURCES.md` for the provenance record.

Pump.fun cashback is explicitly off. The dev buys NEAL from the market. The treasury uses 42% of creator fees for market buys funding quests and open-source-developer airdrops; its airdrop-earmarked NEAL balance is capped at 18% of finalized total supply at all times unless every NEAL holder approves more. No override exists until a reviewed unanimity mechanism is published. The treasury also receives the selected 1-NEAL or 1-DREGG community-suggestion entry once that program is active. DREGG stays unavailable until its canonical mint is verified. No balance, inventory, eligibility, suggestion receipt, or distribution is represented as confirmed until its public record exists.

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
# Launch-console implementation

- The local operations console now builds Pump V2 creation or creation-plus-buy instructions with the pinned official SDK, applies the operator's value as a hard SOL ceiling, simulates before signing, and requests approval from Phantom through Wallet Standard; Phantom may in turn use a Ledger-backed account.
- Immutable metadata and image files are generated from `launch-config.json`; a remote byte-for-byte verifier blocks release when the deployed files are absent or different.
- The confirmed receipt recorder checks the Solana transaction before atomically publishing the canonical mint/signature pair into the private launch record.
- The remote metadata and image are deployed and verify byte-for-byte. The banner and final website/GitHub links are now staged for the next deployment verification pass.
