# NEAL access production-readiness specification

Status: implementation target. Mainnet remains `planned`.

This document is normative for the production-ready milestone. It does not
authorize a mainnet deployment, a policy activation, or a 69,000-NEAL lock.
Normative requirements use **MUST**. Evidence may contain no credential,
password, token, signature, private RPC URL, wallet address, Matrix identifier,
or other personal information.

## Locked deployment profile

- Runtime: Ubuntu 24.04, systemd, Linux x86-64, CPython 3.12.
- Mainnet verification: exactly three independently managed RPC providers and
  strict finalized agreement from two distinct trust domains. Threshold
  reduction is forbidden.
- Public preview: devnet only, exactly one RPC, with the published single-source
  risk disclosure. Preview evidence never satisfies production readiness.
- Authority: autonomous Squads v4 vault index zero, three separate
  hardware-wallet custodians, threshold two, no unilateral config authority.
- Repository: protected `main`, two approvals, CODEOWNERS, stale-review
  dismissal, last-push approval, required checks, resolved conversations, admin
  enforcement, and no force-push or deletion.
- Backup: administrator-supplied S3-compatible object storage, 24-hour RPO and
  60-minute RTO. Upload credentials are append-only. Bucket versioning and
  COMPLIANCE Object Lock are mandatory. Snapshots are encrypted before upload
  to an off-host recovery public key. Decryption keys never exist on the issuer
  host. Off-host restore verification runs monthly and after any key/provider
  change or restore incident.

## Stable contracts

All producers and consumers MUST reject unknown required fields and unsupported
versions. Existing v1 readers remain available during migration. New asynchronous
issuer responses use `/v2` and errors use `neal.error/v1`.

The wallet policy adds:

```json
{
  "verification": {
    "mode": "single-rpc-devnet-preview | quorum-2-of-3",
    "providerCount": 1,
    "threshold": 1
  }
}
```

Mainnet policy and staging tools MUST reject `single-rpc-devnet-preview`.
Preview policy is a separate artifact and MUST NOT reuse or activate the
mainnet policy.

The systemd RPC credential uses `neal.solana-rpc-set/v1`. Devnet preview
accepts exactly one endpoint with threshold one. Quorum mode accepts exactly
three reviewed trust domains and threshold two. Credential-bearing URLs MUST
never appear in logs or evidence.

## Issuer and claim invariants

Ephemeral unauthenticated state is restart-discardable and bounded to 10,000
challenges, 10,000 wallet sessions, and 50,000 rate keys. IPv6 clients normalize
to `/64`. Requests are limited to 32 KiB, 32 workers, and bounded connection and
dependency timeouts. Unauthenticated traffic creates no durable rows.

Durable claim phases are monotonic:

```text
RESERVED
→ CHAIN_SUBMITTED
→ CHAIN_RETRY_REQUIRED (only after finalized quorum proves the stored blockhash expired)
→ CHAIN_CONSUMED
→ MATRIX_TOKEN_ENSURING
→ ADMIN_CLEANUP_PENDING
→ TOKEN_READY
→ REGISTRATION_IN_PROGRESS
→ REGISTRATION_COMPLETED
```

`attention_required` is independent of phase. Legacy rows become
`LEGACY_REVIEW`; they are never reinterpreted or automatically reissued. Each
claim persists an opaque operation ID, receipt, wallet, config/revision,
the current signed transaction, an append-only history of attempted signatures
and transaction commitments, an independently attributed finalized signature,
blockhash and last-valid block height,
recovery-key version, token generation
and commitment, expiry, Matrix counters, timestamps, and stable error code.
If a prior attempt consumes the receipt after a replacement has been persisted
and no attempted signature can be proven finalized, the claim remains
`CHAIN_CONSUMED` with `attention_required` and
`chain_signature_ambiguous`; it cannot advance to Matrix issuance until
operator reconciliation either attributes one journaled attempt after
two-of-three finalized verification or explicitly accepts an unattributed but
quorum-consumed receipt. Generic resume refuses this state. Both decisions are
hash-journaled and operator inspection exposes the finalized attribution and
append-only attempt history.
Upgrades quarantine submitted rows that predate recoverable blockhash metadata
as `LEGACY_REVIEW` rather than retrying or reissuing them. Pre-v6 rows already
at or beyond `CHAIN_CONSUMED` are also quarantined without inferring a finalized
signature from the last stored attempt.

Registration tokens are derived with domain-separated HMAC from a dedicated
versioned 32-byte recovery credential. The Solana issuer key is never reused and
plaintext registration tokens are never persisted. Token replacement requires
an explicit operator command and proof that Synapse reports `pending=0`,
`completed=0`, and the old token is expired or revoked.

Temporary administrator usernames and expected Matrix IDs MUST be journaled
before creation. Reconciliation administrators use the same state machine.
Startup and post-restore reconciliation scan the reserved prefix. Readiness
fails while any possibly active temporary administrator remains. Privileged
cleanup errors may not be swallowed and manual production token tooling is
forbidden.

## Finalized quorum and transactions

RPC calls execute concurrently with a five-second per-provider deadline and a
one-MiB response cap. Authorization requires byte-identical finalized raw
account state from two trust domains, the exact genesis, immutable program
bytes, config, mint, terms, revision, and authorities.

The exact signed consume transaction is persisted before broadcast. Identical
bytes are sent through at least two providers. A claim reaches
`CHAIN_CONSUMED` only after two providers report finalized receipt state with
`issued_at > 0`. Timeout, malformed response, alias/duplicate domain, wrong
genesis, oversized response, false finality, expired blockhash, or no majority
fails closed.

## `/v2` browser behavior

- `200 token_ready`: token, receipt, operation ID, expiry.
- `202 processing`: operation ID and `Retry-After`; never a token.
- `401`: reverify the wallet without restaking.
- `409`: completed registration or legacy/manual review.
- `422`: finalized stake is ineligible.
- `429`: bounded rate limit.
- `503`: dependency or global readiness failure.

The browser polls `202` with bounded exponential backoff. Tab storage may hold
only UIA session ID, username, provider, operation/receipt reference, and
completed stages; it never stores passwords. A lost final response first asks
for the password again and tries ordinary login. Existing-token and
return-to-stake choices remain reversible.

## Admin monitor

The browser never stores or forwards a Matrix administrator bearer token. A
separate Unix-socket broker authenticates the administrator against loopback
Synapse, verifies admin status, encrypts the Matrix token server-side, and sets
an opaque `Secure`, `HttpOnly`, `SameSite=Strict` cookie. Sessions expire after
15 minutes idle or one hour absolute. Logout and restart reconciliation revoke
underlying Matrix sessions.

The broker exposes only session create/delete and a bounded snapshot containing
server status/version, local accounts, room members, membership requests,
federated members, room-policy checks, and Hermes health. Admin responses use
`no-store`, CSP with `frame-ancestors 'none'`, `object-src 'none'`, and
`base-uri 'none'`, plus `nosniff`, `no-referrer`, and restrictive Permissions
Policy. Generic Synapse admin routes remain unavailable.

## Immutable S3 backup and restore

`NEALBKP2` authenticates format/schema version, source commit, ledger
generation, creation time, recovery-key fingerprint, size, digest, and encrypted
SQLite content. The issuer holds only the recovery public key. Upload credentials
may inspect versioning/Object Lock and append ciphertext under one prefix; they
MUST NOT list, read, delete, alter retention, or bypass governance.

Every upload MUST verify bucket versioning `Enabled`, Object Lock `Enabled`, and
default `COMPLIANCE` retention at least as long as the configured minimum. Each
put supplies COMPLIANCE retention and must return a version ID. An isolated
recovery host uses separate read-only credentials and the private key to fetch
an exact version, authenticate/decrypt it in private temporary storage, run
SQLite integrity/schema checks, and emit a sanitized verification receipt.

Restore creates a durable reconciliation marker before database replacement.
Only liveness is available until reconciliation verifies schema, recovery key,
claims, temporary admins, Matrix tokens, RPC quorum, program, and config.

## Release lineage and operations

The release bundle contains code, reconciliation and backup tools, services,
environment template, offline wheelhouse, SBOM, source commit, and a manifest of
every payload path, mode, size, and SHA-256. It installs to
`/opt/neal-access-issuer/releases/<commit>/`; `current` switches only after
verification and offline dependency installation. An old binary MUST NOT run
against a ledger that accepted traffic under a newer schema.

Metrics cover claim phases and age, admin uncertainty, quorum disagreement,
rate-map occupancy, active workers, backup and restore-verification age, disk,
issuer SOL, and broker revocation. Identifiers are redacted or keyed-hashed.
Credentials, tokens, passwords, signatures, and personal information are never
logged.

Emergency order is: stop issuer, read chain through quorum, pause through
Squads, confirm revision, publish paused status without hiding refund, reconcile
operations, then roll forward to a new reviewed program/config for code defects.

## Release gates

### G1 — Code-ready

- Rust, issuer, migration, policy, browser, broker, evidence, and packaging
  suites pass, including producer/consumer/live-fixture contracts.
- Crash injection at every SQLite, Solana, Matrix, cleanup, and HTTP boundary
  converges to zero or one valid token, no more than one registration, no token
  before finalized consumption, and zero orphan temporary admins.
- Single-RPC mainnet configuration is rejected by runtime, policy, and staging.
- No unresolved P0–P2; P3 needs written expiring acceptance.

### G2 — Release candidate

Freeze one commit; reproduce identical SBF bytes twice on clean runners; produce
bundle/release manifests, SBOM, checksums, provenance, and independent signed
review. Protect `main` before accepting the release PR.

### G3 — Public devnet preview

Deploy disposable devnet program/config/issuer using single-RPC preview mode and
the separate preview policy. Publish the exact disclosure below. No production
hostname, secret, mint, config, or Matrix data may be mounted.

> DEVNET PREVIEW · SINGLE RPC
> This preview relies on one third-party Solana data source. It may be unavailable, censor requests, observe queried wallet addresses, or return incorrect data. Issuance fails closed on errors. Mainnet access requires agreement from two of three independent providers.

### G4 — Production-ready rehearsal

Use three separately operated managed RPC providers against isolated
Synapse/Postgres and immutable devnet SBF. Rehearse every claim/admin kill point,
lying/unavailable RPC, interrupted UIA, stale restore, broker restart, Squads
pause, full dusted-vault refund, and teardown. Install the exact bundle on a
fresh Ubuntu replacement host, restore from immutable S3, demonstrate the
24-hour RPO and 60-minute RTO, then soak the production-shaped service for 72
hours with alerts, reboots, Matrix outage, RPC failover, backup, and
reconciliation drills. Sanitized evidence lands in an evidence-only PR.

Completion of G4 is the definition of **production-ready**. Missing reviewers,
custodians, providers, storage retention, off-host recovery key, or rehearsal
evidence blocks the gate; the requirement is not weakened.

## Later, separately authorized boundary

Mainnet deployment, configuration, policy activation, and the 69,000-NEAL
canary are outside this delivery. They require the same exact release lineage,
autonomous Squads authority, three managed providers, immutable mainnet program,
exact config, a separately protected policy PR, explicit treasury authorization,
and an operational commitment to the real 90-day refund.
