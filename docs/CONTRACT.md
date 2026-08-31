# Launch-control contract

## Version

`neal.launch-control/v1` is the shared persisted contract for the launch guard, operations console, verification site, and monitoring service.

JSON fields use `camelCase`. Financial quantities use integer strings in the smallest unit to avoid floating-point ambiguity.

## Compatibility

`pumpfun.initialCreatorPurchaseLamports` is the canonical field. It is additive in v1 and accepts an integer string, including `"0"`.

The older `initialCreatorPurchaseSol` field remains readable during migration. The guard deliberately produces a blocker when only that field contains a value, forcing an explicit conversion rather than silently rounding SOL to lamports. Producers should write the lamport field and leave the legacy field null. Consumers must continue accepting the legacy field until it is formally removed in a future schema version.

`programs.economics` is additive in v1 and is the active tokenomics contract. It records a `pumpfun_market_buy` for the dev and a quest treasury funded by 42% of creator fees using `creator_fee_funded_market_buybacks`. Wallets and transaction arrays stay null or empty until those public records exist.

`programs.economics.creatorFeeRouting` is additive and optional in v1. The canonical record uses Pump's `pump_fee_sharing_v2` flow with exactly two final shareholders: 5,800 basis points to the disclosed dev recipient and 4,200 basis points to the disclosed quest treasury. Its `planned` state permits a null quest wallet because Pump's sharing configuration cannot be finalized until both the mint and destination exist. `ready_for_signature` requires both wallets. `active` additionally requires the sharing-config address plus creation and finalization receipts. `finalUpdateIsImmutable` must be true, reflecting the one-effective-update V2 flow, and `preActivationPolicy` is `manual_pro_rata_sweep` so fees received before activation still owe the disclosed 42% allocation. Older contracts without this field continue loading with a warning.

`programs.communitySuggestions` is additive in v1. It routes community-suggestion entry payments to `quest_treasury` and carries a nullable public-registry URI plus `pre_launch`, `active`, or `paused` status. `acceptedEntryAssets` adds the exact choices: one whole NEAL from `execution.mintAddress` or one whole DREGG from `secondaryLiquidity.quoteMint`. The legacy `entryFeeTokens: "1"` remains readable as a NEAL-only fallback. These fields are denominated in whole tokens because canonical mint decimals do not exist before launch; a reviewed transaction builder must read the selected canonical mint's decimals and derive the exact atomic amount without floating-point arithmetic. Older contracts without the object remain readable but block paid suggestions; contracts with only the legacy fee remain readable with a migration warning.

`programs.yahoos` is additive and optional in v1. Its active `localMode` is free, stored in browser local storage, and ranked only within this browser. `futureOnChainPolicyStatus` is `undecided`. The older allowance, payment-asset, streak-window, program-ID, and leaderboard fields remain readable for compatibility and design history, but they do not authorize a wallet prompt, charge, or on-chain claim while local mode is active. Older launch records without `localMode` continue through the legacy fail-closed path.

The old `previousTargetBasisPoints` and `currentTargetBasisPoints` fields remain readable for stored-contract compatibility, but they are optional and ignored as active economics. Their presence produces a warning. `pumpfun.initialCreatorPurchaseLamports` remains the canonical dev-purchase budget once the live curve quote is approved.

## Status lifecycle

`planned → assets_frozen → rehearsed → ready_for_signature → launched`

A status string never overrides the readiness report. The final signing UI must independently require zero blockers and a human wallet review.

## Post-launch record

`execution.mintAddress` and `execution.creationTransaction` are an atomic pair: both null before launch, both populated after confirmation. A partial execution record is invalid.

## Public projection

`neal.public-record/v1` is generated from the launch-control contract. It is additive and deliberately narrower: it exposes identity, canonical route, market-purchase economics, the planned or active Pump fee-routing state, the community-suggestion policy, public dev and quest-treasury wallet records, immutable execution receipts, program funding state, and secondary-liquidity state. It does not expose unresolved creator-wallet or scheduling fields. The public site treats a record as launched only when both execution fields are present. NEAL suggestion entry remains disabled unless the canonical mint, quest-treasury destination, public registry, active policy, and separately reviewed transaction builder are all available. The DREGG choice remains independently disabled until its canonical mint exists in the public record.

## Wallet policy and proofs

`neal.wallet-policy/v1` is an additive public contract consumed by the website and, later, Castalia conformance tests. It defines the Solana chain identifier, standard feature names, authentication preference, nonce lifetime, RPC commitment, and minimum atomic balance for holder status. Older site builds that do not read this file remain valid because it does not alter `neal.public-record/v1`.

`neal.wallet-proof/v1` proves control of one address. Its subject is `solana:mainnet/{address}`. The proof records the wallet name, standard signing method, short-lived request ID, issue and expiry times, signed message, Ed25519 signature, public key, digest, and whether verification was local or server-backed. A local proof is never represented as a durable authenticated session.

`neal.holder-proof/v1` binds a wallet-proof digest to the canonical mint, integer token balance, mint decimals, commitment, finalized or confirmed slot, and observation time. Holder status is true only when the integer balance meets the public policy threshold. It is a point-in-time observation, not a permanent role.

`neal.local-yahoos/v1` is the active device-local event record. It contains only ordered millisecond timestamps and never leaves the browser through application code. The site derives a local total, fastest consecutive three-event interval, and largest rolling 60-second burst. These values must always be labelled local and unverified.

`neal.yahoo-leaderboard/v1` remains an empty compatibility artifact for a possible future indexed mode. In local mode it publishes `mode: local_free`, `scope: this_browser`, and `futureOnChainPolicyStatus: undecided`; site consumers derive current records from local storage rather than seeding the public artifact with local clicks.

`neal.wallet-challenge-request/v1` and `neal.wallet-verification/v1` are the future server boundary. The challenge producer must issue a single-use, address-bound SIWS nonce. The verifier must validate the domain, URI, chain, address, nonce, issue time, expiry, Ed25519 signature, and nonce consumption before creating a session. See `WALLET_IDENTITY.md` for exact flow and compatibility rules.
