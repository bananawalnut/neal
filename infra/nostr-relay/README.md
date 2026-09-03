# NEAL bare Nostr relay

This directory runs a minimal, durable `strfry` relay on the same public Linux
VPS as NEAL Synapse. It deliberately does not include Buzz, Postgres, Redis,
object storage, a web workspace, or an agent.

## Local endpoint

- WebSocket: `ws://127.0.0.1:7777`
- NIP-11: `http://127.0.0.1:7777` with `Accept: application/nostr+json`
- Metrics: `http://127.0.0.1:7777/metrics`
- Event data: Docker volume `neal-nostr-relay-data` on the VPS disk

The Compose port is explicitly bound to host loopback. Caddy on the VPS exposes
only `wss://nostr.nealtheseal.org`; the database and metrics endpoint remain
private. See `Caddyfile.example` for the shared Matrix/Nostr proxy layout.

## Run and verify

```sh
docker compose -f infra/nostr-relay/compose.yaml pull
docker compose -f infra/nostr-relay/compose.yaml up -d
curl -fsS -H 'Accept: application/nostr+json' http://127.0.0.1:7777 | jq
node infra/nostr-relay/smoke-test.mjs > infra/nostr-relay/smoke-test.receipt.json
docker compose -f infra/nostr-relay/compose.yaml restart relay
node infra/nostr-relay/smoke-test.mjs infra/nostr-relay/smoke-test.receipt.json
```

The smoke-test signing key is generated in memory and discarded. The receipt
contains only a public event, public key, signature, and event id.

## Host sizing and public endpoint

The intended stable URL is `wss://nostr.nealtheseal.org`. Run it on the same VPS
as NEAL Synapse/Postgres/Caddy. The relay is a small incremental load; Synapse and
Postgres determine host sizing. Use separate Unix users or containers, separate
data volumes, and separate backup artifacts so one service cannot casually
overwrite the other.

Do not publish DNS or open ingress until TLS, WebSocket proxying, abuse limits,
monitoring, and backups are verified. Nostr user identity is the user's key, so
moving the relay later does not change user keys.

## Data operations

Inspect logs:

```sh
docker compose -f infra/nostr-relay/compose.yaml logs --tail=100 relay
```

Export all events before an image upgrade:

```sh
docker compose -f infra/nostr-relay/compose.yaml exec -T relay \
  /app/strfry --config /etc/strfry.conf export > neal-nostr-events.jsonl
```

Stop without deleting data:

```sh
docker compose -f infra/nostr-relay/compose.yaml down
```

Never add `-v` to `down` unless the explicit intent is to delete the relay
database. The current image is pinned by multi-platform manifest digest.
