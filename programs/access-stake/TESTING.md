# Access stake verification

Run the focused suite:

```bash
cargo test -p neal-access-stake --offline
```

The contract tests cover v2 wire sizes, immutable term bounds, revision-bound
stakes, one-time claim/issuer-consumption/release transitions, deterministic
instruction encoding, PDA uniqueness, Token-2022 extension allowlisting,
signer/destination placement, and pre-funded PDA recovery.

The validator-backed test executes the lifecycle against the real Token-2022
processor: config initialization, a pre-dusted vault, stale-term rejection,
escrow deposit, on-chain claim, issuer-only one-time consumption, pause,
locked early-release rejection, time advancement, and refund of the full vault.

Run the other release gates:

```bash
python3 -m unittest -v infra/neal-access-issuer/test_issuer.py
npm run site:typecheck
npm run site:validate-policy
npm run site:build
node scripts/verify-access-stake-readiness.mjs --informational-planned
```

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
