# Manual devnet acceptance

Port `4280` is reserved for the reviewed HTTPS acceptance gateway. Ordinary
local UI development runs at `http://127.0.0.1:4282` and deliberately disables
wallet transactions, access-token issuance, Matrix login, and registration.

## Operator sequence

Use an exact clean commit with its release manifest, zero-P0–P2 isolated review,
detached signature from the repository-pinned independent reviewer,
mode-`0600` three-provider RPC credential, and a disposable devnet wallet public
key. Never provide the wallet recovery phrase or private key.

```sh
npm run access-stake:manual-devnet -- doctor \
  --release-manifest /path/to/release-manifest.json \
  --issuer-bundle /path/to/issuer-bundle.tar \
  --browser-bundle /path/to/manual-browser-bundle.json \
  --review-file /path/to/isolated-review.json \
  --review-signature-file /path/to/isolated-review-signature.json \
  --rpc-set-file "$HOME/Library/Application Support/NEAL/devnet-rpc-set.json" \
  --wallet DISPOSABLE_DEVNET_PUBLIC_KEY

npm run access-stake:manual-devnet -- prepare \
  --release-manifest /path/to/release-manifest.json \
  --issuer-bundle /path/to/issuer-bundle.tar \
  --browser-bundle /path/to/manual-browser-bundle.json \
  --review-file /path/to/isolated-review.json \
  --review-signature-file /path/to/isolated-review-signature.json \
  --rpc-set-file "$HOME/Library/Application Support/NEAL/devnet-rpc-set.json" \
  --wallet DISPOSABLE_DEVNET_PUBLIC_KEY \
  --execute --acknowledge-devnet
```

`prepare` prints the runtime directory, certificate path, and SHA-1 fingerprint.
The browser bundle is built by exact-head CI after a clean `npm ci`; its source,
Node toolchain, package-lock hash, and file bytes are covered by the independent
review signature. `prepare` only validates and extracts that reviewed bundle.
`start` serves only those prepared bytes and rejects source, bundle, image,
certificate, or commit drift.
If preparation fails after its first devnet write, the command stops local
containers and preserves the mode-`0700` runtime plus an operator-recovery
marker instead of deleting keys that may still control a partial disposable
deployment.
Import that exact certificate into the macOS login keychain and mark it trusted,
then run:

```sh
npm run access-stake:manual-devnet -- start \
  --runtime "/printed/runtime/directory" \
  --acknowledge-certificate-trusted

npm run access-stake:manual-devnet -- verify \
  --runtime "/printed/runtime/directory"
```

`start` waits for deep readiness before opening Google Chrome at
`https://localhost:4280/#gc`. The page must say `READY FOR MANUAL ACCEPTANCE`,
show `69,000 TEST NEAL · 120-SECOND REFUNDABLE LOCK`, and identify the exact
program, config, mint, expected wallet, lease, and 2-of-3 quorum. Production
90-day terms on localhost are a hard failure.

Use `status` for a sanitized snapshot and
`fault --name matrix-final-response-once` before the registration recovery
step. After the full refund and reconciliation, `stop` removes the local stack,
volumes, runtime secrets, and trusted certificate. It first records a draining
state and pauses the disposable config at finalized 2-of-3 quorum. If a stake
is still active, services remain available for the wallet's refund while new
stake and claim instructions are blocked. Cleanup proceeds only after the
gateway and issuer are stopped, a finalized barrier passes, all receipts are
released, and privileged reconciliation is empty.
