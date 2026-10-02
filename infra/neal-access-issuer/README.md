# NEAL access issuer

This loopback-only service exchanges one finalized, claimed NEAL stake receipt
for one short-lived, one-use Synapse registration token. It is deliberately
separate from the public static site and never receives a Matrix username or
password.

It is a deployment candidate, not an active production service. The website's
`accessStake.status` must remain `planned` until the program, config, issuer,
and reverse proxy have been reviewed and deployed.

## Request flow

1. `POST /v1/challenge` stores and returns a five-minute Wallet Standard SIWS
   challenge.
2. `POST /v1/verify` verifies the exact Ed25519 message, consumes the challenge,
   and sets a ten-minute Secure/HttpOnly/SameSite cookie.
3. The wallet submits revision-bound `Stake` and `ClaimAccess` instructions.
4. `POST /v1/access-token` derives the receipt PDA and reads the config, receipt,
   and vault with `finalized` commitment.
5. SQLite reserves the receipt, then the issuer signer finalizes the on-chain
   `ConsumeClaim` instruction before Synapse is called. Synapse creates a token
   with `uses_allowed: 1` and a 15-minute expiry. A successful retry returns the
   same still-live token, never a second token. Restoring an old database cannot
   issue again because the receipt's finalized `issued_at` is authoritative.

If Synapse fails after a receipt is reserved, the service marks it failed and
does not retry automatically. An operator must determine whether Synapse
created an orphan token before resetting anything. This is intentionally
fail-closed.

## Production packaging

The supported VPS deployment uses a systemd dynamic user with both secrets
delivered through read-only credentials. It listens on
`/run/neal-access-issuer/issuer.sock`; that directory is
mounted read-only into the Caddy container. Caddy exposes only exact-path
`POST`/`OPTIONS` requests for `/v1/challenge`, `/v1/verify`, and
`/v1/access-token` from `https://nealtheseal.org`. `/healthz` and `/readyz`
remain host-internal.

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
lives under `/var/lib/neal-access-issuer`; include it in encrypted off-host
backups and test a restore before activation. Production installation is
restricted to Linux x86_64 with Python 3.13 and uses the hash-locked binary-wheel set in
`requirements-deploy.txt`; `requirements.txt` remains the portable local test
dependency declaration.

The supported backup command takes a consistent SQLite online snapshot and
wraps it in the versioned `NEALBKP1` envelope using scrypt (`N=32768`, `r=8`,
`p=1`) and AES-256-GCM. Passphrases are accepted only from an interactive TTY
or an exact-mode `0600` regular file:

```bash
python3 backup.py backup \
  --database /var/lib/neal-access-issuer/issuer.sqlite3 \
  --output /secure/off-host/issuer.nealbak \
  --passphrase-file /run/credentials/issuer-backup-passphrase

python3 backup.py restore \
  --input /secure/off-host/issuer.nealbak \
  --database /var/lib/neal-access-issuer/issuer.sqlite3 \
  --passphrase-file /run/credentials/issuer-backup-passphrase \
  --replace
```

Stop the issuer and checkpoint SQLite before restore. Restore refuses a
destination with WAL/SHM sidecars, verifies authentication and SQLite integrity,
then durably replaces the destination. Never place either the passphrase file or
encrypted backup in this repository.

## Required environment

```text
NEAL_ACCESS_DATABASE=/srv/neal-access-issuer/data/issuer.sqlite3
NEAL_ACCESS_SOLANA_RPCS=https://PRIMARY_RPC,https://INDEPENDENT_RPC
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
NEAL_ACCESS_ISSUER_KEYPAIR_FILE=/run/credentials/neal-access-issuer.service/issuer-keypair
NEAL_ACCESS_PUBLIC_ORIGIN=https://nealtheseal.org
NEAL_ACCESS_MATRIX_URL=http://127.0.0.1:8008
NEAL_ACCESS_MATRIX_SECRET_FILE=/srv/neal-matrix/runtime/synapse/registration-shared-secret
NEAL_ACCESS_SOCKET=/run/neal-access-issuer/issuer.sock
```

For isolated local testing, omit `NEAL_ACCESS_SOCKET` and use the loopback-only
`NEAL_ACCESS_BIND`/`NEAL_ACCESS_PORT` fallback. The process rejects non-loopback
TCP binds.

The SQLite directory and file are created as `0700` and `0600`, requests use a
bounded worker pool, request bodies are capped, expired ephemeral rows are
pruned, and a hard database-size ceiling fails closed. Back up the
database because it is the one-receipt/one-token ledger. Keep the Synapse shared
secret readable only by this service and Synapse operators.

## Test

```bash
python3 -m unittest -v test_issuer.py
```

If `/readyz` reports an administrator cleanup blocker, keep issuance stopped:

```bash
/opt/neal-access-issuer/venv/bin/python /opt/neal-access-issuer/reconcile.py --list
/opt/neal-access-issuer/venv/bin/python /opt/neal-access-issuer/reconcile.py --user-id '@exact-id:server'
```

Before activation, also run the end-to-end checklist in
`programs/access-stake/TESTING.md` against a non-production Synapse instance
and follow `programs/access-stake/DEPLOYMENT.md`. Passing `/readyz` is necessary
but not sufficient: it proves the database, finalized config, Matrix client API,
and secret are available, not that the independent security review occurred.
