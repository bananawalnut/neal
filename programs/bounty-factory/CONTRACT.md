# Bounty factory wire contract

Status: `draft/v1` — implemented, validator-tested, and compiled-SBF-tested; not
deployed or audited.

The Borsh enum order is part of the wire format and must never be reordered:

| Byte | Instruction | Terminal effect |
| ---: | --- | --- |
| 0 | `InitializeFactory` | none |
| 1 | `SetPaused` | none |
| 2 | `CreateBounty` | escrows reward and pays fixed NEAL creation fee |
| 3 | `SubmitProof` | none |
| 4 | `CompleteProof` | completes proof/bounty; pays submitter full reward |
| 5 | `CancelBounty` | cancels expired bounty; refunds creator |

Future instructions append new variants. Existing account fields are fixed-size;
schema changes require a new account version and explicit migration.

## State machine

```text
Bounty: Open ---------------- complete_proof ----------------> Completed
          |
          +---------------- cancel_after_expiry -------------> Cancelled

Proof:  Submitted ----------- complete_proof ----------------> Completed
```

There is deliberately no `CompleteBounty` instruction. `CompleteProof` requires
the bounty-selected reviewer, the exact proof PDA, the proof submitter's token
account, the bounty's exact mint/vault, an unpaused factory, and a non-expired
open bounty. The SPL transfer and both state transitions occur in one Solana
transaction; any failure rolls the entire instruction back.

## Protocol revenue

Factory initialization fixes an authority-owned creation-fee token account and
one integer fee in atomic reward-token units. Creating a bounty performs both
transfers atomically:

```text
creator -> bounty vault: advertised reward
creator -> NEAL fee account: fixed creation fee
```

The UI must display the reward, additional creation fee, total required amount,
and fee recipient before funding. Completion pays the entire advertised reward
to the winning proof author and pays nothing to NEAL. An expired cancellation
returns the escrowed reward but not the already-paid listing fee. Changing the
fixed price requires a new factory; existing bounty records retain the amount
paid when they were created.

## Trust boundary

The program proves that the designated reviewer signed completion of an
immutable proof commitment. It does not decide whether the off-chain material
is true. A factory UI must disclose the reviewer policy. Replacing the reviewer
with a multisig, oracle, or verification program is a future authorization
adapter, not a silent reinterpretation of this v1 contract.

The proof body is represented by two SHA-256-compatible 32-byte commitments:

- `proof_digest`: canonical bytes of the submitted proof envelope;
- `uri_digest`: canonical bytes of the URI resolving that envelope.

Hashing/canonicalization is performed by clients. Zero digests are rejected.
The on-chain program treats nonzero values as opaque commitments.

## Safety properties

- A factory is fixed to one mint and canonical SPL Token program.
- Each bounty has a separate, initially empty PDA-owned vault.
- Reward amounts and mint decimals use integer atomic units.
- Only the proof submitter can receive a completed bounty's reward.
- Only the factory's immutable fee token account receives the creation fee.
- The fee token account must be controlled by the factory authority when the
  factory is initialized, preventing a self-transfer fee bypass.
- Only the creator can receive an expired bounty refund.
- A terminal bounty or completed proof cannot be replayed.
- Sequential PDA counters create an append-only discoverable ledger.
- Pause blocks new bounties, submissions, and completions but never blocks an
  expired refund.
- Completion and cancellation require the vault to retain at least the promised
  amount; unsolicited dust cannot deny service or increase the recorded payout.

## Not yet authorized for mainnet

The v1 core still requires an exact target-validator compatibility pass, a
deployment program ID, devnet rehearsal, client transaction previews, indexer
reconciliation, an incident runbook, and independent security review. The
factory should not hold production inventory until those gates pass.
