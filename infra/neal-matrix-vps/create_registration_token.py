#!/usr/bin/env python3
"""Create a short-lived, limited-use Synapse registration token locally.

Run on the VPS. A throwaway admin is created through Synapse's shared-secret
registration endpoint, used once, then deactivated and erased. Only the intended
registration token is printed.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BASE_URL = "http://127.0.0.1:8008"
SHARED_SECRET = Path("/srv/neal-matrix/runtime/synapse/registration-shared-secret")


class TokenError(RuntimeError):
    pass


def request_json(method: str, path: str, *, body=None, token: str | None = None):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")
        raise TokenError(f"Synapse returned HTTP {error.code}: {detail}") from error


def encoded(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def temporary_admin() -> tuple[str, str]:
    shared = SHARED_SECRET.read_text().strip().encode()
    nonce = request_json("GET", "/_synapse/admin/v1/register")["nonce"]
    username = f"neal_token_issuer_{secrets.token_hex(8)}"
    password = secrets.token_urlsafe(48)
    mac_input = b"\x00".join((nonce.encode(), username.encode(), password.encode(), b"admin"))
    mac = hmac.new(shared, mac_input, hashlib.sha1).hexdigest()
    shared = b""
    result = request_json(
        "POST",
        "/_synapse/admin/v1/register",
        body={"nonce": nonce, "username": username, "password": password, "admin": True, "mac": mac},
    )
    password = ""
    return result["user_id"], result["access_token"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uses", type=int, default=1)
    parser.add_argument("--minutes", type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.uses <= 20:
        raise TokenError("--uses must be between 1 and 20")
    if not 1 <= args.minutes <= 1440:
        raise TokenError("--minutes must be between 1 and 1440")

    admin_id = ""
    admin_token = ""
    try:
        admin_id, admin_token = temporary_admin()
        result = request_json(
            "POST",
            "/_synapse/admin/v1/registration_tokens/new",
            token=admin_token,
            body={
                "uses_allowed": args.uses,
                "expiry_time": int(time.time() * 1000) + args.minutes * 60 * 1000,
            },
        )
        registration_token = result.get("token")
        if not isinstance(registration_token, str) or not registration_token:
            raise TokenError("Synapse returned no registration token")
        print(registration_token)
        return 0
    finally:
        if admin_id and admin_token:
            try:
                request_json(
                    "POST",
                    f"/_synapse/admin/v1/deactivate/{encoded(admin_id)}",
                    token=admin_token,
                    body={"erase": True},
                )
            except Exception:
                pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, KeyError, TokenError) as error:
        print(f"error: {error}", file=__import__("sys").stderr)
        raise SystemExit(1)
