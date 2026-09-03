# NEAL Matrix on Hetzner

This directory migrates the existing `matrix.nealtheseal.org` Synapse identity
from the local Mac to an always-on Hetzner CX23. It deliberately preserves the
PostgreSQL data, media, signing key, macaroon secret, form secret, and shared
registration secret. The Mac's raw PostgreSQL data directory is never copied to
Linux; the migration uses a portable logical dump.

## Target

- Ubuntu 24.04 LTS on a Hetzner CX23 (2 vCPU, 4 GB RAM, 40 GB disk)
- Synapse 1.157.2, matching the source during the migration
- PostgreSQL 16
- Caddy TLS on ports 80/443
- no public Synapse admin API
- no-email account creation, guarded by short-lived registration tokens
- `nealtheseal.org` remains on Vercel
- Buzz/Nostr remains out of this deployment

## Migration sequence

1. Create the CX23 with the operator's existing SSH public key, Ubuntu 24.04,
   IPv4 and IPv6, backups enabled, and no extra volume.
2. SSH to the server and run `prepare_ubuntu_host.sh` as root.
3. Create a rehearsal snapshot without `--freeze`:

   ```bash
   ./infra/neal-matrix-vps/export_local_snapshot.sh \
     --output /private/tmp/neal-matrix-rehearsal.age
   ```

   The default age recipient and identity live beside the existing NEAL Matrix
   secrets as `migration-age-recipient` and `migration-age-identity`. The
   identity is mode `0600` and must be included in the operator's secure backup,
   but never in the migration archive itself.

4. Transfer it through SSH (the archive is decrypted only into a root-only
   import directory on the VPS):

   ```bash
   ./infra/neal-matrix-vps/transfer_snapshot.sh \
     root@VPS_IP \
     /private/tmp/neal-matrix-rehearsal.age
   ```

5. On the VPS, first run `/srv/neal-matrix/prepare_ubuntu_host.sh`, then run
   `/srv/neal-matrix/restore_snapshot.sh`. This restores
   Postgres and starts Synapse only on `127.0.0.1:8008`. Do not change DNS yet.
6. Verify user/room counts, the canonical room ID, signing-key presence, login,
   and a local client/federation probe.
7. At final cutover, make a fresh snapshot with `--freeze`, transfer it, run
   `restore_snapshot.sh --replace-existing`, point `matrix.nealtheseal.org`
   A/AAAA records to the VPS, and start Caddy with
   `docker compose up -d caddy`.
8. Run `verify_public.sh`, then update NEAL's native registration provider to
   `matrix.nealtheseal.org` and deploy the site.
9. Keep the local service frozen but intact for rollback until the VPS has passed
   a 24-hour soak. Do not run both copies publicly at once.

## Registration

The server accepts no-email registrations only when the user presents a
short-lived registration token. Generate one on the VPS:

```bash
python3 /srv/neal-matrix/create_registration_token.py --uses 1 --minutes 15
```

The token is the only intentional secret printed by this command. NEAL's client
sends the selected username, password, and token directly to Synapse. Vercel
does not receive them.

## Backups and rollback

Hetzner backups provide seven rotating whole-disk restore points, but they are
not the only backup. Keep at least one encrypted `*.age` snapshot off the VPS.
The migration does not delete the local database or keys. If cutover fails,
stop the VPS, restore the prior DNS target, and run `resume_local_services.sh`.

Never publish or commit files under `runtime/`, a decrypted import directory,
the signing key, database dumps, registration tokens, or access tokens.
