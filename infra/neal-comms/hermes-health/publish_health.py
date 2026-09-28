#!/usr/bin/env python3
"""Publish the local NEAL Hermes gateway health as a Matrix room state event."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


PROFILE = "neal"
EXPECTED_USER = "@neal:matrix.nealtheseal.org"
EXPECTED_ROOM = "!KliLLiEXeNPupDcYwe:matrix.nealtheseal.org"
EVENT_TYPE = "org.neal.hermes.health"
STATE_KEY = "primary"
PROFILE_ROOT = Path.home() / ".hermes" / "profiles" / PROFILE
PROFILE_ENV = PROFILE_ROOT / ".env"


class HealthError(RuntimeError):
    pass


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError as error:
        raise HealthError(f"Hermes profile environment is unavailable: {error}") from error
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        values[key.strip()] = value
    return values


def gateway_status(alias: str) -> tuple[bool, bool, bool]:
    try:
        result = subprocess.run(
            [alias, "gateway", "status", "--deep", "--full"],
            capture_output=True,
            text=True,
            timeout=25,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False, False, False
    output = f"{result.stdout}\n{result.stderr}".lower()
    running = result.returncode == 0 and any(
        marker in output
        for marker in (
            "status:       ✓ running",
            "gateway process is running for this profile",
            "detached gateway process is running",
            "gateway is supervised by launchd",
        )
    )
    last_matrix_state = ""
    for line in output.splitlines():
        if "matrix connected" in line:
            last_matrix_state = "connected"
        elif "matrix disconnected" in line:
            last_matrix_state = "disconnected"
    connected = running and last_matrix_state == "connected"
    service_managed = running and (
        "service:      active" in output or "gateway is supervised by launchd" in output
    )
    return running, connected, service_managed


def gateway_version(binary: str) -> str:
    try:
        result = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    first_line = result.stdout.splitlines()[0].strip() if result.stdout.splitlines() else ""
    return first_line.removeprefix("Hermes Agent ") or "unknown"


def publish() -> None:
    env = read_env(PROFILE_ENV)
    homeserver = env.get("MATRIX_HOMESERVER", "").rstrip("/")
    access_token = env.get("MATRIX_ACCESS_TOKEN", "")
    user_id = env.get("MATRIX_USER_ID", "")
    room_id = env.get("MATRIX_HOME_ROOM", "")
    allowed_rooms = env.get("MATRIX_ALLOWED_ROOMS", "")
    if not homeserver.startswith("https://"):
        raise HealthError("Hermes Matrix homeserver must use HTTPS")
    if not access_token:
        raise HealthError("Hermes Matrix access token is missing")
    if user_id != EXPECTED_USER:
        raise HealthError("Hermes Matrix identity does not match the NEAL profile")
    if room_id != EXPECTED_ROOM or EXPECTED_ROOM not in allowed_rooms.split(","):
        raise HealthError("Hermes Matrix room binding does not match the canonical GC")

    alias = str(Path.home() / ".local" / "bin" / "neal")
    hermes = str(Path.home() / ".local" / "bin" / "hermes")
    running, connected, service_managed = gateway_status(alias)
    body = {
        "schema": "org.neal.hermes.health/v1",
        "status": "online" if running and connected else "offline",
        "observed_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "profile": PROFILE,
        "user_id": user_id,
        "room_id": room_id,
        "gateway_version": gateway_version(hermes),
        "service_managed": service_managed,
    }
    path = "/_matrix/client/v3/rooms/{}/state/{}/{}".format(
        urllib.parse.quote(room_id, safe=""),
        urllib.parse.quote(EVENT_TYPE, safe=""),
        urllib.parse.quote(STATE_KEY, safe=""),
    )
    request = urllib.request.Request(
        homeserver + path,
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status < 200 or response.status >= 300:
                raise HealthError(f"Matrix heartbeat returned HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise HealthError(f"Matrix heartbeat returned HTTP {error.code}") from error
    except urllib.error.URLError as error:
        raise HealthError(f"Matrix heartbeat could not reach the homeserver: {error.reason}") from error


def main() -> int:
    try:
        publish()
        print("NEAL Hermes health published.")
        return 0
    except HealthError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
