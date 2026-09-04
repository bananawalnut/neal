#!/usr/bin/env python3
"""Publish the full NEAL GC history while keeping room writes authenticated.

Run as root from ``/srv/neal-matrix``. The script enables guest accounts, marks
future room history world-readable, republishes any pre-cutover plaintext
messages with explicit original attribution, creates one server-held guest
reader token, and restarts Caddy with that token. The browser never sees the
token, the guest cannot join, and the fixed route accepts reads only.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, "/srv/neal-matrix")

from create_registration_token import TokenError, encoded, request_json, temporary_admin


PROJECT_ROOT = Path("/srv/neal-matrix")
HOMESERVER_CONFIG = PROJECT_ROOT / "runtime/synapse/homeserver.yaml"
CADDY_ENV = PROJECT_ROOT / "runtime/caddy.env"
OWNER = "@neal:matrix.nealtheseal.org"
ROOM_ID = "!KliLLiEXeNPupDcYwe:matrix.nealtheseal.org"
PUBLIC_FEED = "https://matrix.nealtheseal.org/_neal/gc/messages"
MESSAGE_FILTER = "%7B%22types%22%3A%5B%22m.room.message%22%5D%7D"
MESSAGES_PATH = f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/messages?dir=b&limit=100&filter={MESSAGE_FILTER}"
ARCHIVE_KEY = "org.nealtheseal.public_history"


def enable_guest_accounts() -> bool:
    original = HOMESERVER_CONFIG.stat()
    config = HOMESERVER_CONFIG.read_text()
    enabled = "allow_guest_access: true"
    if enabled in config:
        return False
    if "allow_guest_access: false" in config:
        updated = config.replace("allow_guest_access: false", enabled, 1)
    else:
        anchor = "registration_requires_token: true\n"
        if anchor not in config:
            raise TokenError("Could not locate the Synapse registration policy anchor")
        updated = config.replace(anchor, anchor + enabled + "\n", 1)
    temporary = HOMESERVER_CONFIG.with_suffix(".yaml.tmp")
    temporary.write_text(updated)
    os.chmod(temporary, original.st_mode & 0o777)
    os.chown(temporary, original.st_uid, original.st_gid)
    os.replace(temporary, HOMESERVER_CONFIG)
    return True


def restart(service: str) -> None:
    subprocess.run(
        ["docker", "compose", "-f", str(PROJECT_ROOT / "compose.yaml"), "up", "-d", "--force-recreate", service],
        cwd=PROJECT_ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def wait_for_synapse() -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            request_json("GET", "/_matrix/client/versions")
            return
        except Exception:
            time.sleep(1)
    raise TokenError("Synapse did not become ready after restart")


def existing_reader_token() -> str:
    if not CADDY_ENV.is_file():
        return ""
    prefix = "NEAL_GC_READER_TOKEN="
    for line in CADDY_ENV.read_text().splitlines():
        if line.startswith(prefix):
            return line.removeprefix(prefix).strip()
    return ""


def valid_guest_token(token: str) -> bool:
    if not token:
        return False
    try:
        whoami = request_json("GET", "/_matrix/client/v3/account/whoami", token=token)
        return whoami.get("is_guest") is True
    except TokenError:
        return False


def create_guest_token() -> str:
    guest = request_json(
        "POST",
        "/_matrix/client/v3/register?kind=guest",
        body={"initial_device_display_name": "NEAL public site reader"},
    )
    token = guest.get("access_token")
    if not isinstance(token, str) or not token:
        raise TokenError("Synapse returned no guest access token")
    return token


def timeline(token: str) -> list[dict[str, object]]:
    payload = request_json("GET", MESSAGES_PATH, token=token)
    chunk = payload.get("chunk")
    if not isinstance(chunk, list):
        raise TokenError("Matrix returned no room message timeline")
    return [event for event in chunk if isinstance(event, dict)]


def republish_private_history(owner_token: str, guest_token: str) -> int:
    owner_events = timeline(owner_token)
    public_events = timeline(guest_token)
    public_ids = {event.get("event_id") for event in public_events}
    archived_ids = {
        archive.get("event_id")
        for event in owner_events
        if isinstance(event.get("content"), dict)
        and isinstance((archive := event["content"].get(ARCHIVE_KEY)), dict)
    }
    copied = 0
    for event in reversed(owner_events):
        event_id = event.get("event_id")
        content = event.get("content")
        if (
            not isinstance(event_id, str)
            or event_id in public_ids
            or event_id in archived_ids
            or not isinstance(content, dict)
            or ARCHIVE_KEY in content
            or not isinstance(content.get("body"), str)
            or not isinstance(event.get("sender"), str)
            or not isinstance(event.get("origin_server_ts"), int)
        ):
            continue
        sender = event["sender"]
        timestamp = event["origin_server_ts"]
        body = content["body"]
        sent_at = datetime.fromtimestamp(timestamp / 1000, tz=UTC).isoformat(timespec="minutes")
        request_json(
            "PUT",
            f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/send/m.room.message/{secrets.token_hex(12)}",
            body={
                "msgtype": "m.notice",
                "body": f"PUBLIC HISTORY · {sender} · {sent_at}\n{body}",
                ARCHIVE_KEY: {
                    "event_id": event_id,
                    "sender": sender,
                    "timestamp": timestamp,
                    "body": body,
                },
            },
            token=owner_token,
        )
        copied += 1
    return copied


def save_reader_token(token: str) -> None:
    temporary = CADDY_ENV.with_suffix(".env.tmp")
    temporary.write_text(f"NEAL_GC_READER_TOKEN={token}\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, CADDY_ENV)


def verify_public_feed() -> int:
    request = urllib.request.Request(PUBLIC_FEED, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read())
    chunk = payload.get("chunk")
    if not isinstance(chunk, list):
        raise TokenError("The public GC feed returned no event chunk")
    if any(event.get("type") != "m.room.message" for event in chunk):
        raise TokenError("The public GC feed returned a non-message event")
    return len(chunk)


def main() -> int:
    if not CADDY_ENV.exists():
        CADDY_ENV.write_text("")
        os.chmod(CADDY_ENV, 0o600)
    config_changed = enable_guest_accounts()
    if config_changed:
        restart("synapse")
        wait_for_synapse()

    admin_id = ""
    admin_token = ""
    owner_token = ""
    history_changed = False
    try:
        admin_id, admin_token = temporary_admin()
        owner_token = request_json(
            "POST",
            f"/_synapse/admin/v1/users/{encoded(OWNER)}/login",
            body={"valid_until_ms": int(time.time() * 1000) + 10 * 60 * 1000},
            token=admin_token,
        )["access_token"]
        history_path = f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/state/m.room.history_visibility/"
        history = request_json("GET", history_path, token=owner_token)
        if history.get("history_visibility") != "world_readable":
            request_json(
                "PUT",
                history_path,
                body={"history_visibility": "world_readable"},
                token=owner_token,
            )
            history_changed = True

        guest_access = request_json(
            "GET",
            f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/state/m.room.guest_access/",
            token=owner_token,
        )
        if guest_access.get("guest_access") != "forbidden":
            raise TokenError("Room guests must remain forbidden from joining")

        if history_changed:
            request_json(
                "PUT",
                f"/_matrix/client/v3/rooms/{encoded(ROOM_ID)}/send/m.room.message/{secrets.token_hex(12)}",
                body={
                    "msgtype": "m.notice",
                    "body": (
                        "NEAL GC is publicly readable from this message onward. "
                        "Sign in and join the room to post. Do not post secrets."
                    ),
                },
                token=owner_token,
            )

        reader_token = existing_reader_token()
        if not valid_guest_token(reader_token):
            reader_token = create_guest_token()
            save_reader_token(reader_token)
        archived_message_count = republish_private_history(owner_token, reader_token)

        restart("caddy")
        message_count = verify_public_feed()
        print(json.dumps({
            "archived_message_count": archived_message_count,
            "guest_accounts_enabled": True,
            "guest_joining_forbidden": True,
            "history_visibility": "world_readable",
            "message_count": message_count,
            "public_feed": PUBLIC_FEED,
        }, sort_keys=True))
        return 0
    finally:
        if owner_token:
            try:
                request_json("POST", "/_matrix/client/v3/logout", body={}, token=owner_token)
            except Exception:
                pass
        if admin_id and admin_token:
            try:
                request_json(
                    "POST",
                    f"/_synapse/admin/v1/deactivate/{encoded(admin_id)}",
                    body={"erase": True},
                    token=admin_token,
                )
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
