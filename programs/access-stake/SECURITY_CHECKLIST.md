# Access-stake security review checklist

This checklist maps the round-table findings to v2 controls. Checked code items
are implemented and covered by local verification. Deployment items remain
unchecked until public receipts or operator evidence exist; source changes do
not authorize mainnet activation.

| Finding | v2 mitigation | Evidence |
| --- | --- | --- |
| Stake signature could accept changed terms | `Stake` carries exact amount, lock, and config revision; the program rejects any mismatch before transfer. Amount and lock are immutable. | Contract and validator tests |
| Predictable ATA could be dusted | Vault balance is snapshotted and must increase by exactly the required amount; the full balance is later refunded. | Pre-dusted validator lifecycle |
| Unsafe Token-2022 behavior | Program allowlists mint metadata extensions and account immutable-owner only; exact transfer postconditions remain enforced. | Transfer-fee mint rejection test |
| Database restore could issue twice | Issuer-only `ConsumeClaim` writes finalized `issued_at` before Synapse issuance; duplicate consumption fails on chain. | Contract, validator, issuer idempotence tests |
| Issuer accepted mutable or different code | Browser, readiness tool, and issuer pin the upgradeable-loader ProgramData account, require no upgrade authority, and hash exact deployed bytes. | v2 policy and attestation code |
| One RPC could lie | Issuer requires exact finalized agreement from two configured HTTPS RPCs and pins genesis. | Issuer disagreement test |
| Issuer could drift from approved terms | Issuer pins amount, lock, revision, issuer public key, mint, token program, program bytes, config owner, and PDA. | Required environment and readiness |
| Challenge and worker exhaustion | Pair/IP/global rate limits, bounded worker slots, 32 KiB bodies, expiry pruning, socket timeouts, and database-size ceiling fail closed. | Issuer implementation and socket tests |
| Browser server session could silently expire | Server expiry is stored in memory; HTTP 401 clears only server authentication and asks for reverification without restaking. | Browser type-check/build |
| Temporary Synapse admin cleanup could fail open | Cleanup failure is durable, readiness and issuance halt, and `reconcile.py` revokes the token and deactivates both orphan and reconciliation admins. | Reconciliation unit test |
| Secret ownership crossed the Synapse boundary | systemd loads Matrix secret and issuer key as credentials into a dynamic-user service; installer never changes secret ownership. | Unit and installer |
| Runtime socket could disappear on restart | systemd preserves the runtime directory and the service safely replaces only an existing socket node. | Unit and service configuration |
| Pause/recovery depended on ad-hoc transactions | Reviewed tool simulates by default, verifies genesis/PDA/authority, requires explicit mainnet acknowledgement, confirms finality/revision, and can atomically stage policy. | `manage-access-stake-config.mjs` |
| Planned readiness looked successful | Planned status exits nonzero unless `--informational-planned` is explicit; CI separately validates the offline policy shape. | Readiness and CI |
| Dependency/toolchain drift | npm and Cargo locks are enforced, issuer deployment wheels are version/hash locked, Rust and Agave CI versions are pinned, and CI builds/uploads the SBF hash. | CI and deployment requirements |
| A single non-reproducible SBF was reviewed | Release tooling builds the exact commit twice with separate sources/Cargo homes in a digest-pinned linux/amd64 container, verifies the Agave installer hash, byte-compares output, and emits a strict manifest. | `access-stake:reproduce`, CI release artifact |
| Devnet evidence could leak credentials | The receipt has an exact allowlisted schema plus recursive credential-shaped key/value rejection; credentials remain in a mode-0700 OS temporary root and mode-0600 files. | Evidence validator and tooling tests |
| A rehearsal could touch live Matrix | Pinned rehearsal containers use `rehearsal.neal.invalid`, loopback-only ports 18008-18010, distinct disposable volumes, and generated credentials; no production path, port, DNS name, or secret is mounted. | Rehearsal compose and executor |
| Backup files could be forged or expose SQLite | Online SQLite snapshots use the authenticated `NEALBKP1` envelope with scrypt and AES-256-GCM; restore verifies authentication and SQLite integrity before atomic replacement. | Issuer backup unit tests and rehearsal stale-restore drill |

## Later review

- [x] v2 producer and every in-repository consumer use the same wire layout.
- [x] 69,000 NEAL (`69000000000` atomic) and 90 days (`7776000` seconds) are enforced by production staging and mainnet initialization tools.
- [x] Native and validator-backed Rust tests pass, including dust, stale terms, issuer authorization, duplicate consumption, pause, unlock, and unsupported extensions.
- [x] Issuer unit tests pass, including nonce replay, dual-RPC disagreement, idempotence, failed issuance, reconciliation, keypair integrity, and Unix-socket serving.
- [x] Public site type-check, policy validation, and production bundle pass.
- [x] Public policy remains `planned` with every deployment-dependent value null.
- [ ] Independent program and issuer security review approves the exact commit.
- [ ] Pinned SBF artifact is reproducibly built twice and both SHA-256 values match.
- [ ] Full devnet flow passes against non-production Synapse, including pause, failed cleanup, and user refund.
- [ ] Encrypted SQLite backup and stale-restore drill confirms on-chain consumption prevents reissuance.
- [ ] Mainnet program is deployed, made immutable, and its ProgramData address/hash are recorded publicly.
- [ ] Mainnet config is initialized with the reviewed issuer key and exact production terms.
- [ ] Two independent production RPCs, issuer credentials, Caddy routes, and `/readyz` pass operator review.
- [ ] Policy staging dry run passes; protected review merges the separately generated `active` policy change.
- [ ] One live low-risk account creation and later unstake acceptance test is recorded without personal data.
