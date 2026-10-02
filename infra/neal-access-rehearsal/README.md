# Isolated access-stake rehearsal

This harness is deliberately separate from the live Neal Matrix stack. It uses
`rehearsal.neal.invalid`, host ports `18008` (Synapse), `18009` (issuer), and
`18010` (one-shot fault proxy), and an OS temporary directory for every
database, keypair, shared secret, and log. The pinned Synapse/Postgres stack has
no production volume, port, DNS, or credential reference.

Run it only through the repository command:

```bash
npm run access-stake:rehearse-devnet -- \
  --release-manifest /absolute/path/release-manifest.json \
  --rpc-primary https://api.devnet.solana.com \
  --rpc-secondary https://independent-devnet-rpc.example \
  --review-file /absolute/path/isolated-review.json
```

That is a dry run. It validates the release, review attestation, tools, HTTPS
RPC URLs, and devnet genesis without funding or changing chain state. The live
rehearsal additionally requires both `--execute` and `--acknowledge-devnet`.
The executor tears down containers and deletes its temporary directory even on
failure. Its only persistent output is a sanitized public receipt written to
the explicitly supplied `--receipt` location.

The release command compiles the selected Git commit twice from separate
source trees into separate Cargo target directories and rejects any byte or
size mismatch. A prefetched Cargo registry/source cache is mounted read-only
into both builds; source trees are also read-only and compiled output is never
shared between builds.
