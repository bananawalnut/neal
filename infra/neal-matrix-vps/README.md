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
- no-email account creation, guarded by short-lived access tokens
- public, plaintext GC reads through a fixed Caddy route; sign-in and room
  membership remain required to post
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
8. Run `python3 /srv/neal-matrix/configure_public_neal_gc.py` to apply the
   public-read/write-gated room policy and create the root-only Caddy reader
credential. Then run `verify_public.sh`, update NEAL's native registration
   provider to `matrix.nealtheseal.org`, and deploy the site.
9. Keep the local service frozen but intact for rollback until the VPS has passed
   a 24-hour soak. Do not run both copies publicly at once.

## Registration

The server accepts no-email registrations only when the user presents a
short-lived access token. Generate one on the VPS:

```bash
python3 /srv/neal-matrix/create_registration_token.py --uses 1 --minutes 15
```

The token is the only intentional secret printed by this command. NEAL's client
sends the selected username, password, and token directly to Synapse. Vercel
does not receive them.

### Stake-gated issuance

The production candidate in `infra/neal-access-issuer` replaces manual token
distribution only after the reviewed Solana program/config exists. Caddy shares
the issuer's Unix socket and exposes exactly three POST/OPTIONS routes from the
NEAL site origin. The issuer's liveness/readiness endpoints and Synapse admin
surface remain private.

For an existing VPS, copy the updated `Caddyfile`, `compose.yaml`,
`verify_public.sh`, and the complete `infra/neal-access-issuer` directory before
running its installer. Do not set the public wallet policy to `active` until the
installer's internal readiness check and `verify_public.sh
https://matrix.nealtheseal.org --with-access-issuer` both pass. The complete
program, rehearsal, activation, and pause sequence is in
`programs/access-stake/DEPLOYMENT.md`.

## Public GC feed

`https://matrix.nealtheseal.org/_neal/gc/messages` returns the canonical room's
plaintext message timeline without requiring a browser credential. Caddy
injects a guest reader token from the root-owned `runtime/caddy.env` and only
exposes the fixed GET route. It is never sent to the browser, and the room's
guest-access policy remains `forbidden`. The configuration script republishes
pre-cutover plaintext messages with explicit original attribution so the site
can show the complete current conversation without a privileged member token.
Run `configure_public_neal_gc.py` after a restore and `verify_public.sh` after
every gateway change.

## Read-only administrator monitor

The private site route at `https://nealtheseal.org/admin/` signs in directly
with Synapse and keeps its access token in browser-tab session storage. Caddy
maps two exact, GET-only paths for that page:

- `/_neal/admin/users` to the bounded Synapse account-list endpoint;
- `/_neal/admin/server` to the Synapse version endpoint.

Both paths require the exact `https://nealtheseal.org` browser origin and a
valid Synapse administrator access token. They return `no-store`, expose no
write method, and do not weaken the existing `/_synapse/admin/*` public block.
The portal reads room policy and membership through ordinary authenticated
Matrix Client API routes. It shows pending knock requests without exposing an
approval or rejection control. Never add a generic admin proxy or a credential
to the public site bundle.

## Backups and rollback

Hetzner backups provide seven rotating whole-disk restore points, but they are
not the only backup. Keep at least one encrypted `*.age` snapshot off the VPS.
The migration does not delete the local database or keys. If cutover fails,
stop the VPS, restore the prior DNS target, and run `resume_local_services.sh`.

Never publish or commit files under `runtime/`, a decrypted import directory,
the signing key, database dumps, registration tokens, or access tokens.
