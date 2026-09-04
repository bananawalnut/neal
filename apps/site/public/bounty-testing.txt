# Bounty factory test matrix

The integration harness runs through `solana-program-test` with the official
SPL Token 8.0.0 processor. This exercises Solana account ownership, signer and
writable privileges, PDA signing, system-program account creation, clock/rent
sysvars, SPL `TransferChecked` CPIs, and transaction rollback.

The same integration tests pass both with the native bounty processor and with
the compiled `target/deploy/neal_bounty_factory.so` loaded into the validator
runtime. The executable pass uses SBPFv0 because the test runtime is pinned to
Solana 2.3.13. An SBPFv3 build also succeeds with `cargo-build-sbf` 4.3.0, but
that artifact requires an SBPFv3-capable validator rather than the pinned 2.3
runtime.

## Covered

- Factory PDA creation and persisted fixed fee configuration
- Rejection when the fee token account is not authority-controlled
- Pause and unpause authorization
- Rejection of bounty creation while paused
- Rejection of an incorrect mint-decimal assertion
- Separate, atomic reward and fixed-fee transfers on creation
- Creation rollback when the reward succeeds but the fee transfer lacks funds
- No bounty PDA, counter increment, fee, or escrow movement after rollback
- Rejection of duplicate bounty creation without a second fee charge
- Proof PDA creation and persisted immutable commitments
- Rejection of completion by a non-reviewer
- Rejection of payout to a token account not owned by the proof submitter
- Rejection of completion while paused
- Full advertised reward paid to the proof submitter
- No additional fee collected during completion
- Atomic proof/bounty terminal transitions and winning-proof linkage
- Rejection of replayed completion without a second payout
- Rejection of cancellation before expiry and exactly at expiry
- Rejection of proof completion after expiry
- Rejection of cancellation by an unrelated signer
- Successful refund after expiry, including when the factory is paused
- Creation fee retained after an expired refund
- Exact custom error codes for every adversarial contract rejection
- Fixed-size Borsh layouts, stable instruction tags, and PDA domain separation

## Commands

```bash
cargo test -p neal-bounty-factory
cargo clippy -p neal-bounty-factory --all-targets -- -D warnings
cargo build-sbf --arch v0 --manifest-path programs/bounty-factory/Cargo.toml
SBF_OUT_DIR="$PWD/target/deploy" \
  cargo test -p neal-bounty-factory --test program_test
```

## Remaining deployment gates

Re-run the artifact suite using the exact SBPF architecture and validator
release selected for deployment, then rehearse against devnet. Independent
review remains required before production funds are used.
