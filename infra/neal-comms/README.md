# NEAL communications deployment contract

This directory records the public identities that the production host must
preserve. It intentionally does not contain production secrets.

## Active public surfaces

```text
Site:           https://nealtheseal.org
Matrix mode:    first-party client + federated Synapse beta
Matrix client:  https://nealtheseal.org/#gc
Matrix server:  matrix.nealtheseal.org
Matrix account: @neal:matrix.nealtheseal.org
Matrix room:    #neal-gc:matrix.nealtheseal.org
Nostr relay:    not deployed
```

The site and Matrix discovery are hosted on Vercel. Synapse is delegated to the
filtered public endpoint recorded below.

## Active Matrix identity and reserved Nostr name

```text
Matrix server:  matrix.nealtheseal.org
Matrix account: @neal:matrix.nealtheseal.org
Matrix room:    #neal-gc:matrix.nealtheseal.org
Matrix room ID: !KliLLiEXeNPupDcYwe:matrix.nealtheseal.org
Matrix backend: https://matrix-home.tailadbebb.ts.net:10000/
Nostr relay:    wss://nostr.nealtheseal.org
```

A future selected host must provide isolated service state, encrypted off-host
backups, health monitoring, and a documented restore test.

NEAL Synapse uses PostgreSQL. The pinned strfry deployment in
`../nostr-relay` uses its own LMDB volume. They share Caddy and the VPS, but not
databases, secrets, media paths, or backup artifacts.

Current Matrix discovery uses Vercel; the table below is the later direct-host
DNS shape after a reviewed durable-host migration:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `@` | production host IPv4 |
| `CNAME` | `www` | `nealtheseal.org` |
| `A` | `matrix` | production host IPv4 |
| `A` | `nostr` | production host IPv4 |
| `AAAA` | `@` | production host IPv6, if intentionally enabled |
| `AAAA` | `matrix` | production host IPv6, if intentionally enabled |
| `AAAA` | `nostr` | production host IPv6, if intentionally enabled |

See [`../../docs/NEAL_SOVEREIGN_COMMS.md`](../../docs/NEAL_SOVEREIGN_COMMS.md)
for the rollout and security gates.
