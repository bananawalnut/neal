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
NEAL_ACCESS_BIND=127.0.0.1
NEAL_ACCESS_PORT=8792
```

Install the pinned Python dependency in a dedicated virtual environment, then
run `issuer.py` as an unprivileged user. The process rejects non-loopback bind
addresses. Put only the three `/v1/*` routes behind an exact-path HTTPS reverse
proxy; do not expose Synapse's admin API or the issuer health route publicly.

The SQLite directory and file are created as `0700` and `0600`. Back up the
database because it is the one-receipt/one-token ledger. Keep the Synapse shared
secret readable only by this service and Synapse operators.

## Test

```bash
python3 -m unittest -v test_issuer.py
```

Before activation, also run the end-to-end checklist in
`programs/access-stake/TESTING.md` against a non-production Synapse instance.
