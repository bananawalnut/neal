# NEAL Matrix GC

## Active identity

- First-party client: `https://nealtheseal.org/#gc`
- Homeserver name: `matrix.nealtheseal.org`
- Client/federation backend: `https://matrix.nealtheseal.org/`
- NEAL account: `@neal:matrix.nealtheseal.org`
- Room alias: `#neal-gc:matrix.nealtheseal.org`
- Room ID: `!KliLLiEXeNPupDcYwe:matrix.nealtheseal.org`
- Room policy: federated, unencrypted, publicly readable, private-directory,
  knock-to-join, guest joining forbidden

The current room was created and verified on 2026-09-04 through the Matrix
Client API. Its short-lived owner token was logged out and the temporary
bootstrap administrator was erased immediately afterward. The canonical alias
was moved from the original encrypted room because Matrix room encryption is
not downgraded in place.

The original encrypted room remains preserved as
`#neal-gc-e2ee-archive-20260904:matrix.nealtheseal.org` with room ID
`!kBjRkJEIsGBWCyrBQO:matrix.nealtheseal.org`. Its history was not copied into
the unencrypted room.

## First-party client contract

The NEAL site uses the official `matrix-js-sdk`; visitors are not redirected to
Element. A local NEAL user may enter only the account localpart—`neal`, for
example—which the client expands to `@neal:matrix.nealtheseal.org`. A federated
user supplies a full Matrix ID; the browser discovers that identity's homeserver
through `/.well-known/matrix/client`. Credentials go directly from the browser
to the selected homeserver. NEAL and Vercel expose no login backend.

The current beta client supports:

- password login using a short NEAL username or a full federated Matrix ID;
- email-free NEAL and Salix account creation through one-use access-token
  flows, completed directly inside NEAL;
- Matrix.org and other compatible providers through their advertised SSO
  registration flows when selected;
- SSO login through any homeserver advertising `m.login.sso` or `m.login.cas`;
- a state-bound, single-use `m.login.token` callback which returns the user to
  the NEAL client without an Element redirect;
- session access-token storage scoped to the current browser tab;
- a plaintext, read-only room transcript before sign-in;
- knocking, accepting an invitation, unencrypted text messages, and signing out;
- admitting waiting knocks when the signed-in account has invite power.

The GC is intentionally public and not end-to-end encrypted. Anyone can read
messages on the NEAL site; signing in and joining the room are required only to
post. Users must not post secrets. Public history starts at the 2026-09-04
cutover notice because Matrix history-visibility changes are not retroactive.

The browser reads `https://matrix.nealtheseal.org/_neal/gc/messages` without a
credential. Caddy maps that one fixed GET route to the canonical room's Matrix
messages API and injects a server-held guest reader token. The token is stored
only in the VPS root-owned `runtime/caddy.env`; it is never sent to the site or
committed. Caddy accepts only GET on the fixed route, and room guest joining is
forbidden, so the public surface cannot post. The one plaintext message from
before the public-history cutover is republished with its original sender and
timestamp recorded in the event; this makes the complete current conversation
visible without retaining a privileged member token. Message bodies are
rendered as text, never HTML.

## Administrator monitor

`https://nealtheseal.org/admin/` is a private, read-only operational view. It
is not linked from public navigation and is marked `noindex`. An administrator
signs in directly with `matrix.nealtheseal.org`; the access token remains in
browser-tab session storage and is cleared on logout.

Caddy exposes only two monitor routes to the exact Neal site origin:
`GET /_neal/admin/users` and `GET /_neal/admin/server`. Each request still
requires a valid Synapse administrator token, returns `no-store`, and maps to
one fixed read-only Synapse endpoint. Other origins, write methods, and the raw
`/_synapse/admin/*` surface remain blocked. The monitor reads canonical-room
policy and membership through ordinary authenticated Matrix Client API routes.
Pending knock requests are listed with only their Matrix ID, homeserver,
request time, and waiting state; the monitor cannot approve or reject them.
Hermes publishes a credential-free `org.neal.hermes.health` room state event;
the monitor treats it as stale after 150 seconds.

For local development, Vite proxies only the two fixed monitor paths through
the loopback-bound dev server and supplies the production origin upstream.
Other Matrix client calls still go directly to the homeserver. This keeps the
production CORS allowlist unchanged while making local administrator sign-in
testable.

`matrix.nealtheseal.org` is the default account provider. It requires no email
or phone number and accepts only short-lived, one-use access tokens. The user
supplies that token, username, and password directly to the NEAL homeserver
from the browser client. Salix remains the self-service, no-email federated
fallback. NEAL and Vercel receive and store none of those values.

The additive `accessStake` wallet policy is currently `planned`, so the site
does not show a staking control or prompt for a transaction. Once a reviewed
program/config and issuer are deployed and the policy is explicitly set to
`active`, the NEAL provider panel can authenticate a wallet with server-issued
SIWS, stake the published amount, record a one-time finalized claim, and fetch
the resulting 15-minute/one-use token. The stake is refundable after its
snapshotted lock and the Matrix account remains valid after release. The issuer
never receives the user's Matrix username or password.
Other providers remain selectable when they expose a standard browser
registration flow. Existing accounts from any discoverable homeserver remain
supported. As verified on 2026-09-02, Matrix.org's current registration page
and Unredacted.org's Client API registration flow require email verification;
NEAL must not describe either as email-optional.

Room entry uses the immutable room ID instead of depending on the origin alias.
The client supplies `matrix.nealtheseal.org` and `salix.host` as federation
routes. A route only becomes a real outage
fallback after a joined user on that homeserver has caused it to replicate the
room; listing a server as `via` does not itself copy room state there.

Passwords are cleared from the form immediately after the login request. The
client never asks for a Matrix recovery key, wallet seed phrase, or wallet
signature. Attachments and push notifications are explicitly not part of this
beta.

## Current host layout

| Surface | Value |
| --- | --- |
| Host | Hetzner CX23, Nuremberg, Ubuntu 24.04 |
| Synapse client/federation listener | `127.0.0.1:8008` on the VPS |
| Reverse proxy | Caddy on public ports 80/443 |
| NEAL Postgres | PostgreSQL 16 on the private Docker network |
| Public endpoint and discovery | `https://matrix.nealtheseal.org/` |
| Deployment | `/srv/neal-matrix/compose.yaml` |

The Caddy gateway forwards Matrix client/federation paths while returning `404`
for `/_synapse/admin/*`. Synapse itself is bound only to loopback and local
administration remains private. The prior Mac services are frozen intact as a
short-term rollback source and are not part of the public path.

The existing Zenith Synapse remains `matrix.zenith-research.ca` and is not
renamed or presented as NEAL. Zenith and unrelated homeservers participate in
the GC through normal Matrix federation.

## Verified checks

As of 2026-09-04:

1. Matrix client versions return `200` through the public gateway.
2. Matrix federation version returns `200` through the public gateway.
3. The canonical room alias resolves to the recorded room ID.
4. The current room state contains no `m.room.encryption` event.
5. Room history is `world_readable`, while guest joining remains `forbidden`.
6. The public read-only feed returns only `m.room.message` events.
7. The public Synapse admin path returns `404`.
8. External federation discovery, TLS, server name, and signing-key checks pass.

## Remaining durability gates

The room is live as a beta, but the Mac is not represented as durable production
hosting until these are complete:

1. Join and promote an email-free Salix backup moderator.
2. Verify knock/admit/message exchange through Salix.
3. Configure and restore-test an encrypted off-device backup.
4. Complete a 24-hour VPS soak, then retire the frozen Mac services.

The Matrix room identity survives a later host move as long as the server name,
database, signing key, and media state are migrated together.
