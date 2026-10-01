# Access stake contract

## Accounts

### `AccessConfig` (`NEALACFG`, version 2)

PDA seeds: `access-config`, authority public key, little-endian `config_id`.

The config stores the authority, issuer authority, config ID, exact NEAL mint,
exact Token-2022 program, monotonic revision, required atomic amount, minimum
lock in seconds, paused flag, and PDA bump. The amount and lock are immutable.
Only pause state and issuer authority can change; either change increments the
revision so a wallet cannot sign stale terms.

The mint must be initialized, have the expected decimals, and have mint and
freeze authorities permanently revoked. Only the metadata-pointer and
token-metadata mint extensions are accepted. Stake token accounts reject every
extension except immutable-owner, excluding transfer fees, hooks, delegates,
non-transferability, confidential transfer, and other unreviewed behavior on
chain rather than relying on an off-chain RPC parser.

### `StakeReceipt` (`NEALSTAK`, version 2)

PDA seeds: `access-stake`, config public key, staker public key.

The receipt stores its config, staker, vault, amount, config revision, stake,
unlock, claim, issuer-consumption, and release timestamps, state, and bump. Its
Token-2022 vault is controlled by the receipt PDA. A pre-existing vault balance
is allowed, but `Stake` snapshots it and requires the exact configured increase;
this prevents dust from denying service without letting a transfer-tax mint
satisfy the stake with less than the configured amount.

Receipts are deliberately never closed. A released receipt therefore remains
an auditable, one-use record and prevents stake recycling under the same
config. Config and receipt creation accepts a system-owned, data-empty PDA that
was pre-funded before initialization, then tops it up, allocates it, and assigns
it with PDA signing.

## Instructions

| Index | Instruction | Signer | Effect |
| --- | --- | --- | --- |
| 0 | `InitializeConfig` | payer and authority | Creates immutable amount/lock terms and pins the issuer authority. |
| 1 | `SetPaused` | authority | Pauses or unpauses new stake and claim operations; increments revision. |
| 2 | `SetIssuerAuthority` | authority | Rotates only the issuer signer; increments revision. |
| 3 | `Stake` | staker | Binds expected amount, lock, and revision and transfers the exact configured increase. |
| 4 | `ClaimAccess` | staker | Writes `claimed_at` exactly once while active and unpaused. |
| 5 | `ConsumeClaim` | issuer authority | Writes `issued_at` exactly once before Synapse issuance. |
| 6 | `Unstake` | staker | After `unlock_at`, returns the full vault balance and marks the receipt released. |

`Unstake` intentionally ignores the pause flag. A pause cannot trap an
otherwise releasable user stake. The v2 wire format is a deliberate
pre-deployment break; no v1 config is accepted by any producer or consumer.

## Issuer boundary

The program does not create Matrix credentials. The issuer must independently:

1. authenticate the wallet with a server-issued, single-use SIWS challenge;
2. attest the finalized cluster genesis, immutable ProgramData address, exact
   reviewed program hash, config PDA, issuer signer, mint, terms, and pause state
   using two independent RPC endpoints;
3. require an active claimed receipt with `issued_at == 0`, `released_at == 0`,
   and sufficient vault balance;
4. durably reserve the receipt, submit `ConsumeClaim`, and wait for finalized
   confirmation before calling Synapse;
5. create at most one 15-minute, one-use registration token; and
6. halt if chain consumption, Synapse issuance, or temporary-admin cleanup
   becomes ambiguous, until an operator reconciles the durable record.

Program and config IDs are deployment data, not source defaults. The public
policy stays `planned` until all identifiers and endpoints pass readiness.
