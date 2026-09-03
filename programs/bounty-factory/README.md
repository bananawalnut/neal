# NEAL bounty factory

This crate is the first on-chain escrow core for NEAL quests. A bounty is not
completed by editing a bounty record directly. A reviewer completes one
submitted proof, and that single instruction atomically:

1. marks the proof `Completed`;
2. marks its bounty `Completed` and records the winning proof PDA; and
3. pays 100% of the advertised reward to the proof submitter.

NEAL earns a separate fixed listing fee when a bounty is created. Factory
initialization fixes the fee amount and destination, and every bounty records
the exact fee paid. The fee is charged in addition to the escrowed reward; it
never reduces the proof author's payout and is not charged on completion.

The program is intentionally mint-agnostic at the code level. Each factory is
pinned to one exact reward mint and the canonical SPL Token program. Token-2022
is deliberately rejected because transfer extensions can change payout
semantics. A NEAL deployment must initialize its factory with the canonical
NEAL mint from the public launch record.

## Accounts

- `Factory`: authority, exact reward mint/token program, immutable fixed creation
  fee and recipient, pause flag, and the append-only bounty counter.
- `Bounty`: immutable brief digest, creator, reviewer, reward, expiry, vault,
  proof counter, terminal state, and winning proof.
- `Proof`: submitter, immutable proof digest, immutable URI digest, timestamps,
  and state. The URI itself stays off-chain; the digest prevents replacement.

PDAs are domain-separated and deterministic:

```text
factory = ["factory", authority, factory_id_le]
bounty  = ["bounty", factory, bounty_number_le]
proof   = ["proof", bounty, proof_number_le]
```

## Instructions

- `InitializeFactory`: creates a factory for one reward mint.
- `SetPaused`: authority-only emergency pause/unpause.
- `CreateBounty`: transfers NEAL's fixed creation fee and escrows the separate,
  exact reward in a pre-created vault owned by the bounty PDA.
- `SubmitProof`: creates the next proof PDA before the bounty expiry.
- `CompleteProof`: reviewer-only terminal transition paying the proof author the
  entire advertised reward. NEAL earns nothing from completion.
- `CancelBounty`: returns escrow to the creator after expiry; it remains
  available while paused so funds cannot be trapped by the emergency control.

All quantities are integer atomic token units. `TransferChecked` pins the mint
decimals at every escrow movement. Creation requires a zero-balance vault and
checks its post-transfer balance. Completion/cancellation requires at least the
promised reward; unrelated dust cannot lock a bounty, and only the recorded
reward amount is ever paid or refunded.

## Build and test

```bash
cargo test -p neal-bounty-factory
cargo build-sbf -p neal-bounty-factory
```

The host tests cover wire sizes, instruction stability, PDA domain separation,
and the central invariant that completing a proof completes exactly one bounty.
The `client` module contains matching PDA derivation and instruction builders;
callers must read `Factory.bounty_count` and `Bounty.proof_count` immediately
before building creation/submission transactions and simulate before signing.
Before deployment, add validator integration tests for SPL Token CPIs,
publish an IDL/client builder, rehearse on devnet, and obtain an independent
security review. No program ID is embedded yet because it must be derived from
the reviewed deployment keypair rather than invented in source.
