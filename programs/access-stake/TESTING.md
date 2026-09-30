# Access stake verification

Run the focused suite:

```bash
cargo test -p neal-access-stake --offline
```

The contract tests cover wire sizes, term bounds, one-time claim and release
transitions, deterministic instruction encoding, PDA uniqueness, Token-2022
pinning, signer/destination placement, and pre-funded PDA recovery.

The validator-backed test executes the lifecycle against the real Token-2022
processor: config initialization, escrow deposit, on-chain claim, locked early
release rejection, time advancement, and full refund. It also checks that a
claimed receipt cannot be claimed twice.

Before any mainnet deployment, additionally record:

- reproducible SBF build hash and deployed program-data authority;
- mainnet simulation using the exact canonical mint and intended config terms;
- independent security review of the program and issuer;
- issuer disaster-recovery and SQLite backup/restore drill;
- end-to-end one-use token test against a non-production Synapse instance;
- pause and user-unstake incident drills.

The executable sequence and fail-closed policy staging command are documented
in [DEPLOYMENT.md](DEPLOYMENT.md). The approved production amount and lock are
recorded there; test fixture values remain non-authoritative.
