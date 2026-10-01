# NEAL access stake

`neal-access-stake` is the Solana program boundary for stake-gated NEAL Matrix
registration. A wallet locks the configured amount of the canonical Token-2022
NEAL mint in a receipt-owned vault. The wallet can then mark that receipt as
claimed once, and an off-chain issuer can exchange the finalized claim for one
short-lived, one-use Synapse registration token.

The stake is refundable after the configured minimum lock. Creating a Matrix
account is permanent; releasing the stake does not delete or disable that
account. The receipt stays on-chain after release so one wallet cannot recycle
the same config into another registration token.

This directory contains source and tests only. It does not declare a deployed
program ID and must not be treated as a mainnet deployment artifact.

## Safety properties

- The config pins one mint and the Token-2022 program.
- The mint must be initialized with both mint and freeze authorities revoked.
- Amount and lock terms are immutable; authority pause or issuer rotation bumps
  a revision that every new stake must sign.
- The authority has no instruction that can withdraw user stakes.
- Only the staking wallet can claim or release its receipt.
- Release remains available after the minimum lock even while the config is
  paused.
- Each config/wallet pair has exactly one persistent receipt PDA.
- Pre-funding a predictable config or receipt PDA cannot block its creation.
- The mint and stake accounts enforce a narrow Token-2022 extension allowlist,
  and transfer postconditions reject fee-on-transfer behavior.
- Only the configured issuer can consume a claimed receipt, exactly once,
  before creating an off-chain registration token.

See [CONTRACT.md](CONTRACT.md) for the wire contract and
[TESTING.md](TESTING.md) for the verification matrix. The mitigation map and
external release gates are tracked in [SECURITY_CHECKLIST.md](SECURITY_CHECKLIST.md).
