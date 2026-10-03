# Manual devnet acceptance

Port `4280` is reserved for the reviewed HTTPS acceptance gateway. Ordinary
local UI development runs at `http://127.0.0.1:4282` and deliberately disables
wallet transactions, access-token issuance, Matrix login, and registration.

## Operator sequence

Use an exact clean commit with its release manifest, zero-P0–P2 isolated review,
mode-`0600` three-provider RPC credential, and a disposable devnet wallet public
key. Never provide the wallet recovery phrase or private key.

```sh
npm run access-stake:manual-devnet -- doctor \
  --release-manifest /path/to/release-manifest.json \
  --review-file /path/to/isolated-review.json \
  --rpc-set-file "$HOME/Library/Application Support/NEAL/devnet-rpc-set.json" \
  --wallet DISPOSABLE_DEVNET_PUBLIC_KEY

npm run access-stake:manual-devnet -- prepare \
  --release-manifest /path/to/release-manifest.json \
  --review-file /path/to/isolated-review.json \
  --rpc-set-file "$HOME/Library/Application Support/NEAL/devnet-rpc-set.json" \
  --wallet DISPOSABLE_DEVNET_PUBLIC_KEY \
  --execute --acknowledge-devnet
```

`prepare` prints the runtime directory, certificate path, and SHA-1 fingerprint.
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
volumes, runtime secrets, and trusted certificate. It refuses cleanup while a
stake or privileged reconciliation remains active.
