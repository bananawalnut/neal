#!/usr/bin/env python3
"""Create and verify the canonical NEAL Matrix room.

Interactive mode reads the owner password with ``getpass``. ``--owner-api``
instead reads the local Synapse registration secret, creates an erasable
bootstrap administrator, and issues a short-lived token acting as NEAL. Neither
flow prints or persists credentials, and both log out before the script exits.
"""

from __future__ import annotations

import getpass
import hashlib
import hmac
import json
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from argparse import ArgumentParser
from pathlib import Path


BASE_URL = "https://matrix-home.tailadbebb.ts.net:10000"
LOCAL_BASE_URL = "http://127.0.0.1:8010"
USER_ID = "@neal:matrix.nealtheseal.org"
ROOM_ALIAS = "#neal-gc:matrix.nealtheseal.org"
ROOM_ALIAS_LOCALPART = "neal-gc"
ROOM_NAME = "NEAL GC"
ROOM_TOPIC = (
    "Coordinate quests, request help, and shape NEAL together. This room is "
    "not end-to-end encrypted; do not post secrets. Knock to request entry."
)
REGISTRATION_SECRET = (
    Path.home()
    / "Library/Application Support/Neal/Matrix/secrets/registration-shared-secret"
)


class MatrixError(RuntimeError):
    pass


def request_json(
    method: str,
    path: str,
    *,
    body: dict[str, object] | None = None,
    token: str | None = None,
    base_url: str = BASE_URL,
) -> tuple[int, dict[str, object]]:
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(
        f"{base_url}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return response.status, payload
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
            message = payload.get("error") or payload.get("errcode") or raw
        except json.JSONDecodeError:
            message = raw
        raise MatrixError(f"Matrix returned HTTP {error.code}: {message}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise MatrixError(f"Could not reach the NEAL homeserver: {error}") from error


def encoded(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def room_if_present(*, base_url: str = BASE_URL) -> str | None:
    try:
        _, payload = request_json(
            "GET",
            f"/_matrix/client/v3/directory/room/{encoded(ROOM_ALIAS)}",
            base_url=base_url,
        )
    except MatrixError as error:
        if "HTTP 404" in str(error):
            return None
        raise
    room_id = payload.get("room_id")
    return room_id if isinstance(room_id, str) else None


def get_state(
    room_id: str,
    event_type: str,
    token: str,
    *,
    base_url: str = BASE_URL,
) -> dict[str, object]:
    _, payload = request_json(
        "GET",
        f"/_matrix/client/v3/rooms/{encoded(room_id)}/state/{encoded(event_type)}/",
        token=token,
        base_url=base_url,
    )
    return payload


def create_temporary_admin() -> tuple[str, str]:
    """Create a throwaway local admin without exposing the shared secret."""
    if not REGISTRATION_SECRET.is_file():
        raise MatrixError(f"Missing local registration secret: {REGISTRATION_SECRET}")
    shared_secret = REGISTRATION_SECRET.read_text().strip().encode("utf-8")
    if not shared_secret:
        raise MatrixError("The local registration secret is empty")

    _, nonce_payload = request_json(
        "GET", "/_synapse/admin/v1/register", base_url=LOCAL_BASE_URL
    )
    nonce = nonce_payload.get("nonce")
    if not isinstance(nonce, str) or not nonce:
        raise MatrixError("Synapse did not return a registration nonce")

    username = f"neal_room_bootstrap_{secrets.token_hex(8)}"
    password = secrets.token_urlsafe(48)
    mac_payload = b"\x00".join(
        (
            nonce.encode("utf-8"),
            username.encode("utf-8"),
            password.encode("utf-8"),
            b"admin",
        )
    )
    mac = hmac.new(shared_secret, mac_payload, hashlib.sha1).hexdigest()
    shared_secret = b""

    _, registration = request_json(
        "POST",
        "/_synapse/admin/v1/register",
        base_url=LOCAL_BASE_URL,
        body={
            "nonce": nonce,
            "username": username,
            "password": password,
            "admin": True,
            "mac": mac,
        },
    )
    password = ""
    user_id = registration.get("user_id")
    access_token = registration.get("access_token")
    if not isinstance(user_id, str) or not isinstance(access_token, str):
        raise MatrixError("Temporary admin registration returned no usable identity")
    return user_id, access_token


def issue_owner_token(admin_token: str) -> str:
    """Issue a short-lived token which acts as the canonical NEAL account."""
    _, payload = request_json(
        "POST",
        f"/_synapse/admin/v1/users/{encoded(USER_ID)}/login",
        base_url=LOCAL_BASE_URL,
        token=admin_token,
        body={"valid_until_ms": int(time.time() * 1000) + 5 * 60 * 1000},
    )
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise MatrixError("Synapse did not issue the one-use NEAL access token")
    return access_token


def deactivate_temporary_admin(user_id: str, token: str) -> None:
    request_json(
        "POST",
        f"/_synapse/admin/v1/deactivate/{encoded(user_id)}",
        base_url=LOCAL_BASE_URL,
        token=token,
        body={"erase": True},
    )


def main() -> int:
    parser = ArgumentParser()
    parser.add_argument(
        "--owner-api",
        action="store_true",
        help="Use the local Synapse owner API instead of asking for NEAL's password",
    )
    parser.add_argument(
        "--yes", action="store_true", help="Accept the displayed room contract"
    )
    args = parser.parse_args()

    api_base_url = LOCAL_BASE_URL if args.owner_api else BASE_URL
    existing_room = room_if_present(base_url=api_base_url)
    if existing_room:
        print(f"NEAL GC already exists: {ROOM_ALIAS} ({existing_room})")
        return 0

    print("Ready to create the canonical NEAL Matrix room:\n")
    print(f"  Owner:       {USER_ID}")
    print(f"  Name:        {ROOM_NAME}")
    print(f"  Address:     {ROOM_ALIAS}")
    print("  Federation:  enabled")
    print("  Encryption:  enabled")
    print("  Entry:       knock to join")
    print("  Directory:   not publicly listed")
    print("  Guests:      forbidden")
    print("  History:     visible from invitation onward")
    print("  Room version: 11\n")

    if not args.yes and input("Create this room? Type YES: ").strip() != "YES":
        print("Cancelled; no room was created.")
        return 1

    password = ""
    temporary_admin_id: str | None = None
    temporary_admin_token: str | None = None
    token: str | None = None
    try:
        if args.owner_api:
            temporary_admin_id, temporary_admin_token = create_temporary_admin()
            token = issue_owner_token(temporary_admin_token)
        else:
            password = getpass.getpass("NEAL Matrix password: ")
            _, login = request_json(
                "POST",
                "/_matrix/client/v3/login",
                body={
                    "type": "m.login.password",
                    "identifier": {"type": "m.id.user", "user": USER_ID},
                    "password": password,
                    "initial_device_display_name": "NEAL GC one-use provisioner",
                },
            )
            password = ""
            login_user = login.get("user_id")
            if login_user != USER_ID:
                raise MatrixError(f"Unexpected login identity: {login_user!r}")
            raw_token = login.get("access_token")
            if not isinstance(raw_token, str) or not raw_token:
                raise MatrixError("Synapse login did not return an access token")
            token = raw_token

        _, created = request_json(
            "POST",
            "/_matrix/client/v3/createRoom",
            token=token,
            base_url=api_base_url,
            body={
                "creation_content": {"m.federate": True},
                "initial_state": [
                    {
                        "type": "m.room.join_rules",
                        "state_key": "",
                        "content": {"join_rule": "knock"},
                    },
                    {
                        "type": "m.room.history_visibility",
                        "state_key": "",
                        "content": {"history_visibility": "invited"},
                    },
                    {
                        "type": "m.room.guest_access",
                        "state_key": "",
                        "content": {"guest_access": "forbidden"},
                    },
                ],
                "name": ROOM_NAME,
                "preset": "private_chat",
                "room_alias_name": ROOM_ALIAS_LOCALPART,
                "room_version": "11",
                "topic": ROOM_TOPIC,
                "visibility": "private",
            },
        )
        room_id = created.get("room_id")
        if not isinstance(room_id, str) or not room_id:
            raise MatrixError("Room creation did not return a room ID")

        # Ensure clients present the stable alias as canonical.
        request_json(
            "PUT",
            f"/_matrix/client/v3/rooms/{encoded(room_id)}/state/m.room.canonical_alias",
            token=token,
            body={"alias": ROOM_ALIAS, "alt_aliases": []},
            base_url=api_base_url,
        )

        _, room_state = request_json(
            "GET",
            f"/_matrix/client/v3/rooms/{encoded(room_id)}/state",
            token=token,
            base_url=api_base_url,
        )
        if not isinstance(room_state, list):
            raise MatrixError("Room state response was not a list")
        encryption_present = any(
            isinstance(event, dict) and event.get("type") == "m.room.encryption"
            for event in room_state
        )
        join_rules = get_state(room_id, "m.room.join_rules", token, base_url=api_base_url)
        guest_access = get_state(room_id, "m.room.guest_access", token, base_url=api_base_url)
        history = get_state(room_id, "m.room.history_visibility", token, base_url=api_base_url)
        canonical_alias = get_state(room_id, "m.room.canonical_alias", token, base_url=api_base_url)

        checks = {
            "unencrypted": not encryption_present,
            "knock": join_rules.get("join_rule") == "knock",
            "guests forbidden": guest_access.get("guest_access") == "forbidden",
            "history invited": history.get("history_visibility") == "invited",
            "canonical alias": canonical_alias.get("alias") == ROOM_ALIAS,
            "directory alias": room_if_present(base_url=api_base_url) == room_id,
        }
        failed = [label for label, passed in checks.items() if not passed]
        if failed:
            raise MatrixError("Room created but verification failed: " + ", ".join(failed))

        print(f"\nCreated and verified: {ROOM_ALIAS}")
        print(f"Room ID: {room_id}")
        print("The room is ready for NEAL's first-party Matrix client.")
        return 0
    finally:
        password = ""
        if token:
            try:
                request_json(
                    "POST",
                    "/_matrix/client/v3/logout",
                    token=token,
                    base_url=api_base_url,
                )
                print("One-use provisioner session logged out.")
            except MatrixError as error:
                print(f"Warning: could not log out provisioner session: {error}", file=sys.stderr)
        if temporary_admin_id and temporary_admin_token:
            try:
                deactivate_temporary_admin(temporary_admin_id, temporary_admin_token)
                print("Temporary bootstrap admin erased.")
            except MatrixError as error:
                print(
                    f"Warning: could not erase temporary bootstrap admin: {error}",
                    file=sys.stderr,
                )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (MatrixError, KeyboardInterrupt) as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
