# Access stake contract

## Accounts

### `AccessConfig` (`NEALACFG`, version 1)

PDA seeds: `access-config`, authority public key, little-endian `config_id`.

The config stores the authority, config ID, exact NEAL mint, exact Token-2022
program, required atomic amount, minimum lock in seconds, paused flag, and PDA
bump. Required amount must be non-zero. The lock must be between one second and
365 days. The mint must be initialized, have the expected decimals, and have
both mint and freeze authorities permanently revoked.

Config updates affect only future stakes. Every receipt snapshots the amount
and unlock time in force when it was created.

### `StakeReceipt` (`NEALSTAK`, version 1)

PDA seeds: `access-stake`, config public key, staker public key.

The receipt stores its config, staker, vault, snapshotted amount, stake and
unlock timestamps, claim and release timestamps, state, and bump. Its
Token-2022 vault is controlled by the receipt PDA.

Receipts are deliberately never closed. A released receipt therefore remains
an auditable, one-use record and prevents stake recycling under the same
config.

## Instructions

| Instruction | Signer | Effect |
| --- | --- | --- |
| `InitializeConfig` | payer and authority | Creates and initializes the config PDA. |
| `UpdateConfig` | authority | Changes future amount/lock terms and/or pause state. |
| `Stake` | staker | Creates a receipt PDA and transfers the configured amount to its empty vault. |
| `ClaimAccess` | staker | Writes `claimed_at` exactly once while active and unpaused. |
| `Unstake` | staker | After `unlock_at`, returns the full vault balance and marks the receipt released. |

`Unstake` intentionally does not enforce the pause flag. A pause cannot trap an
otherwise releasable user stake.

## Issuer boundary

The program does not create Matrix credentials. The issuer must independently:

1. authenticate the wallet with a server-issued, single-use SIWS challenge;
2. derive the expected receipt PDA from its configured program, config, and
   authenticated wallet;
3. read config, receipt, and vault at `finalized` commitment;
4. require the configured mint/program, active state, non-zero `claimed_at`,
   zero `released_at`, and sufficient vault balance;
5. atomically reserve that receipt in durable storage before calling Synapse;
6. create at most one 15-minute, one-use registration token.

Program and config IDs are deployment data, not source defaults. A UI must stay
disabled while either is absent.
