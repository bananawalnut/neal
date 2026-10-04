# Public repository security review

Review date: 2026-10-04

Baseline release commit: `935e3ab1d8eddc6bbe7b145bdd2d273ad6260e0f`

Repository: `bananawalnut/neal`

## Scope

The review used a fresh mirror of every GitHub branch and pull-request ref,
covering 69 unique reachable commits and 26 remote refs. It also inspected the
working tree, commit metadata, sensitive-looking filenames, image metadata,
GitHub discussions, available workflow logs, retained workflow artifacts, and
retrievable Vercel build logs.

The retained Actions artifact corpus contained 106 extracted files totalling
approximately 676 MiB. Nested archives were scanned to a depth of four.

## Method

- Gitleaks `8.30.1` scanned the complete reachable Git history with full value
  redaction.
- Provider-specific checks covered credential-bearing Helius, QuickNode, and
  Alchemy URL forms.
- Each component of the locally configured devnet RPC credentials was compared
  against the complete mirrored history without printing or persisting those
  credentials.
- Additional history checks covered private-key PEM blocks, common provider
  tokens, 64-byte Solana keypair arrays, local absolute paths, database dumps,
  wallet recovery material, office documents, and report source files.
- Current repository images were checked for author, device, and geolocation
  metadata.
- GitHub issue and pull-request bodies, comments, reviews, available Actions
  logs, and retained artifacts were scanned without retaining unredacted log
  content.
- All retrievable `neal-site` Vercel build logs were streamed directly into the
  scanner without retaining unredacted content.

## Findings

No credential, private key, recovery phrase, password, access token, personal
filesystem path, personal email domain, database snapshot, or private report
was found in the reviewed surfaces.

The default Gitleaks rules reported eight instances across history. Manual
review confirmed that they were repetitions of two public Solana identifiers:
the mainnet genesis hash and canonical NEAL mint. The repository configuration
allowlists only those two exact identifiers; it does not allowlist their files,
variable names, providers, or generic key patterns.

The exact configured devnet RPC URLs and their credential components were not
present in any mirrored commit. GitHub had no repository or environment secret
values available for retrieval; the inventory contained no repository secrets
or variables and no environment secrets or variables. No GitHub Releases or
GitHub Pages deployment existed at review time.

## Publication controls

- `.gitleaks.toml` extends the default detector set and narrowly allowlists the
  two reviewed public identifiers.
- CI performs a required full-history scan from a checkout with complete
  history and no persisted GitHub credential.
- `SECURITY.md` directs reports to GitHub private vulnerability reporting and
  prohibits public disclosure of sensitive material.
- The repository grants no source-code license. Publication makes the contents
  viewable but does not make them open source.

## Residual requirements

Immediately before changing visibility, scan a fresh mirror containing the
publication-control commit and require a zero-finding result. After changing
visibility, enable private vulnerability reporting, secret scanning, push
protection, and protected-branch requirements, then verify their effective
state through the GitHub API.

If a future scan finds a real credential, revoke or rotate it before rewriting
history. A later deletion is not a substitute for revocation.
