#!/usr/bin/env python3
"""Invite remote moderators and audit NEAL GC federation.

The script uses Synapse's local owner API, never accepts a password or prints an
access token, and erases its temporary administrator before exit. Remote users
must accept their invitations from their own homeservers before those servers
hold a full room replica. Re-run with ``--promote`` after they have joined.
"""

from __future__ import annotations

import sys
from argparse import ArgumentParser

from create_neal_gc import (
    LOCAL_BASE_URL,
    MatrixError,
    create_temporary_admin,
    deactivate_temporary_admin,
    encoded,
    issue_owner_token,
    request_json,
)


ROOM_ID = "!kBjRkJEIsGBWCyrBQO:matrix.nealtheseal.org"
EXPECTED_REMOTE_SERVERS = {"salix.host"}
MODERATOR_LEVEL = 50


def server_from_user_id(user_id: str) -> str:
    if not user_id.startswith("@") or ":" not in user_id:
        raise MatrixError(f"Invalid Matrix ID: {user_id!r}")
    localpart, server = user_id[1:].split(":", 1)
    if not localpart or not server:
        raise MatrixError(f"Invalid Matrix ID: {user_id!r}")
    return server.lower()


def membership(token: str) -> dict[str, str]:
    _, payload = request_json(
        "GET",
        f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/members",
        token=token,
        base_url=LOCAL_BASE_URL,
    )
    result: dict[str, str] = {}
    for event in payload.get("chunk", []):
        if not isinstance(event, dict) or event.get("type") != "m.room.member":
            continue
        user_id = event.get("state_key")
        content = event.get("content")
        member_state = content.get("membership") if isinstance(content, dict) else None
        if isinstance(user_id, str) and isinstance(member_state, str):
            result[user_id] = member_state
    return result


def invite(token: str, user_id: str) -> None:
    request_json(
        "POST",
        f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/invite",
        token=token,
        base_url=LOCAL_BASE_URL,
        body={
            "user_id": user_id,
            "reason": "Backup moderator for the federated NEAL GC.",
        },
    )


def promote(token: str, user_ids: list[str]) -> None:
    path = f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/state/m.room.power_levels/"
    _, current = request_json("GET", path, token=token, base_url=LOCAL_BASE_URL)
    users = current.get("users")
    if not isinstance(users, dict):
        users = {}
    for user_id in user_ids:
        users[user_id] = MODERATOR_LEVEL
    current["users"] = users
    request_json("PUT", path, token=token, base_url=LOCAL_BASE_URL, body=current)


def print_status(members: dict[str, str]) -> None:
    joined_servers = sorted(
        {server_from_user_id(user_id) for user_id, state in members.items() if state == "join"}
    )
    print("Joined homeservers:")
    for server in joined_servers:
        print(f"  {server}")
    for server in sorted(EXPECTED_REMOTE_SERVERS):
        label = "replicated" if server in joined_servers else "not replicated"
        print(f"{server}: {label}")


def main() -> int:
    parser = ArgumentParser()
    parser.add_argument(
        "user_ids",
        nargs="*",
        help="Remote Matrix IDs to invite from the approved email-free fallback homeserver",
    )
    parser.add_argument(
        "--promote",
        action="store_true",
        help="Give joined remote users moderator power after verifying membership",
    )
    args = parser.parse_args()

    for user_id in args.user_ids:
        server = server_from_user_id(user_id)
        if server not in EXPECTED_REMOTE_SERVERS:
            raise MatrixError(
                f"Expected a Salix identity, got {user_id}"
            )

    temporary_admin_id: str | None = None
    temporary_admin_token: str | None = None
    owner_token: str | None = None
    try:
        temporary_admin_id, temporary_admin_token = create_temporary_admin()
        owner_token = issue_owner_token(temporary_admin_token)
        members = membership(owner_token)

        if args.promote:
            missing = [user_id for user_id in args.user_ids if members.get(user_id) != "join"]
            if missing:
                raise MatrixError(
                    "Cannot promote users until they have joined: " + ", ".join(missing)
                )
            promote(owner_token, args.user_ids)
            print("Promoted remote moderators: " + ", ".join(args.user_ids))
        else:
            for user_id in args.user_ids:
                state = members.get(user_id)
                if state in {"invite", "join"}:
                    print(f"{user_id}: already {state}")
                    continue
                invite(owner_token, user_id)
                print(f"{user_id}: invited")

        members = membership(owner_token)
        print_status(members)
        return 0
    finally:
        if owner_token:
            try:
                request_json(
                    "POST",
                    "/_matrix/client/v3/logout",
                    token=owner_token,
                    base_url=LOCAL_BASE_URL,
                )
            except MatrixError as error:
                print(f"Warning: could not log out owner session: {error}", file=sys.stderr)
        if temporary_admin_id and temporary_admin_token:
            try:
                deactivate_temporary_admin(temporary_admin_id, temporary_admin_token)
            except MatrixError as error:
                print(f"Warning: could not erase temporary admin: {error}", file=sys.stderr)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MatrixError, KeyboardInterrupt) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
