# Local NEAL Synapse host

This deployment runs a second, isolated Synapse instance for the permanent
Matrix identity `matrix.nealtheseal.org`.

It does not rename, copy, or modify the Zenith homeserver. NEAL has separate
launchd services, a Postgres cluster, media, secrets, logs, ports, and backups.
All NEAL state initially lives on the internal disk because the external APFS
volume stalled during `initdb` and even basic directory reads. Uploads are
limited to 25 MB and verified durable storage remains a production gate.

## Local layout

| Surface | Value |
| --- | --- |
| Synapse | `127.0.0.1:8010` |
| Filtered public gateway | `127.0.0.1:8011` |
| Postgres | `127.0.0.1:55433` |
| Public delegated endpoint | `https://matrix-home.tailadbebb.ts.net:10000/` |
| Service state | `~/Library/Application Support/Neal/Matrix` |
| Database, media, and local backups | `~/Library/Application Support/Neal/Matrix/state` |
| Launch services | `org.nealtheseal.matrix.postgres`, `org.nealtheseal.matrix.synapse`, `org.nealtheseal.matrix.gateway` |

The public endpoint and `matrix.nealtheseal.org` discovery records are live. The
Funnel must target port 8011, not raw Synapse on port 8010, so
`/_synapse/admin/*` remains unavailable publicly.

## Commands

Run with the existing pinned Synapse environment:

```bash
"$HOME/Library/Application Support/Zenith/Matrix/runtime/venv/bin/python" \
  infra/neal-matrix/deploy_local_neal_matrix.py bootstrap

"$HOME/Library/Application Support/Zenith/Matrix/runtime/venv/bin/python" \
  "$HOME/Library/Application Support/Neal/Matrix/bin/deploy_local_neal_matrix.py" status
```

Account creation is intentionally interactive so no password appears in shell
history or process arguments:

```bash
"$HOME/Library/Application Support/Zenith/Matrix/runtime/venv/bin/python" \
  "$HOME/Library/Application Support/Neal/Matrix/bin/deploy_local_neal_matrix.py" \
  register-user neal --admin
```

The canonical room is created through a one-use API session. Owner mode reads
the local registration secret without printing it, creates a temporary admin,
issues a five-minute token acting as NEAL, creates and verifies the room, logs
out, and erases the bootstrap admin:

```bash
python3 infra/neal-matrix/create_neal_gc.py --owner-api --yes
```

Federate the canonical room by inviting a real account on the email-free
Salix homeserver. The remote user must accept the invitation before Salix holds
a full replica. Re-run with `--promote` after it has joined:

```bash
python3 infra/neal-matrix/federate_neal_gc.py '@backup:salix.host'

python3 infra/neal-matrix/federate_neal_gc.py --promote '@backup:salix.host'
```

Running the script without user IDs audits which homeservers currently have
joined members. It creates only short-lived local API sessions and prints no
passwords or access tokens.
