# NEAL system architecture

## Components

| Component | Technology | Responsibility | Can sign? |
| --- | --- | --- | --- |
| Launch contract | Versioned JSON | Single source of launch decisions and immutable records | No |
| Launch guard | Pure Rust CLI, later WASM | Validate readiness and produce blocker reports | No |
| Public site | Vanilla HTML/CSS/TypeScript | Publish canonical mint and receipts; discover standard wallets; request identity signatures; read holder proofs | Requests wallet only |
| Operations console | Vanilla TypeScript + Rust/WASM | Build previews, simulate, reconcile, and request wallet signatures | Requests wallet only |
| Pump adapter | Official `@pump-fun/pump-sdk` | Build protocol instructions and read protocol state | No |
| Solana adapter | `@solana/kit` and wallet-standard interfaces | RPC reads, simulation, transaction assembly, wallet handoff | No private keys |
| Inventory indexer | Rust service or local CLI | Read public token accounts and reconcile program budgets | No |
| Suggestion registry | Append-only public records | Record paid proposals, support signals, moderation, and dispositions | Service signing key only |
| Local YAHOO toy | Vanilla TypeScript + browser local storage | Record free local clicks and calculate this browser's personal records | No |
| Future YAHOO program/indexer | Undecided | Only exists if a later product decision approves wallet-linked, global, or on-chain YAHOOS | Undecided |
| NEAL Matrix client | Vanilla TypeScript + official `matrix-js-sdk` | Show the public GC transcript, discover a user's homeserver, initiate account creation or login, knock, moderate, and exchange GC messages without an Element redirect | Session access token only when signed in |
| NEAL Matrix homeserver | Synapse + Postgres + filtered local gateway | Serve `matrix.nealtheseal.org`, the public unencrypted GC, and a fixed read-only message feed | Server signing keys and a server-held NEAL reader-device token |
| Future NEAL Nostr relay | strfry + isolated LMDB volume | Reserved plan for `nostr.nealtheseal.org`; not deployed | No user or wallet keys |
| NEAL agent runner | Custom Nostr bridge + Goose ACP | Connect a separately keyed NEAL agent to reviewed event threads | Agent Nostr key only |
| Quest ledger | Append-only signed records | Record eligibility inputs and decisions | Service signing key only |
| Claim builder | Reviewed Solana program + deterministic tooling | Verify claims against a published root | Wallet signs claims |

## Key boundaries

- Pump.fun creates NEAL. No application component has authority to create a second NEAL mint.
- Rust/WASM validates and computes; browser TypeScript interfaces with RPC and wallets.
- Signing occurs only inside the user’s connected wallet.
- The public site is transaction-read-only until a separately reviewed quest or claim transaction builder is added. It may request an off-chain identity signature and read public holder state.
- Wallet identity uses Wallet Standard feature discovery. `solana:signIn` is preferred; `connect + solana:signMessage` is the compatibility fallback.
- Connected, signed, authenticated, and holder-verified are separate states. The UI must never collapse them into one label.
- A browser-verified signature is not a durable authenticated session. Durable auth requires a server-issued, single-use SIWS nonce and server-side verification.
- Holder proof combines a verified wallet-control proof with a finalized RPC read for the canonical mint at a recorded slot. Connection alone is not holder proof.
- The site stores wallet identity state in memory only. It never writes addresses, signatures, or holder balances to `localStorage` or `sessionStorage`.
- The dev buys NEAL through the Pump.fun market with no fixed supply-percentage target; the site publishes the actual wallet, spend, fill, and transaction.
- Pump's V2 fee-sharing configuration is planned with two final recipients: 58% to the disclosed dev recipient and 42% to the treasury. The final split is not represented as active until the sharing-config address and both setup receipts are public.
- Before that split activates, the dev recipient owes a manual, disclosed 42% sweep. After activation, distribution is permissionless through Pump's program. The treasury uses its share for disclosed NEAL market buys funding quests and open-source-developer airdrops; its airdrop-earmarked balance may not exceed 18% of finalized total supply at any time unless every NEAL holder approves more. Quest and airdrop systems consume only settled, purpose-labelled inventory records.
- Open-source-developer airdrops remain fail-closed until a public eligibility policy, recipient selection record, distribution ledger, balance-cap monitor, and—before any exception—a reviewed unanimous-holder approval mechanism exist. The 18% figure is a live treasury-balance ceiling, never a genesis allocation.
- A community suggestion costs one whole NEAL or one whole DREGG and routes the selected token to the published quest treasury. The browser must resolve the selected canonical mint, derive atomic units from that mint's decimals, and cannot enable payment until a reviewed transaction builder and durable public registry are live. DREGG remains disabled while its canonical mint is null.
- Current YAHOOS are deliberately browser-local counters: free, device-scoped, and labelled as neither verified nor on-chain. Any future global or on-chain form is a separate undecided contract and must not silently reinterpret local records.
- Private admin services never receive wallet seed phrases.
- Matrix and Nostr are separate identity systems. A wallet, Matrix account, or
  Nostr key is never treated as the owner of another identity without an
  explicit signed linking proof.
- The existing Zenith Synapse remains `matrix.zenith-research.ca`. NEAL's
  separately isolated Synapse serves `matrix.nealtheseal.org`; the two join
  rooms through normal federation and never share databases or signing keys.
- The NEAL Matrix client sends credentials directly from the browser to the
  homeserver discovered from the user's Matrix ID. Its access token is scoped
  to the current browser tab. Signed-out visitors receive the public plaintext
  transcript through a fixed GET-only Caddy route; its expiring NEAL reader
  token stays on the VPS and is never sent to the browser. Guest registration
  is disabled. The client has no NEAL/Vercel credential backend and renders
  remote text as text, never HTML.
- New-account onboarding defaults to `matrix.nealtheseal.org`. The provider
  domain remains editable. NEAL uses
  the homeserver's advertised SSO/CAS registration action and validates a
  tab-scoped state value before exchanging the returned one-time login token.
- Public Matrix traffic passes through a gateway which exposes Matrix client,
  federation, and Synapse client paths but returns `404` for
  `/_synapse/admin/*`. Administrative APIs stay on loopback.
- `wss://nostr.nealtheseal.org` is reserved for a future relay and must not be
  advertised as live before deployment verification. Nostr users retain
  portable key identities if relay infrastructure later moves.
- Goose does not run inside the public relay. A small reviewed bridge runs on a
  controlled agent host, authenticates with a dedicated Nostr key, and connects
  outbound to strfry. Every additional agent gets a distinct key.

## Environments

- `local`: mock protocol records and deterministic fixtures
- `devnet`: wallet, simulation, monitoring, and claim rehearsals; not a Pump.fun mainnet-equivalent guarantee
- `mainnet-readonly`: inspect current program state without signing
- `mainnet-signing`: disabled by default and enabled only for an exact reviewed transaction

## Dependency policy

- Pin exact package versions and record integrity hashes.
- Prefer Pump.fun’s official SDK and public IDLs over community reverse-engineered clients.
- Do not include trading bots, volume tools, multi-wallet generators, or private-key loaders.
- Treat every SDK upgrade as a protocol-contract change requiring simulation and fixture updates.

Current pins checked on 2026-09-02: `@pump-fun/pump-sdk` 1.36.0, `@solana/kit` 8.2.0, `@wallet-standard/app` 1.1.1, `@solana/wallet-standard-features` 1.4.0, `@solana/wallet-standard-util` 1.1.3, `@solana-mobile/wallet-standard-mobile` 0.6.0, and `matrix-js-sdk` 42.3.0. Versions must be rechecked before protocol upgrades.

## Public-record projection

`scripts/sync-public-record.mjs` is the producer for `neal.public-record/v1`. It reads the private launch-control record and emits only fields approved for the public site. The projection fails if exactly one of the mint address and creation transaction is present. It intentionally excludes creator-wallet decisions and internal scheduling data.

`apps/site/public/wallet-policy.json` is the reviewed producer for `neal.wallet-policy/v1`. The public site is its first consumer. Castalia must consume the same feature names and chain identifiers rather than introducing a NEAL-only provider API. See [wallet identity and Castalia conformance](WALLET_IDENTITY.md).
