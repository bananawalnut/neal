# Bare Nostr + Goose, without Buzz

Status: **relay bundle prepared for a future Linux host; deployment deferred**

## Minimal architecture

```text
Nostr client(s)
    |
    | signed Nostr events over WebSocket
    v
wss://nostr.nealtheseal.org  -->  strfry relay + LMDB
                                      |
                                      | subscribed event filters
                                      v
                               neal-nostr-bridge
                                      |
                                      | ACP / JSON-RPC
                                      v
                                  goose acp
                                      |
                                      v
                                model + reviewed tools
```

`strfry` is the selected relay because it has durable local
LMDB storage, NIP-11 relay information, NIP-42 authentication, configurable
write policy, metrics, export/import, and no external database service.

Buzz is not part of the launch stack. If a future Linux host also runs Synapse,
the relay may share that machine but never its database: Synapse uses PostgreSQL,
while strfry keeps a separate LMDB volume. Caddy terminates TLS for both
subdomains and both upstreams stay bound to loopback. The reviewed files live in
[`../infra/nostr-relay`](../infra/nostr-relay).

Goose does not currently provide a general-purpose bare-Nostr bot gateway. Its
Nostr support includes encrypted session sharing, while its live Nostr agent
integration is supplied by Buzz. A NEAL deployment without Buzz therefore
needs a small custom bridge.

## What ACP means here

ACP is the Agent Client Protocol. It is the control protocol between a client
and an agent, analogous to LSP between an editor and a language server. It uses
JSON-RPC methods for initialization, authentication, sessions, prompts,
progress, tool calls, permissions, and cancellation.

For NEAL:

- the Nostr bridge is the ACP **client**;
- Goose is the ACP **agent/server** through `goose acp`;
- the bridge turns an allowed signed Nostr event into `session/prompt`;
- Goose streams `session/update` events and a final stop reason back;
- the bridge signs the resulting Nostr reply with NEAL's dedicated agent key.

ACP does not provide Nostr transport, identity, persistence, or moderation. It
only lets the bridge drive Goose without scraping a terminal or depending on a
Goose-specific private API.

## Safe first scope

- one dedicated NEAL Nostr key;
- one public mention/thread event shape, not encrypted DMs;
- explicit allowlist or rate limit;
- one Goose session per Nostr thread;
- mention-only activation;
- no wallet keys, relay keys, unrestricted shell, or autonomous posting;
- durable event-id/session-id mapping and duplicate suppression;
- a kill switch and bounded prompt/tool budgets.

Private NIP-17 messaging, NIP-29 groups, media, wallet linking, paid actions,
and cross-posting to Matrix are later phases.

## Effort estimate

| Deliverable | Focused implementation time |
| --- | ---: |
| Public `strfry` relay with TLS, NIP-11 policy, persistence, and smoke tests | 1–2 hours once a Linux host and DNS exist |
| Goose installation, provider configuration, and local ACP smoke test | 1–2 hours |
| Minimal mention/thread bridge with signed replies and deduplication | 6–10 hours |
| Moderation, restart recovery, observability, backups, abuse tests, and runbook | 2–4 additional days |

A credible private agent prototype is about one focused day after hosting
exists. A public bot that can safely survive hostile input is closer to three
to five days. The bare relay itself is not the agent and does not require that
bridge to go online.

## Primary references

- [Agent Client Protocol](https://agentclientprotocol.com/get-started/introduction)
- [ACP v1 overview](https://agentclientprotocol.com/protocol/v1/overview)
- [Goose architecture](https://github.com/aaif-goose/goose/blob/main/documentation/docs/goose-architecture/goose-architecture.md)
- [strfry relay](https://github.com/hoytech/strfry)
