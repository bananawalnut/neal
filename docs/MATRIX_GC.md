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

The current client supports:

- password login using a short NEAL username or a full federated Matrix ID;
- email-free NEAL account creation directly on `matrix.nealtheseal.org`, using
  the homeserver's standard Matrix interactive-auth flow;
- Google reCAPTCHA v2 through Synapse's standard browser fallback, with an
  optional one-use registration token when the server is in invite-only mode;
- account availability checks, password confirmation, a server-enforced
  12-character minimum, automatic sign-in, and an automatic knock on the
  canonical NEAL GC after successful creation;
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

The create-account button always creates a genuine federated account on
`matrix.nealtheseal.org`; it is not a NEAL-only profile and it does not call a
Vercel credential service. The username and password go from the browser
directly to Synapse. Synapse is configured to reject open registration unless
either CAPTCHA or a registration token is required. The browser completes
advertised Matrix UIA stages generically and validates both the exact
homeserver origin and popup window before accepting an `authDone` message.
Existing accounts from any discoverable homeserver remain supported for login.

No email or phone number is required. Consequently, there is no email password
reset path; the UI makes users acknowledge that before submission. The account
is signed in only in the current browser tab, and its Matrix access token is
cleared on sign-out.

Room entry uses the immutable room ID instead of depending on the origin alias.
The client supplies `matrix.nealtheseal.org` and `salix.host` as federation
routes. A route only becomes a real outage
fallback after a joined user on that homeserver has caused it to replicate the
room; listing a server as `via` does not itself copy room state there.

Passwords are cleared from the form immediately after the login request. The
client also clears both account-creation password fields after every attempt.
It never asks for a Matrix recovery key, wallet seed phrase, or wallet
signature. Attachments, email recovery, and push notifications are explicitly
not part of this client.

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

The self-service registration rollout has a separate deployment gate: install
valid reCAPTCHA v2 keys, apply the managed `captcha` policy, then complete the
manual create/sign-in/knock/admit/message/sign-out smoke test in the VPS
runbook. Until that gate is completed on the live host, the server safely
remains in one-use-token mode.

## Remaining durability gates

The room is live as a beta, but the Mac is not represented as durable production
hosting until these are complete:

1. Join and promote an email-free Salix backup moderator.
2. Verify knock/admit/message exchange through Salix.
3. Configure and restore-test an encrypted off-device backup.
4. Complete a 24-hour VPS soak, then retire the frozen Mac services.

The Matrix room identity survives a later host move as long as the server name,
database, signing key, and media state are migrated together.
