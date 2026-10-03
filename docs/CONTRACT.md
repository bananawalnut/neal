# Launch-control contract

## Version

`neal.launch-control/v1` is the shared persisted contract for the launch guard, operations console, verification site, and monitoring service.

JSON fields use `camelCase`. Financial quantities use integer strings in the smallest unit to avoid floating-point ambiguity.

`token.metadataUri` is an additive required-for-readiness field. It persists the exact HTTPS or IPFS URI passed to Pump's creation instruction so the browser preview, Rust guard, transaction builder, and post-launch receipt all refer to the same reviewed metadata. Older stored v1 contracts still deserialize because the field is optional at the decoder boundary, but they remain fail-closed until it is staged.

`token.bannerUrl` is additive and optional in v1. When a banner is included, `bannerPath` records the reviewed local source and `bannerUrl` records the public HTTPS copy; readiness requires the pair so the deployed bytes can be verified. Older records without `bannerUrl` remain readable when no banner is selected. `socialLinks` remains an array of `{ platform, url }` objects; the launch metadata currently records the official website and GitHub repository and deliberately omits X.

## Compatibility

`pumpfun.initialCreatorPurchaseLamports` is the canonical field. It is additive in v1 and accepts an integer string, including `"0"`.

The older `initialCreatorPurchaseSol` field remains readable during migration. The guard deliberately produces a blocker when only that field contains a value, forcing an explicit conversion rather than silently rounding SOL to lamports. Producers should write the lamport field and leave the legacy field null. Consumers must continue accepting the legacy field until it is formally removed in a future schema version.

`programs.economics` is additive in v1 and is the active tokenomics contract. It records a `pumpfun_market_buy` for the dev and a treasury funded by 42% of creator fees using `creator_fee_funded_market_buybacks`. The canonical public wallets are the dev address `5p7H68DeSmg7LhRg5PvTph8H8HPsaNHKWboBzsLV39eu` and treasury address `7voXHusYTMQoZgrEJBgheRPYCrG1mhwSpn1voX6r4x3q`. Transaction arrays stay empty until those public records exist.

`programs.economics.questTreasury.purposes` and `openSourceDeveloperAirdrops` are additive in v1. The canonical purposes are exactly `quest_rewards` and `open_source_developer_airdrops`. Airdrop inventory is acquired by `market_buy`. `maxHoldingsSupplyBasisPoints: 1800` caps the treasury's airdrop-earmarked NEAL balance at 18% of finalized total supply at every point in time; `capMeasurement` is `airdrop_earmarked_balance_at_finalized_supply`. `capOverrideApproval` is `unanimous_neal_holder_approval`, so no higher cap is valid without approval from every NEAL holder. Until a reviewed holder snapshot, voting, and unanimity-proof mechanism is published, the cap cannot be overridden. It does not create or imply a genesis allocation. Older stored contracts without these fields continue loading with a migration warning; malformed or contradictory populated fields block readiness. `eligibilityPolicyUri` remains null and airdrop execution remains locked until the public eligibility policy exists. Every settled distribution is appended to `distributions`.

`programs.economics.creatorFeeRouting` is additive and optional in v1. The canonical record uses Pump's `pump_fee_sharing_v2` flow with exactly two final shareholders: 5,800 basis points to the disclosed dev recipient and 4,200 basis points to the disclosed treasury. Its `planned` state continues to permit a null treasury wallet for older records. `ready_for_signature` requires both wallets. `active` additionally requires the sharing-config address plus creation and finalization receipts. `finalUpdateIsImmutable` must be true, reflecting the one-effective-update V2 flow, and `preActivationPolicy` is `manual_pro_rata_sweep` so fees received before activation still owe the disclosed 42% allocation. Older contracts without this field continue loading with a warning.

`programs.communitySuggestions` is additive in v1. It routes community-suggestion entry payments to `quest_treasury` and carries a nullable public-registry URI plus `pre_launch`, `active`, or `paused` status. `acceptedEntryAssets` adds the exact choices: one whole NEAL from `execution.mintAddress` or one whole DREGG from `secondaryLiquidity.quoteMint`. The legacy `entryFeeTokens: "1"` remains readable as a NEAL-only fallback. These fields are denominated in whole tokens because canonical mint decimals do not exist before launch; a reviewed transaction builder must read the selected canonical mint's decimals and derive the exact atomic amount without floating-point arithmetic. Older contracts without the object remain readable but block paid suggestions; contracts with only the legacy fee remain readable with a migration warning.

`programs.yahoos` is additive and optional in v1. Its active `localMode` is free, stored in browser local storage, and ranked only within this browser. `futureOnChainPolicyStatus` is `undecided`. The older allowance, payment-asset, streak-window, program-ID, and leaderboard fields remain readable for compatibility and design history, but they do not authorize a wallet prompt, charge, or on-chain claim while local mode is active. Older launch records without `localMode` continue through the legacy fail-closed path.

The old `previousTargetBasisPoints` and `currentTargetBasisPoints` fields remain readable for stored-contract compatibility, but they are optional and ignored as active economics. Their presence produces a warning. `pumpfun.initialCreatorPurchaseLamports` remains the canonical dev-purchase budget once the live curve quote is approved.

## Status lifecycle

`planned → assets_frozen → rehearsed → ready_for_signature → launched`

A status string never overrides the readiness report. The final signing UI must independently require zero blockers and a human wallet review.

## Post-launch record

`execution.mintAddress` and `execution.creationTransaction` are an atomic pair: both null before launch, both populated after confirmation. A partial execution record is invalid.

## Public projection

`neal.public-record/v1` is generated from the launch-control contract. It is additive and deliberately narrower: it exposes identity (including the additive nullable `token.metadataUri`), canonical route, market-purchase economics, treasury purposes and airdrop cap, the planned or active Pump fee-routing state, the community-suggestion policy, public dev and treasury wallet records, immutable execution receipts, program funding state, and secondary-liquidity state. It does not expose unresolved scheduling fields. Older public records without `token.metadataUri` remain readable. The public site treats a record as launched only when both execution fields are present. NEAL suggestion entry remains disabled unless the canonical mint, treasury destination, public registry, active policy, and separately reviewed transaction builder are all available. The DREGG choice remains independently disabled until its canonical mint exists in the public record.

## Wallet policy and proofs

`neal.wallet-policy/v1` is an additive public contract consumed by the website and, later, Castalia conformance tests. It defines the Solana chain identifier, standard feature names, authentication preference, nonce lifetime, RPC commitment, and minimum atomic balance for holder status. Older site builds that do not read this file remain valid because it does not alter `neal.public-record/v1`.

`neal.devnet-manual-runtime/v1` is a localhost-only, four-hour public projection
for isolated Chrome acceptance. It binds one exact source commit, expiry,
disposable browser public key, immutable program and hash, manual config,
issuer, test mint, approved 69,000/120-second terms, strict 2-of-3 verification,
and isolated Matrix server/room identifiers. It contains no RPC URL, key,
password, token, cookie, or filesystem path. The browser accepts it only from
`localhost` or `127.0.0.1`, only for `solana:devnet`, and only before expiry.
The gateway derives a temporary `neal.wallet-policy/v1` from this projection;
the committed mainnet policy and the separate single-RPC preview policy remain
unchanged. Older production consumers never request this runtime endpoint.

`neal.devnet-manual-readiness/v1` is the sanitized acceptance handoff contract.
It binds the exact browser commit and lease to seven fail-closed checks: lease,
browser build, site, issuer attestation, isolated Matrix, finalized RPC quorum,
and derived wallet policy. A ready response requires every check to be `ok` and
records only the finalized agreement slot plus the public 2-of-3 shape. It never
contains RPC URLs, credentials, passwords, cookies, tokens, wallet secrets, or
filesystem paths. The manual browser refuses to render the application until a
ready response matches `neal.devnet-manual-runtime/v1` and its own embedded
source commit. Production and ordinary local-preview consumers never request
this endpoint.

`neal.solana-rpc-set/v1` remains a private credential contract. Executing
manual and formal devnet tooling requires `quorum-2-of-3`, threshold two, and
exactly three distinct IDs, hosts, registrable domains, and trust domains.
Tooling receives only the mode-`0600` credential path. URLs may contain provider
credentials but must never appear in command arguments, browser contracts,
logs, receipts, or GitHub artifacts.

`neal.wallet-proof/v1` proves control of one address. Its subject is `solana:mainnet/{address}`. The proof records the wallet name, standard signing method, short-lived request ID, issue and expiry times, signed message, Ed25519 signature, public key, digest, and whether verification was local or server-backed. A local proof is never represented as a durable authenticated session.

`neal.holder-proof/v1` binds a wallet-proof digest to the canonical mint, integer token balance, mint decimals, commitment, finalized or confirmed slot, and observation time. Holder status is true only when the integer balance meets the public policy threshold. It is a point-in-time observation, not a permanent role.

`neal.local-yahoos/v1` is the active device-local event record. It contains only ordered millisecond timestamps and never leaves the browser through application code. The site derives a local total, fastest consecutive three-event interval, and largest rolling 60-second burst. These values must always be labelled local and unverified.

`neal.yahoo-leaderboard/v1` remains an empty compatibility artifact for a possible future indexed mode. In local mode it publishes `mode: local_free`, `scope: this_browser`, and `futureOnChainPolicyStatus: undecided`; site consumers derive current records from local storage rather than seeding the public artifact with local clicks.

`neal.wallet-challenge-request/v1` and `neal.wallet-verification/v1` are the
server authentication boundary. The challenge producer must issue a
single-use, address-bound SIWS nonce. The verifier must validate the domain,
URI, chain, address, nonce, issue time, expiry, Ed25519 signature, and nonce
consumption before creating a session. The implementation remains inactive
until its public endpoints are populated in policy. See `WALLET_IDENTITY.md`
for exact flow and compatibility rules.

`wallet-policy.json.accessStake` is an additive optional member of
`neal.wallet-policy/v1`. Its lifecycle is `planned | active | paused`. It
publishes contract version 2, the exact program and immutable ProgramData hash,
config PDA and revision, issuer authority, canonical mint, Token-2022 program,
decimals, integer atomic amount, minimum lock seconds, and token endpoint. All
deployment-dependent values remain nullable while `planned`. A consumer may
enable staking only when status is `active`, every value is populated, the
canonical launch mint matches, server-backed identity endpoints are populated,
and the finalized on-chain config exactly matches the policy. Older consumers
that ignore this member continue to support manually supplied registration
tokens. The first-party consumer makes acquisition part of account creation:
it enables submission only after claim supplies a token, while retaining an
explicit manual-token fallback for compatibility. A `planned` consumer may
show non-signing rollout status but must not imply that public token acquisition
is available. A `paused` consumer must block new stake and claim actions without
hiding an eligible receipt's `Unstake` path or rejecting an already issued,
unexpired token supplied through the compatibility fallback.

Approved amount and lock values may be published while `planned` so users can
review the intended terms. Their presence does not authorize transactions or
relax any program, config, identity, issuer, or finalized-chain activation gate.

The reviewed producer path for an `active` value is
`scripts/stage-access-stake-policy.mjs`. It refuses to write until the canonical
mint, executable immutable program bytes, config PDA/revision/issuer, decoded
finalized terms, Token-2022 extension allowlist, revoked mint and freeze
authorities, and credentialed issuer preflights all match. Directly
changing the lifecycle string is not an activation procedure.

`neal.matrix-access-token-request/v1` contains no Matrix username or password.
It is authenticated by the opaque SIWS session cookie. A successful response
uses `neal.matrix-access-token/v1` and returns one Synapse registration token,
its millisecond expiry, and the finalized receipt address. The issuer first
finalizes the issuer-authority-only on-chain consumption marker. Its ledger may
return the same unexpired token after a safe retry; it must never mint a second
token for that receipt, including after database restore.
