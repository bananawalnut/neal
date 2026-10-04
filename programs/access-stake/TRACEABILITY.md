# Production-readiness traceability

This register maps each normative control to its implementation, automated
evidence, and external completion evidence. A code check proves implementation;
it does not substitute for the external G4 rehearsal.

| Control | Implementation | Automated evidence | G4 evidence required |
| --- | --- | --- | --- |
| Strict RPC modes | `issuer.py`, RPC-set examples, policy validators | quorum/liar/config unit tests; policy tooling tests | signed three-provider trust map and outage/liar drill |
| Monotonic claim recovery | `issuer.py`, `reconcile.py` | claim/idempotency/reconciliation tests | kill-point matrix and sanitized operation ledger |
| Temporary-admin containment | journal, prefix scan, exact reconcile command | cleanup and startup scan tests | Synapse audit showing zero active reserved-prefix admins |
| Browser recovery | `access-stake.ts`, `matrix-gc.ts` | TypeScript and production build | interrupted UIA/lost-response browser recording |
| Admin monitor boundary | `admin_broker.py`, exact Caddy routes | broker encryption, expiry, restart, allowlist tests | broker restart and orphan-token revocation receipt |
| Immutable encrypted backup | `backup.py`, `s3_backup.py`, systemd timers | crypto/tamper/Object-Lock/versioning/restore tests | exact-version isolated restore within 60 minutes |
| Reproducible package | `build_bundle.py`, offline wheelhouse, release workflow | bundle manifest verification and two SBF builds | fresh Ubuntu install and replacement-host restore |
| Autonomous authority | `squads-access-authority.mjs` | manifest reproduction and tamper tests | three custodians, 2-of-3 approvals, inspected execution |
| Signed independent review | `verify-production-review.mjs` | v2 contract tests | valid Sigstore bundle for exact commit and artifacts |
| Operational soak | runbooks and G4 evidence contract | evidence validator | 72-hour alerts/reboots/outages/failover record |

## Evidence lineage

`sourceCommit` is the root identifier. The release manifest binds the two
byte-identical SBF builds. The issuer bundle manifest and SBOM bind every runtime
file. `neal.production-review/v2` binds the source commit, release-manifest
hash, SBF hash, issuer-bundle hash, reviewer identity, findings, and keyless
signature. Rehearsal and restore receipts bind those hashes and may contain only
sanitized public evidence.

## Later review checklist

- [ ] G1 required checks pass on the exact commit.
- [ ] No unresolved P0, P1, or P2 finding.
- [ ] Protected `main` requires two approvals and CODEOWNERS.
- [ ] Two clean SBF builds are byte-identical.
- [ ] Issuer bundle, manifest, SBOM, checksums, and provenance agree.
- [ ] Sigstore review verifies for the approved independent identity.
- [ ] Devnet preview is isolated and shows the exact risk disclosure.
- [ ] Three independent RPC trust domains are recorded and exercised.
- [ ] Autonomous Squads vault is 2-of-3 with three separate custodians.
- [ ] Every claim/admin/UIA/RPC/Matrix kill point converges safely.
- [ ] S3 versioning and COMPLIANCE retention are verified.
- [ ] Off-host exact-version restore meets 24-hour RPO and 60-minute RTO.
- [ ] Fresh Ubuntu replacement-host recovery succeeds.
- [ ] Production-shaped devnet soak runs for 72 hours with required drills.
- [ ] Sanitized evidence-only PR is merged.
- [ ] Mainnet remains planned; no policy activation or 69,000-NEAL lock occurred.
