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
3. The wallet submits `Stake` and `ClaimAccess` to Solana.
4. `POST /v1/access-token` derives the receipt PDA and reads the config, receipt,
   and vault with `finalized` commitment.
5. SQLite reserves the receipt before Synapse is called. Synapse creates a token
   with `uses_allowed: 1` and a 15-minute expiry. A successful retry returns the
   same still-live token, never a second token.

If Synapse fails after a receipt is reserved, the service marks it failed and
does not retry automatically. An operator must determine whether Synapse
created an orphan token before resetting anything. This is intentionally
fail-closed.

## Production packaging

The supported VPS deployment runs as the unprivileged `neal-access` system
user. It listens on `/run/neal-access-issuer/issuer.sock`; that directory is
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

The installer changes the existing Synapse registration secret to mode `0640`,
owned by Synapse's UID and the `neal-access` group. It does not print that
secret. The SQLite state lives under `/var/lib/neal-access-issuer`; include it
in encrypted off-host backups and test a restore before activation.

## Required environment

```text
NEAL_ACCESS_DATABASE=/srv/neal-access-issuer/data/issuer.sqlite3
NEAL_ACCESS_SOLANA_RPC=https://...
NEAL_ACCESS_PROGRAM_ID=<reviewed deployed program>
NEAL_ACCESS_CONFIG_ADDRESS=<reviewed config PDA>
NEAL_ACCESS_MINT=8JBYSxrFRMf1Y4NcbjyEsxGPFe4AXzHXELmXh4WYDCBE
NEAL_ACCESS_PUBLIC_ORIGIN=https://nealtheseal.org
NEAL_ACCESS_MATRIX_URL=http://127.0.0.1:8008
NEAL_ACCESS_MATRIX_SECRET_FILE=/srv/neal-matrix/runtime/synapse/registration-shared-secret
NEAL_ACCESS_SOCKET=/run/neal-access-issuer/issuer.sock
```

For isolated local testing, omit `NEAL_ACCESS_SOCKET` and use the loopback-only
`NEAL_ACCESS_BIND`/`NEAL_ACCESS_PORT` fallback. The process rejects non-loopback
TCP binds.

The SQLite directory and file are created as `0700` and `0600`. Back up the
database because it is the one-receipt/one-token ledger. Keep the Synapse shared
secret readable only by this service and Synapse operators.

## Test

```bash
python3 -m unittest -v test_issuer.py
```

Before activation, also run the end-to-end checklist in
`programs/access-stake/TESTING.md` against a non-production Synapse instance
and follow `programs/access-stake/DEPLOYMENT.md`. Passing `/readyz` is necessary
but not sufficient: it proves the database, finalized config, Matrix client API,
and secret are available, not that the independent security review occurred.
