# NEAL access issuer

This loopback-only service exchanges one finalized, claimed NEAL stake receipt
for one short-lived, one-use Synapse registration token. It is deliberately
separate from the public static site and never receives a Matrix username or
password.

It is a deployment candidate, not an active production service. The website's
`accessStake.status` must remain `planned` until the program, config, issuer,
and reverse proxy have been reviewed and deployed.

## Request flow

1. `POST /v2/challenge` stores and returns a five-minute Wallet Standard SIWS
   challenge.
2. `POST /v2/verify` verifies the exact Ed25519 message, consumes the challenge,
   and sets a ten-minute Secure/HttpOnly/SameSite cookie.
3. The wallet submits revision-bound `Stake` and `ClaimAccess` instructions.
4. `POST /v2/access-token` returns `202 processing` while the monotonic claim
   state machine verifies exact finalized state through the configured RPC mode.
5. SQLite persists the signed consume transaction before identical bytes are
   broadcast. In production, two trust domains must agree that `issued_at > 0`
   before Matrix token creation can begin.
6. Token creation, temporary-admin cleanup, token delivery, UIA progress, and
   registration completion are journaled as forward-only phases. A retry resumes
   the same operation and can return only the same unexpired derived token.

The `/v1` decoders remain temporarily available for compatibility. New clients
must use `/v2`. Ambiguous Matrix or chain failures remain resumable with an
`attention_required` marker; operators inspect and resume the exact operation
instead of resetting or reinterpreting ledger rows.

## Production packaging

The supported VPS deployment uses a systemd dynamic user with both secrets
delivered through read-only credentials. It listens on
`/run/neal-access-issuer/issuer.sock`; that directory is
mounted read-only into the Caddy container. Caddy exposes only exact-path
`POST`/`OPTIONS` requests for the exact `/v2` issuer routes from
`https://nealtheseal.org`. `/healthz` and `/readyz` remain host-internal.

Copy this directory to `/srv/neal-matrix/access-issuer`, then stage the service
without starting it:

```bash
sudo /srv/neal-matrix/access-issuer/install.sh
```

Fill `/etc/neal-access-issuer.env` only after the reviewed program and config
exist. Starting is a separate, fail-closed step:

```bash
sudo /srv/neal-matrix/access-issuer/install.sh --start
sudo /srv/neal-matrix/verify_public.sh https://matrix.nealtheseal.org --with-access-issuer
```

The installer never changes ownership of the Synapse runtime tree and does not
print either secret. Stage the issuer's 64-byte Solana keypair at
`/etc/neal-access-issuer-issuer-keypair.json` with mode `0600`. SQLite state
lives under `/var/lib/neal-access-issuer`. Production installation is
restricted to Ubuntu 24.04 Linux x86-64 with Python 3.12 and uses the checked-in,
hash-locked wheelhouse. `requirements.txt` remains the portable local-test
declaration.

## Immutable S3-compatible backup

Production snapshots use the versioned `NEALBKP2` envelope. The issuer takes a
consistent SQLite online snapshot, creates a random AES-256-GCM data key, and
wraps that key to an X25519 recovery public key. Authenticated metadata binds the
source commit, database schema, ledger generation, creation time, recovery-key
fingerprint, plaintext size, and plaintext digest. The old `NEALBKP1` decoder is
kept only so existing rehearsal artifacts remain recoverable.

Generate the recovery keypair on a separate recovery host:

```bash
python3 backup.py generate-keypair \
  --private-key /secure/off-host/neal-recovery-private.pem \
  --public-key /secure/off-host/neal-recovery-public.pem
```

Copy only the public key to the issuer host as
`/etc/neal-access-issuer-recovery-public.pem`. The private key must never be
placed on the issuer host, in the S3 target, in the repository, or in an
operator's routine workstation backup.

The administrator supplies an S3-compatible bucket and two distinct credential
files based on `s3-upload-target.example.json` and
`s3-restore-target.example.json`:

- The issuer credential is data-plane append-only. It may inspect bucket
  versioning/Object Lock and put objects under the configured prefix. It must
  not list, read, overwrite by version, delete, alter retention, or bypass
  governance.
- The recovery credential is off-host and read-only. It may list versions and
  fetch exact object versions, but it must not create, overwrite, or delete.

Before the first backup, enable bucket versioning and Object Lock at the storage
provider. Configure default **COMPLIANCE** retention of at least the target's
`retentionDays` (30 days minimum). `s3_backup.py` refuses to upload when either
setting is absent or weaker, sends COMPLIANCE retention on every object, and
requires the provider to return a version ID.

Install the upload target with exact mode `0600`, verify the target, and enable
the 02:00 UTC daily timer. The ledger generation is created transactionally in
the issuer database during schema initialization:

```bash
sudo install -m 0600 s3-upload.json /etc/neal-access-issuer-backup-s3.json
sudo systemctl start neal-access-issuer-backup.service
sudo systemctl enable --now neal-access-issuer-backup.timer
```

The repository includes an AWS-style append-only policy example. Equivalent
provider-specific policy is acceptable only when its effective permissions are
the same. Each upload actively proves that its credential cannot list versions
and cannot read back the exact uploaded object version; either capability makes
the operation fail. Access-key administration, bucket ownership, and retention
administration must be separate from the issuer process.

On an isolated recovery host, install the read-only credential and the private
key as exact-mode `0600` systemd credentials. The normal issuer installer never
installs or enables the restore-verifier unit. On the recovery host, use the
dedicated mode:

```bash
sudo install -m 0600 s3-restore.json /etc/neal-access-restore-s3.json
sudo install -m 0600 /secure/off-host/neal-recovery-private.pem /etc/neal-access-restore-private.pem
sudo /srv/neal-recovery/access-issuer/install.sh --install-restore-verifier
```

`neal-access-restore-verify.timer` downloads an exact immutable version,
decrypts it only in a private temporary directory, runs SQLite integrity checks,
and retains only a sanitized verification receipt. The default schedule is
monthly. Operations must also run this verification after key rotation, storage
provider changes, and every restore-related incident. Alert when the most recent
upload receipt is older than 24 hours or the restore-verification receipt is
older than 35 days.

The health checks are non-networked and safe for monitoring agents:

```bash
python3 s3_backup.py check-receipt --kind upload --receipt /var/lib/neal-access-issuer/last-backup-receipt.json
python3 s3_backup.py check-receipt --kind restore --receipt /var/lib/neal-access-restore-verifier/last-restore-verification.json
```

An actual replacement-host restore is still required before activation and on
the monthly drill schedule. Stop the issuer and checkpoint SQLite before
restore. Restore refuses WAL/SHM sidecars, validates the authenticated envelope
and database integrity, and durably replaces the destination. Issuance remains
blocked until post-restore reconciliation completes.

## Required environment

```text
NEAL_ACCESS_DATABASE=/srv/neal-access-issuer/data/issuer.sqlite3
NEAL_ACCESS_CHAIN_ID=solana:mainnet
NEAL_ACCESS_SOLANA_GENESIS_HASH=5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
NEAL_ACCESS_PROGRAM_ID=<reviewed deployed program>
NEAL_ACCESS_PROGRAM_DATA_ADDRESS=<reviewed immutable ProgramData>
NEAL_ACCESS_PROGRAM_SHA256=<reviewed SBF SHA-256>
NEAL_ACCESS_CONFIG_ADDRESS=<reviewed config PDA>
NEAL_ACCESS_MINT=8JBYSxrFRMf1Y4NcbjyEsxGPFe4AXzHXELmXh4WYDCBE
NEAL_ACCESS_EXPECTED_REVISION=<finalized config revision>
NEAL_ACCESS_EXPECTED_AMOUNT=69000000000
NEAL_ACCESS_EXPECTED_LOCK_SECONDS=7776000
NEAL_ACCESS_BACKUP_RECOVERY_PUBLIC_KEY_FILE=/etc/neal-access-issuer-recovery-public.pem
NEAL_ACCESS_ISSUER_KEYPAIR_FILE=/run/credentials/neal-access-issuer.service/issuer-keypair
NEAL_ACCESS_PUBLIC_ORIGIN=https://nealtheseal.org
NEAL_ACCESS_MATRIX_URL=http://127.0.0.1:8008
NEAL_ACCESS_MATRIX_SECRET_FILE=/srv/neal-matrix/runtime/synapse/registration-shared-secret
NEAL_ACCESS_SOCKET=/run/neal-access-issuer/issuer.sock
```

RPC endpoints are not environment variables. Install the reviewed
`neal.solana-rpc-set/v1` credential at
`/etc/neal-access-issuer-solana-rpc-set.json` with mode `0600`; systemd exposes
it read-only to the service. Mainnet requires the three-provider template and
strict two-of-three agreement. The one-provider template is accepted only when
`NEAL_ACCESS_CHAIN_ID=solana:devnet`.

For isolated local testing, omit `NEAL_ACCESS_SOCKET` and use the loopback-only
`NEAL_ACCESS_BIND`/`NEAL_ACCESS_PORT` fallback. The process rejects non-loopback
TCP binds.

The SQLite directory and file are created as `0700` and `0600`, requests use a
bounded worker pool, request bodies are capped, ephemeral state is held in
bounded TTL/LRU memory maps, and a hard database-size ceiling fails closed. Back up the
database because it is the one-receipt/one-token ledger. Keep the Synapse shared
secret readable only by this service and Synapse operators.

## Test

```bash
python3 -m unittest -v test_issuer.py test_admin_broker.py
```

If `/readyz` reports an administrator cleanup blocker, keep issuance stopped:

```bash
/opt/neal-access-issuer/venv/bin/python /opt/neal-access-issuer/reconcile.py --list
/opt/neal-access-issuer/venv/bin/python /opt/neal-access-issuer/reconcile.py --inspect OPERATION_ID
/opt/neal-access-issuer/venv/bin/python /opt/neal-access-issuer/reconcile.py --resume OPERATION_ID
```

Before activation, also run the end-to-end checklist in
`programs/access-stake/TESTING.md` against a non-production Synapse instance
and follow `programs/access-stake/DEPLOYMENT.md`. Passing `/readyz` is necessary
but not sufficient: it proves the database, finalized config, Matrix client API,
and secret are available, not that the independent security review occurred.
