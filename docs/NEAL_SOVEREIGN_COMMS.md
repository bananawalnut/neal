# NEAL sovereign communications

Status: **site on Vercel; first-party Matrix GC beta live; Nostr relay deferred**

## Decision

NEAL launches with a first-party Matrix client and a separately isolated
Synapse beta. Nostr remains future work:

| Domain | Service | Job |
| --- | --- | --- |
| `matrix.nealtheseal.org` | Synapse + Caddy on Hetzner | Live beta; federated GC origin |
| `nostr.nealtheseal.org` | Future strfry | Reserved; not deployed |

The current site is the Matrix client: it discovers the user's homeserver and
uses the Matrix API directly. It does not send visitors to Element. The room is
`#neal-gc:matrix.nealtheseal.org`; Zenith keeps its existing Matrix identity and
participates through federation rather than being presented as NEAL's origin.

## Why a bare relay instead of Buzz

Buzz adds a workspace UI, Postgres, Redis, object storage, membership, media,
workflows, and its own agent harness. NEAL does not need that product for the
first signed-event layer. The selected `strfry` relay stores events in its own
LMDB volume and has no external database dependency.

This is cheaper and simpler, but deliberately does not pretend to supply a
Slack-like workspace. Membership, moderation, media, and agent routing are
separate features. [`NOSTR_GOOSE.md`](NOSTR_GOOSE.md) defines the later minimal
bridge to Goose.

## Goose and the agent stack

Goose is the model-agnostic agent runtime. It exposes an ACP process with
`goose acp`. A future NEAL-owned bridge connects the two systems:

```text
strfry --Nostr WebSocket--> neal-nostr-bridge --ACP over stdio--> goose acp
     ^                              |
     |                              +--> signed Nostr replies/actions
     +----------- dedicated Nostr identity for the NEAL agent
```

Each agent receives its own Nostr keypair and relay membership. The relay's
signing key, the human owner's key, and every agent key are separate. The Goose
process may run on a private Zenith/NEAL machine and only needs outbound HTTPS/
WebSocket access to the relay; it does not need a public port.

Start with one manually admitted NEAL agent, mention-only subscriptions, one
channel, and one in-flight turn per channel. Workflows, multiple agents, shell
or file-edit MCP tools, and autonomous response policies stay disabled until
the audit and permission model is reviewed.

## Initial access policy

- The GC is unencrypted and knock-to-join. Messages are visible to joined
  members and homeserver operators, so the room must not be used for secrets.
  Account recovery and a second
  cross-homeserver moderator remain required durability work.
- NIP-42 is enabled for restricted private-event reads; public writes remain
  policy-controlled and rate-limited at the proxy/relay boundary.
- Human and agent Nostr keys are generated separately, stored outside Git, and
  included in encrypted backups when appropriate.
- No agent receives a wallet seed, Synapse signing key, relay signing key, or
  unrestricted host filesystem access.
- Matrix-to-Nostr mirroring is not enabled initially. A bridge would need an
  explicit consent, identity-linking, deletion, and loop-prevention design.

## Current Matrix deployment

The Synapse beta runs on an always-online Hetzner CX23 with PostgreSQL 16 and
Caddy. The original database, media state, server signing key, and
`matrix.nealtheseal.org` identity were migrated together. Caddy blocks public
admin APIs; Synapse listens only on loopback. Hetzner daily backups are enabled,
and an encrypted final snapshot remains off-server for rollback. See
[`MATRIX_GC.md`](MATRIX_GC.md) and
[`../infra/neal-matrix-vps`](../infra/neal-matrix-vps).

## Optional eventual single-host layout

A small public Linux host can run both stacks behind one reverse proxy while
keeping their state isolated:

```text
Internet
  |-- matrix.nealtheseal.org:443 --> Caddy --> NEAL Synapse --> Matrix Postgres
  `-- nostr.nealtheseal.org:443  --> Caddy --> strfry --> isolated LMDB volume

Private agent host --> wss://nostr.nealtheseal.org --> bridge --> goose acp
Zenith Synapse <---- Matrix federation -----------> NEAL Synapse
```

The current delegated backend is on the Mac, so availability follows that
machine. The filtered gateway reduces exposure but does not replace monitoring,
backups, recovery, or an eventual always-on host.

## Durable-host and Nostr order

1. Select the public Linux host and obtain its stable IPv4 address.
2. Prepare a closed-registration Synapse with a dedicated database, private
   administration, and restored copies of NEAL's database, signing key, media,
   and secrets; do not create a second Matrix identity.
3. Cut the existing discovery delegation to the reviewed durable endpoint only
   after a migration rehearsal passes.
4. Verify Matrix federation from Zenith and an unrelated public homeserver.
5. Deploy the pinned strfry image from `infra/nostr-relay` behind the same Caddy
   instance, keeping port 7777 and metrics on loopback.
6. Verify the final relay URL, NIP-11, NIP-42, signed publish/read, restart
   persistence, limits, and backup restoration.
7. Create a separate NEAL agent key and attach Goose through the reviewed custom
   bridge in mention-only mode.
8. Publish the Nostr entry point only after its launch gates pass; the Matrix
   client and room are already live as a separately labelled beta.

## Primary references

- [strfry relay](https://github.com/hoytech/strfry)
- [Goose](https://github.com/aaif-goose/goose)
