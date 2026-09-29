# Access stake deployment and activation

There are no production defaults for the stake amount or lock duration. Values
used by tests are fixtures, not approved economics. Record the selected atomic
amount, human-readable NEAL amount, and minimum lock before creating a config.

Activation is intentionally split into independently verifiable stages.

## 1. Release review

1. Obtain an independent review of the exact program and issuer commit.
2. Run `cargo test -p neal-access-stake --offline` and the issuer unit suite.
3. Build the SBF artifact reproducibly with the official Solana toolchain.
4. Record the artifact SHA-256, program key, program-data address, upgrade
   authority, reviewer, and reviewed commit outside the mutable policy file.
5. Back up the deployment/config authority using the operator's approved key
   custody process. Never commit or copy a keypair into this repository.

## 2. Devnet rehearsal

Deploy the reviewed artifact to devnet and initialize a fresh config. The
initializer is dry-run by default and verifies the RPC genesis, canonical mint,
revoked authorities, program account, PDA, and transaction simulation:

```bash
node scripts/initialize-access-stake-config.mjs \
  --cluster devnet \
  --rpc https://api.devnet.solana.com \
  --program-id REVIEWED_DEVNET_PROGRAM \
  --mint REVIEWED_DEVNET_TOKEN_2022_MINT \
  --authority-keypair /absolute/path/to/authority.json \
  --config-id 0 \
  --required-atomic-amount REVIEWED_AMOUNT \
  --minimum-lock-seconds REVIEWED_LOCK
```

Repeat with `--send` only after reviewing the dry-run receipt. Exercise stake,
claim, one-use Matrix registration, early-release rejection, timed release,
pause, release-while-paused, issuer failure reconciliation, and an encrypted
SQLite backup/restore against a non-production Synapse instance.

## 3. Mainnet program and config

Deploy the same reviewed artifact with the official Solana CLI. Re-run the
initializer against the approved mainnet RPC. Mainnet submission requires both
`--send` and `--acknowledge-mainnet`; the script prints only public receipt
data. Independently decode the finalized config and compare every term.

Do not continue if the upgrade authority, program-data address, artifact hash,
canonical mint, config PDA, amount, or lock differs from the release record.

## 4. Issuer and gateway

Install the issuer on the Matrix VPS without starting it, populate the exact
program/config values in `/etc/neal-access-issuer.env`, then start it. Its
internal `/readyz` check must confirm the finalized config, SQLite database,
Matrix client API, and registration secret. Run:

```bash
/srv/neal-matrix/verify_public.sh https://matrix.nealtheseal.org --with-access-issuer
```

The public verifier requires credentialed CORS only for the three exact issuer
routes, rejects other origins and methods, and confirms health endpoints remain
private.

## 5. Policy activation

The policy staging command validates the finalized program/config, canonical
Token-2022 mint, revoked mint/freeze authorities, exact terms, and all issuer
preflights before it will write `status: active`:

```bash
node scripts/stage-access-stake-policy.mjs \
  --program-id REVIEWED_PROGRAM \
  --config-address REVIEWED_CONFIG_PDA \
  --required-atomic-amount REVIEWED_AMOUNT \
  --minimum-lock-seconds REVIEWED_LOCK \
  --challenge-endpoint https://matrix.nealtheseal.org/v1/challenge \
  --verify-endpoint https://matrix.nealtheseal.org/v1/verify \
  --token-endpoint https://matrix.nealtheseal.org/v1/access-token
```

Review the dry-run receipt, repeat with `--write`, build the site, and merge the
policy change through the normal protected branch. Finally run
`node scripts/verify-access-stake-readiness.mjs --require-active` against the
deployed artifact and complete one real low-risk acceptance account.

## Pause and recovery

On incident, publish a `paused` site policy immediately, pause the on-chain
config with the reviewed authority, and stop new issuance. Never remove the
unstake UI or revoke a user's release path. Preserve the issuer database and
logs; a `failed` reservation requires operator reconciliation because Synapse
may hold an orphan token.
