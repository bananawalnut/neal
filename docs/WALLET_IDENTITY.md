# NEAL wallet identity and Castalia conformance

## The rule

NEAL has no email/password user identity. A Solana address is the subject, a wallet signature proves present control of that address, and public chain state proves current NEAL holdings. These are separate facts:

1. **Discovered**: a wallet registered through Wallet Standard.
2. **Connected**: the wallet authorized an account for this origin.
3. **Signature verified**: the selected account produced a valid, domain-bound proof.
4. **Authenticated**: the backend consumed a single-use challenge and accepted the proof.
5. **Holder verified**: the authenticated address held the configured minimum NEAL balance at a recorded finalized slot.

The UI and APIs must preserve these distinctions.

## Public standards

The browser app uses the Wallet Standard registration handshake from `@wallet-standard/app`. A compatible wallet advertises its chains, accounts, and versioned features rather than being detected through a proprietary `window.solana` branch.

Required or capability-gated feature names:

| Feature | NEAL use | Castalia requirement |
| --- | --- | --- |
| `standard:connect` | Authorize accounts | Required |
| `standard:events` | Detect account/capability changes | Required |
| `standard:disconnect` | Best-effort local cleanup | Required for Castalia; optional to the site |
| `solana:signIn` | Preferred Sign In With Solana flow | Required |
| `solana:signMessage` | Authentication compatibility fallback and off-chain proofs | Required |
| `solana:signTransaction` | Reviewed transaction handoff when signing without sending is genuinely required | Required if Castalia supports partial signing |
| `solana:signAndSendTransaction` | Preferred reviewed transaction execution path | Required |

Transaction methods take and return immutable serialized bytes. The website calls a feature only after both the wallet and selected account advertise it. Castalia is displayed first by name but receives no privileged authentication or transaction code path.

Current sources: [Wallet Standard registry](https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/app/src/wallets.ts), [Solana Wallet Standard extensions](https://github.com/wallet-standard/wallet-standard/blob/master/extensions/solana.md), [Sign In With Solana](https://github.com/phantom/sign-in-with-solana), and [Mobile Wallet Adapter](https://github.com/solana-mobile/mobile-wallet-adapter/blob/main/spec/spec.md).

## Authentication

`solana:signIn` is preferred. If the connected account does not advertise it, NEAL constructs the same SIWS fields and requests `solana:signMessage`.

Production flow:

1. Client posts `neal.wallet-challenge-request/v1` with address and `solana:mainnet`.
2. Server returns SIWS input bound to the exact domain, URI, address, chain, random single-use nonce, request ID, issue time, and five-minute expiry.
3. Wallet constructs/signs the SIWS message, or signs the compatibility message.
4. Client verifies the Ed25519 signature before sending anything onward.
5. Client posts `neal.wallet-verification/v1` with the original input and base64url-encoded output.
6. Server repeats all verification, atomically consumes the nonce, and issues a short session.

Until `identity.challengeEndpoint` and `identity.verifyEndpoint` are populated in `wallet-policy.json`, the site deliberately labels successful verification as **verified in this tab**, not authenticated. This prevents a local random nonce from being mistaken for replay-safe server auth.

No address, signature, or holder balance is written to browser storage. The Mobile Wallet Adapter authorization cache is also memory-only. An HTTP-only session cookie may later hold an opaque session capability; it must not contain profile data or private keys.

## Matrix access stake

`accessStake` is optional and inactive by default. `planned` is a non-signing
state that remains visible in the account form. `paused` blocks new stake and
claim signatures but still permits an existing unlocked receipt to be released.
The account form enables stake and claim controls only when the policy is
`active`, the launch record's canonical mint matches, both SIWS endpoints and
the access-token endpoint exist, and the finalized program config matches every
published term.

The connected wallet creates one config/wallet receipt, moves the configured
atomic NEAL amount into a Token-2022 vault controlled by that receipt PDA, and
submits a one-time `ClaimAccess` instruction. The issuer authenticates the same
wallet, derives that receipt, and verifies its active claimed state and funded
vault at `finalized`. A SQLite reservation is committed before Synapse is
called. The resulting registration token allows one use and expires after 15
minutes. The browser places it into the existing Matrix registration flow; the
issuer never sees the selected Matrix username or password.

The receipt snapshots its amount and unlock time. The wallet can return the
entire vault after the minimum lock, even if the authority pauses new activity.
The receipt stays on-chain and cannot issue another token. The Matrix account
continues to exist after the stake is released.

## Holder proof

The canonical mint comes only from `neal.public-record/v1`. Before that record is launched and contains both mint and creation transaction, holder proof is disabled.

After wallet control is verified, the site:

1. reads mint decimals at the configured commitment;
2. calls `getTokenAccountsByOwner` for the verified address and exact canonical mint;
3. sums integer atomic balances across every returned token account;
4. records the RPC slot, commitment, observation time, and wallet-proof digest; and
5. compares the sum against the public integer threshold.

The result is `neal.holder-proof/v1`. It is a point-in-time receipt. Gated quest submissions and claims must re-check or enforce their own snapshot/claim rules.

## Web3 user data

Wallet identity does not mean publishing personal data on-chain. NEAL user records should be user-signed envelopes keyed by the wallet subject. Public quest artifacts may be content-addressed and anchored by hash/URI; sensitive or private material must remain encrypted and opt-in. A wallet address is public chain data but linking it to off-chain behavior can still create privacy risk.

No NEAL feature may silently add an email account, custodial key, analytics identity, or centralized profile as the source of truth.

## Castalia implementation target

Castalia should register one Wallet Standard `Wallet` object with Wallet Standard version `1.0.0`, accurate `solana:mainnet` / devnet / testnet chains, immutable `WalletAccount` objects, and correct account-level feature lists. Account changes must emit `standard:events` rather than mutating account objects in place.

For mobile/native interoperability, Castalia should implement Mobile Wallet Adapter 2.x and expose SIWS, message signing, and sign-and-send capabilities through that protocol. The NEAL website registers the official Mobile Wallet Standard bridge on Android. Current Solana Mobile documentation states that local mobile-web MWA is Android Chrome oriented; iOS web support must use a standards-compatible injected/in-app-browser route until the protocol ecosystem supports it.

Castalia may expose a versioned `castalia:` extension for capabilities unique to Castalia, but NEAL authentication, holder proof, and transaction signing must continue working when that extension is absent.

## Current verification status

- Producer: `wallet-policy.json` parses and is copied by the Vite production build.
- Consumer: the vanilla TypeScript wallet controller typechecks and builds against pinned official Wallet Standard packages.
- Castalia: contract defined; wallet implementation repository not present in the current workspace, so conformance tests are pending.
- Risk: additive and fallback-backed. Existing public-record consumers are unchanged.
