# Security policy

## Supported code

Only the current protected `main` branch is supported. Preview branches,
development deployments, disposable devnet programs, and local rehearsal
services are not production systems.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** link in the repository Security tab.
That opens a private security advisory visible only to the reporter and the
repository maintainers. Do not disclose a vulnerability, credential, wallet
secret, access token, password, recovery phrase, private key, or sensitive log
in a public issue, pull request, discussion, commit, or chat room.

Include only the minimum information needed to reproduce the issue:

- affected commit, URL, component, or contract address;
- impact and required preconditions;
- reproducible steps using disposable accounts and devnet whenever possible;
- sanitized logs or transaction signatures; and
- a safe way to contact the reporter through the private advisory.

Never send a wallet recovery phrase or private key. Maintainers will never ask
for one.

## Response

Maintainers will acknowledge a complete report within two business days,
triage severity, preserve relevant evidence, and coordinate remediation before
public disclosure. Mainnet issuance will fail closed or be paused when a report
could affect authorization, receipt consumption, Matrix account creation,
refund safety, administrator cleanup, backups, or credential confidentiality.

## Secrets found in history

Revoke or rotate an exposed credential before attempting history cleanup.
Removing a value in a later commit does not remove it from Git history, forks,
caches, workflow logs, or downloaded artifacts. After revocation, rewrite every
affected ref, rescan a clean mirror, and coordinate any required cache removal
with the hosting provider.
