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
  --rpc-set-file /absolute/private/path/devnet-rpc-set.json \
  --review-file /absolute/path/isolated-review.json
```

That is a dry run. It validates the release, review attestation, policy, clean
checkout, private three-provider RPC contract, and 2-of-3 finalized devnet
agreement without funding or changing chain state. Credential URLs remain in
the mode-`0600` file and are never process arguments. Tool and service checks
happen only in the live rehearsal,
which additionally requires both `--execute` and `--acknowledge-devnet`.
The executor tears down containers and deletes its temporary directory even on
failure. Its only persistent output is a sanitized public receipt written to
the explicitly supplied `--receipt` location.

The manual Chrome harness is stricter than the disposable CI rehearsal. Its
Synapse and Postgres services attach only to Docker's internal network; only the
issuer receives a second egress network. Browser Matrix access is constrained
by the localhost gateway to the isolated server and prepared room. Manual
review approval additionally requires the detached signature made by the
repository-pinned independent review key; see
`docs/MANUAL_DEVNET_ACCEPTANCE.md`.

The release command compiles the selected Git commit twice from separate
source trees into separate Cargo target directories and rejects any byte or
size mismatch. A prefetched Cargo registry/source cache is mounted read-only
into both network-disabled builds; source trees are also read-only and compiled
output is never shared between builds. The Rust, Agave, and platform-tools
archives are each content-pinned and verified before extraction.
