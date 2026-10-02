# Access stake deployment and activation

The approved production terms are **69,000 NEAL**, represented as
`69000000000` atomic units at six decimals, with a fixed **90-day** minimum
lock, represented as `7776000` seconds. “Three months” is deliberately encoded
as a fixed 90-day interval because the on-chain config stores seconds rather
than calendar dates. Deployment commands still require these values explicitly;
test fixtures and script invocations are not implicit production defaults.

Activation is intentionally split into independently verifiable stages.

## 1. Release review

1. Obtain an independent review of the exact program and issuer commit.
2. Run `cargo test -p neal-access-stake --offline` and the issuer unit suite.
3. Build the SBF artifact twice from the exact clean commit with the pinned,
   hash-verified Agave/container toolchain:

   ```bash
   npm run access-stake:reproduce -- \
     --commit FULL_40_CHARACTER_COMMIT \
     --output outputs/access-stake-release
   ```

   The command uses two independent source and Cargo target directories, requires
   byte-identical output, and emits `neal.access-stake-release/v1` beside the
   final `.so`.
4. Record the artifact SHA-256, program key, program-data address, upgrade
   authority, reviewer, and reviewed commit outside the mutable policy file.
5. Back up the deployment/config authority using the operator's approved key
   custody process. Never commit or copy a keypair into this repository.

## 2. Devnet rehearsal

The supported end-to-end executor is dry-run by default. It requires two HTTPS
RPCs on distinct hosts and a `neal.access-stake-isolated-review/v1` attestation
covering the exact release commit with zero unresolved P0-P2 findings:

```bash
npm run access-stake:rehearse-devnet -- \
  --release-manifest outputs/access-stake-release/release-manifest.json \
  --rpc-primary https://api.devnet.solana.com \
  --rpc-secondary "$NEAL_DEVNET_RPC_SECONDARY" \
  --review-file outputs/isolated-review.json
```

The dry run validates the release and review documents, planned policy, clean
checkout, and independent finalized devnet agreement while reading chain state
only. It does not start the local rehearsal services; the executing run performs
those service and tool checks. Devnet writes require both
`--execute --acknowledge-devnet`. The live run creates an isolated disposable
Synapse/Postgres stack on loopback ports 18008-18010, a disposable issuer on
18009, an immutable deployment of the exact release artifact, a six-decimal
140,000-token Token-2022 mint with disabled authorities, and two configs:

- config 0: `69000000000` atomic units and `7776000` seconds;
- config 1: `1000000` atomic units and `120` seconds.

It verifies SIWS, stake/claim/consume, one-use Matrix registration, stale
backup replay resistance, injected temporary-admin cleanup failure and
reconciliation, early-release rejection, pause rejection, full pre-dusted vault
refund while paused, and unpause. Temporary identities and credentials are
deleted during teardown. The only persistent output is a sanitized
`neal.access-stake-devnet-rehearsal/v1` receipt and public step log. Validate a
receipt offline with:

```bash
npm run access-stake:validate-evidence -- --file /path/to/devnet-receipt.json
```

Commit the validated receipt under
`programs/access-stake/evidence/devnet/YYYY-MM-DD-SHORTSHA.json` in a separate
evidence-only pull request. Do not activate policy as part of that pull request.

Deploy the reviewed artifact to devnet and initialize a fresh config. The
initializer is dry-run by default and verifies the RPC genesis, canonical mint,
revoked authorities, program account, PDA, and transaction simulation:

```bash
node scripts/initialize-access-stake-config.mjs \
  --cluster devnet \
  --rpc https://api.devnet.solana.com \
  --program-id REVIEWED_DEVNET_PROGRAM \
  --program-data-address REVIEWED_DEVNET_PROGRAM_DATA \
  --program-sha256 REVIEWED_SBF_SHA256 \
  --mint REVIEWED_DEVNET_TOKEN_2022_MINT \
  --authority-keypair /absolute/path/to/authority.json \
  --issuer-authority REVIEWED_DEVNET_ISSUER \
  --config-id 0 \
  --required-atomic-amount REVIEWED_AMOUNT \
  --minimum-lock-seconds REVIEWED_LOCK
```

Repeat with `--send` only after reviewing the dry-run receipt. Exercise stake,
claim, one-use Matrix registration, early-release rejection, timed release,
pause, release-while-paused, issuer failure reconciliation, and an encrypted
SQLite backup/restore against a non-production Synapse instance. The rehearsal
issuer must use `NEAL_ACCESS_CHAIN_ID=solana:devnet` with the devnet genesis;
the service rejects an ID/genesis mismatch.

The repository also provides a manually dispatched `Access-stake devnet
rehearsal` workflow. It requires the exact source commit, explicit devnet
acknowledgement, `NEAL_DEVNET_RPC_SECONDARY`, and a base64-encoded isolated
review attestation in `NEAL_ACCESS_REVIEW_ATTESTATION_B64`. It uploads the
release manifest, `.so`, public review attestation, receipt, and sanitized log,
and creates GitHub build-provenance attestations for each file; it never commits
or changes the production policy. Configure the `access-stake-devnet`
environment with required reviewers and keep both secrets in that environment,
not at repository scope. Verify downloaded evidence with `gh attestation verify
FILE --repo OWNER/REPOSITORY` in addition to the offline schema validator.

Use the same first-party pause tool on devnet. It simulates by default:

```bash
node scripts/manage-access-stake-config.mjs \
  --action pause \
  --cluster devnet \
  --rpc https://api.devnet.solana.com \
  --program-id REVIEWED_DEVNET_PROGRAM \
  --config-address REVIEWED_DEVNET_CONFIG \
  --authority-keypair /absolute/path/to/authority.json
```

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
  --program-data-address REVIEWED_PROGRAM_DATA \
  --program-sha256 REVIEWED_SBF_SHA256 \
  --config-address REVIEWED_CONFIG_PDA \
  --config-revision REVIEWED_CONFIG_REVISION \
  --issuer-authority REVIEWED_ISSUER_AUTHORITY \
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

Readiness exits nonzero for `planned` unless the operator explicitly requests
the reporting-only `--informational-planned` mode.

## Pause and recovery

On incident, stop the issuer, then use `manage-access-stake-config.mjs --action
pause`. Mainnet submission requires `--send --acknowledge-mainnet`; adding
`--write-policy` updates the policy to the finalized revision only after the
chain transition is verified. Never remove the unstake UI or revoke a user's
release path. Before restarting an unpaused issuer, update
`NEAL_ACCESS_EXPECTED_REVISION` to the newly finalized revision and require
`/readyz` to pass again.

Preserve the issuer database and logs. List unresolved ephemeral-admin cleanup
records with `reconcile.py --list`; reconcile one exact ID with
`reconcile.py --user-id '@user:server'`. The command revokes a possibly-created
registration token, deactivates the orphan admin, and also deactivates its own
temporary reconciliation admin before issuance can resume.
