# Initiative 002 — Visualize NEAL transactions in the CoinDesk Tauri app

## Outcome

Turn a confirmed Solana transaction signature into a clear, verifiable visual story inside the CoinDesk Tauri app. The first public demonstration is the opt-in NEAL transfer to `@redemptionarcc` after launch. The same component must also explain the canonical mint, the dev's market buy, Pump's 58/42 creator-fee distributions, creator-fee-funded quest buybacks, community-suggestion payments, and quest payouts.

This initiative does not build, sign, or broadcast transactions. It reads public chain data after a transaction exists.

## Product experience

The user pastes or deep-links a Solana signature. The app shows:

1. `Pending`, `confirmed`, `finalized`, or `failed` state without guessing.
2. A flow view of the sending wallet, receiving wallet, token mint, token amount, and SOL network fee.
3. A chronological instruction timeline, including associated-token-account creation when present.
4. Pre- and post-transaction token balances derived from chain data.
5. A canonical-NEAL badge only when the mint exactly matches NEAL's published launch record.
6. Known-wallet labels only from versioned public records or explicit user labels.
7. The signature, slot, block time, RPC commitment, and an external explorer link.
8. A portable JSON receipt and shareable image export.

The first narrative label may read `NEAL sent to Red` only after the recipient opts in and supplies the receiving address. Otherwise the interface uses shortened public addresses and makes no identity claim.

## Architecture

### Rust / Tauri boundary

Add a read-only Tauri command:

```rust
#[tauri::command]
async fn inspect_solana_transaction(
    signature: String,
    cluster: SolanaCluster,
) -> Result<TransactionVisualization, TransactionInspectionError>;
```

The Rust module should:

- validate base58 signature syntax before making an RPC call;
- call Solana JSON-RPC `getTransaction` with `jsonParsed` encoding and an explicit supported transaction version;
- request finalized data for the shareable receipt while allowing a clearly labelled confirmed preview;
- parse native SOL deltas, SPL Token `transfer` and `transferChecked` instructions, inner instructions, and associated-token-account creation;
- derive token deltas from `preTokenBalances` and `postTokenBalances` using integer atomic amounts;
- return typed errors for not found, still processing, failed, unsupported, malformed, RPC unavailable, and mint mismatch states;
- never accept, request, log, or store a private key, recovery phrase, or wallet signature.

### TypeScript view model

```ts
type TransactionVisualization = {
  signature: string;
  cluster: 'mainnet-beta' | 'devnet';
  status: 'confirmed' | 'finalized' | 'failed';
  slot: number;
  blockTime: number | null;
  feeLamports: string;
  accounts: VisualizedAccount[];
  assetFlows: AssetFlow[];
  instructionTimeline: VisualizedInstruction[];
  verification: {
    canonicalMint: boolean;
    launchRecordUrl: string | null;
    launchRecordDigest: string | null;
  };
};
```

All lamports and token quantities remain decimal strings across the Rust/TypeScript boundary. Formatting happens only in the presentation layer.

## NEAL verification input

The app consumes `neal.public-record/v1` from `https://nealtheseal.org/launch-record.json` and treats it as untrusted input until its schema and required fields validate. A transaction can receive the canonical badge only when:

- the public record says `launched`;
- both the mint address and creation transaction are present;
- the inspected token mint equals the published mint exactly; and
- the selected cluster is Solana mainnet.

The app must still display ordinary Solana transactions when the NEAL record is unavailable, but it must remove the canonical badge and explain that verification is unavailable.

## Visual direction

Use a compact transaction river rather than a candlestick chart:

```text
[sender] ── 125,000 NEAL ──▶ [recipient]
    │                            │
  before                       after
    │                            │
    └──── network fee + receipt ─┘
```

- Motion progresses only as commitment advances; failure stops and visibly breaks the flow.
- Token movement and SOL fees use separate lanes.
- Multi-recipient transactions branch instead of collapsing into a misleading single arrow.
- Colour cannot be the only status signal.
- No price, profit, endorsement, or identity claim is inferred from a transfer.

## Test fixtures

Include deterministic fixtures for:

- a successful SPL `transferChecked`;
- associated-token-account creation plus transfer;
- a versioned transaction with inner instructions;
- Pump creator-fee distribution branching 58% to the dev recipient and 42% to the quest treasury;
- multiple token recipients;
- a failed transaction;
- a signature that is confirmed but not finalized;
- an unrelated mint presented as NEAL;
- a malformed or missing public launch record; and
- token amounts beyond JavaScript's safe integer range.

## Acceptance criteria

- A finalized NEAL transfer can be reconstructed from only its public signature and RPC data.
- Displayed token deltas exactly match the transaction metadata's atomic-unit deltas.
- The canonical badge fails closed for every mint or record mismatch.
- The UI distinguishes transaction sender, fee payer, token-account owner, and recipient.
- No secret or signing material crosses the Tauri command boundary.
- The receipt is reproducible from the signature and records the RPC commitment used.
- The view works for arbitrary SPL tokens; NEAL supplies labels and verification, not a bespoke parser.
- Accessibility, reduced-motion, offline, RPC-failure, and partial-data states are covered.

## Delivery slices

1. Typed Rust RPC inspector and fixtures.
2. Generic transaction-flow view in Tauri.
3. NEAL launch-record verification and canonical badge.
4. Deep link from a NEAL signature and shareable receipt export.
5. Post-launch demonstration using the opt-in transfer to Red.

## Dependencies and open decisions

- Attach the actual CoinDesk Tauri repository and identify its state-management and design-system conventions.
- Select the production Solana RPC provider and retention policy.
- Decide whether public wallet labels live only on the device or in a signed shared registry.
- Obtain the recipient's opt-in address after NEAL launches.
- Record the canonical mint and creation transaction before enabling NEAL-specific verification.
