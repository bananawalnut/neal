#!/usr/bin/env python3
"""Narrow, cookie-authenticated broker for the NEAL administrator monitor."""

from __future__ import annotations

import argparse
import base64
import contextlib
import hashlib
import json
import os
import secrets
import socketserver
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Iterator

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


COOKIE_NAME = "__Host-neal-admin"
MAX_BODY = 32 * 1024
MAX_MATRIX_RESPONSE = 1024 * 1024
ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS"
MONITORED_STATE = {
    "m.room.member",
    "m.room.encryption",
    "m.room.history_visibility",
    "m.room.join_rules",
    "m.room.guest_access",
}


class BrokerError(RuntimeError):
    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST, code: str = "invalid_request"):
        super().__init__(message)
        self.status = status
        self.code = code


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def read_secret(path: Path, expected_bytes: int) -> bytes:
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
        value = path.read_bytes()
    except OSError as error:
        raise BrokerError("Broker credential is unavailable", HTTPStatus.INTERNAL_SERVER_ERROR, "credential_unavailable") from error
    if mode & 0o077 or len(value) != expected_bytes:
        raise BrokerError("Broker credential is invalid", HTTPStatus.INTERNAL_SERVER_ERROR, "credential_invalid")
    return value


@dataclass(frozen=True)
class Settings:
    socket_path: Path
    database_path: Path
    encryption_key: bytes
    matrix_base_url: str
    public_origin: str
    admin_user_id: str
    room_alias: str
    room_id: str
    hermes_user_id: str
    hermes_health_type: str
    hermes_health_key: str
    idle_seconds: int = 15 * 60
    absolute_seconds: int = 60 * 60

    @classmethod
    def from_environment(cls) -> "Settings":
        credentials = Path(os.environ.get("CREDENTIALS_DIRECTORY", "/run/credentials/neal-admin-monitor.service"))
        key_path = Path(os.environ.get("NEAL_ADMIN_MONITOR_KEY_PATH", credentials / "broker-session-key"))
        base_url = os.environ.get("NEAL_MATRIX_LOOPBACK_URL", "http://127.0.0.1:8008").rstrip("/")
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"} or parsed.username or parsed.password:
            raise BrokerError("Matrix broker target must be loopback HTTP", HTTPStatus.INTERNAL_SERVER_ERROR, "unsafe_matrix_target")
        server_name = os.environ.get("NEAL_MATRIX_SERVER_NAME", "matrix.nealtheseal.org")
        admin_user = os.environ.get("NEAL_ADMIN_USER_ID", f"@beaver:{server_name}")
        if admin_user != f"@beaver:{server_name}":
            raise BrokerError("The monitor administrator must be Beaver", HTTPStatus.INTERNAL_SERVER_ERROR, "invalid_admin_identity")
        return cls(
            socket_path=Path(os.environ.get("NEAL_ADMIN_MONITOR_SOCKET", "/run/neal-admin-monitor/monitor.sock")),
            database_path=Path(os.environ.get("NEAL_ADMIN_MONITOR_DATABASE", "/var/lib/neal-admin-monitor/sessions.sqlite3")),
            encryption_key=read_secret(key_path, 32),
            matrix_base_url=base_url,
            public_origin=os.environ.get("NEAL_PUBLIC_ORIGIN", "https://nealtheseal.org"),
            admin_user_id=admin_user,
            room_alias=os.environ.get("NEAL_MATRIX_ROOM_ALIAS", "#neal-gc:matrix.nealtheseal.org"),
            room_id=os.environ.get("NEAL_MATRIX_ROOM_ID", "!KliLLiEXeNPupDcYwe:matrix.nealtheseal.org"),
            hermes_user_id=os.environ.get("NEAL_HERMES_USER_ID", f"@neal:{server_name}"),
            hermes_health_type=os.environ.get("NEAL_HERMES_HEALTH_TYPE", "org.neal.hermes.health"),
            hermes_health_key=os.environ.get("NEAL_HERMES_HEALTH_KEY", "primary"),
        )


class MatrixClient:
    def __init__(self, base_url: str):
        self.base_url = base_url

    def request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        body: dict[str, Any] | None = None,
        allow_not_found: bool = False,
    ) -> dict[str, Any] | list[Any] | None:
        headers = {"Accept": "application/json"}
        data = None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = canonical_json(body)
        request = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read(MAX_MATRIX_RESPONSE + 1)
        except urllib.error.HTTPError as error:
            if allow_not_found and error.code == HTTPStatus.NOT_FOUND:
                return None
            status = HTTPStatus.UNAUTHORIZED if error.code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN} else HTTPStatus.BAD_GATEWAY
            raise BrokerError("Matrix request failed", status, "matrix_request_failed") from error
        except (OSError, urllib.error.URLError) as error:
            raise BrokerError("Matrix is unavailable", HTTPStatus.SERVICE_UNAVAILABLE, "matrix_unavailable") from error
        if len(raw) > MAX_MATRIX_RESPONSE:
            raise BrokerError("Matrix response exceeded the broker limit", HTTPStatus.BAD_GATEWAY, "matrix_response_oversized")
        try:
            value = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError) as error:
            raise BrokerError("Matrix returned malformed data", HTTPStatus.BAD_GATEWAY, "matrix_response_invalid") from error
        if not isinstance(value, (dict, list)):
            raise BrokerError("Matrix returned an invalid payload", HTTPStatus.BAD_GATEWAY, "matrix_response_invalid")
        return value


class SessionStore:
    def __init__(self, path: Path, key: bytes):
        self.path = path
        self.key = key
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path.parent, 0o700)
        with self.connection() as database:
            database.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS broker_sessions (
                    session_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    token_nonce BLOB NOT NULL,
                    token_ciphertext BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    last_used_at INTEGER NOT NULL,
                    absolute_expires_at INTEGER NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    revoke_pending INTEGER NOT NULL DEFAULT 0
                );
                """
            )
        os.chmod(path, 0o600)

    @contextlib.contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        database = sqlite3.connect(self.path, timeout=10)
        database.row_factory = sqlite3.Row
        try:
            with database:
                yield database
        finally:
            database.close()

    def _encrypt(self, session_hash: str, user_id: str, token: str) -> tuple[bytes, bytes]:
        nonce = secrets.token_bytes(12)
        aad = canonical_json({"sessionHash": session_hash, "userId": user_id})
        return nonce, AESGCM(self.key).encrypt(nonce, token.encode("utf-8"), aad)

    def _decrypt(self, row: sqlite3.Row) -> str:
        aad = canonical_json({"sessionHash": row["session_hash"], "userId": row["user_id"]})
        try:
            return AESGCM(self.key).decrypt(row["token_nonce"], row["token_ciphertext"], aad).decode("utf-8")
        except (ValueError, UnicodeError) as error:
            raise BrokerError("Stored broker session cannot be decrypted", HTTPStatus.SERVICE_UNAVAILABLE, "session_decryption_failed") from error

    def create(self, user_id: str, device_id: str, matrix_token: str, now: int, absolute_seconds: int) -> str:
        cookie = secrets.token_urlsafe(32)
        session_hash = hashlib.sha256(cookie.encode("ascii")).hexdigest()
        nonce, ciphertext = self._encrypt(session_hash, user_id, matrix_token)
        with self.connection() as database:
            database.execute(
                """
                INSERT INTO broker_sessions
                (session_hash, user_id, device_id, token_nonce, token_ciphertext, created_at,
                 last_used_at, absolute_expires_at, active, revoke_pending)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)
                """,
                (session_hash, user_id, device_id, nonce, ciphertext, now, now, now + absolute_seconds),
            )
        return cookie

    def resolve(self, cookie: str, now: int, idle_seconds: int) -> tuple[sqlite3.Row, str] | None:
        session_hash = hashlib.sha256(cookie.encode("ascii")).hexdigest()
        with self.connection() as database:
            row = database.execute(
                "SELECT * FROM broker_sessions WHERE session_hash = ? AND active = 1", (session_hash,)
            ).fetchone()
            if not row:
                return None
            if row["absolute_expires_at"] <= now or row["last_used_at"] + idle_seconds <= now:
                database.execute(
                    "UPDATE broker_sessions SET active = 0, revoke_pending = 1 WHERE session_hash = ?",
                    (session_hash,),
                )
                return None
            database.execute(
                "UPDATE broker_sessions SET last_used_at = ? WHERE session_hash = ?", (now, session_hash)
            )
        return row, self._decrypt(row)

    def deactivate(self, cookie: str) -> tuple[sqlite3.Row, str] | None:
        session_hash = hashlib.sha256(cookie.encode("ascii")).hexdigest()
        with self.connection() as database:
            row = database.execute("SELECT * FROM broker_sessions WHERE session_hash = ?", (session_hash,)).fetchone()
            if not row:
                return None
            database.execute(
                "UPDATE broker_sessions SET active = 0, revoke_pending = 1 WHERE session_hash = ?", (session_hash,)
            )
        return row, self._decrypt(row)

    def pending_revocations(self, now: int, *, recover_all: bool = False) -> list[tuple[sqlite3.Row, str]]:
        with self.connection() as database:
            database.execute(
                """
                UPDATE broker_sessions SET active = 0, revoke_pending = 1
                WHERE active = 1 AND absolute_expires_at <= ?
                """,
                (now,),
            )
            if recover_all:
                database.execute("UPDATE broker_sessions SET active = 0, revoke_pending = 1 WHERE active = 1")
            rows = database.execute("SELECT * FROM broker_sessions WHERE revoke_pending = 1").fetchall()
        return [(row, self._decrypt(row)) for row in rows]

    def revoked(self, session_hash: str) -> None:
        with self.connection() as database:
            database.execute("DELETE FROM broker_sessions WHERE session_hash = ?", (session_hash,))

    def metrics(self) -> dict[str, int]:
        with self.connection() as database:
            row = database.execute(
                "SELECT SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), SUM(CASE WHEN revoke_pending = 1 THEN 1 ELSE 0 END) FROM broker_sessions"
            ).fetchone()
        return {
            "activeSessions": int(row[0] or 0),
            "revocationsPending": int(row[1] or 0),
        }


class Application:
    def __init__(self, settings: Settings, matrix: MatrixClient | None = None):
        self.settings = settings
        self.matrix = matrix or MatrixClient(settings.matrix_base_url)
        self.store = SessionStore(settings.database_path, settings.encryption_key)
        self.recover_orphaned_sessions(recover_all=True)

    def _revoke(self, row: sqlite3.Row, token: str) -> None:
        try:
            self.matrix.request("POST", "/_matrix/client/v3/logout", token=token, body={})
        except BrokerError:
            return
        self.store.revoked(row["session_hash"])

    def recover_orphaned_sessions(self, *, recover_all: bool = False) -> None:
        for row, token in self.store.pending_revocations(int(time.time()), recover_all=recover_all):
            self._revoke(row, token)

    def metrics(self) -> dict[str, Any]:
        return {
            "schema": "neal.admin-monitor-metrics/v1",
            "recordedAt": int(time.time()),
            **self.store.metrics(),
        }

    def login(self, body: dict[str, Any]) -> tuple[dict[str, Any], str]:
        if body.get("schema") != "neal.admin-session-request/v1":
            raise BrokerError("Invalid administrator session request", code="invalid_session_request")
        username = body.get("username")
        password = body.get("password")
        if username not in {"beaver", self.settings.admin_user_id} or not isinstance(password, str) or not password:
            raise BrokerError("Administrator credentials are invalid", HTTPStatus.UNAUTHORIZED, "authentication_failed")
        result = self.matrix.request(
            "POST",
            "/_matrix/client/v3/login",
            body={
                "type": "m.login.password",
                "identifier": {"type": "m.id.user", "user": self.settings.admin_user_id},
                "password": password,
                "initial_device_display_name": "NEAL admin monitor broker",
            },
        )
        if not isinstance(result, dict):
            raise BrokerError("Matrix login response is invalid", HTTPStatus.BAD_GATEWAY, "matrix_response_invalid")
        token = result.get("access_token")
        device_id = result.get("device_id")
        user_id = result.get("user_id")
        if not all(isinstance(value, str) and value for value in (token, device_id, user_id)) or user_id != self.settings.admin_user_id:
            raise BrokerError("Matrix login response is invalid", HTTPStatus.BAD_GATEWAY, "matrix_response_invalid")
        try:
            encoded_user = urllib.parse.quote(user_id, safe="")
            profile = self.matrix.request("GET", f"/_synapse/admin/v2/users/{encoded_user}", token=token)
            if (
                not isinstance(profile, dict)
                or profile.get("admin") is not True
                or profile.get("deactivated") is True
                or profile.get("locked") is True
            ):
                raise BrokerError("Administrator access is required", HTTPStatus.FORBIDDEN, "administrator_required")
            now = int(time.time())
            cookie = self.store.create(user_id, device_id, token, now, self.settings.absolute_seconds)
            return {
                "schema": "neal.admin-session/v1",
                "userId": user_id,
                "expiresAt": now + self.settings.absolute_seconds,
            }, cookie
        except Exception:
            try:
                self.matrix.request("POST", "/_matrix/client/v3/logout", token=token, body={})
            except BrokerError:
                pass
            raise

    @staticmethod
    def _safe_user(user: Any) -> dict[str, Any] | None:
        if not isinstance(user, dict) or not isinstance(user.get("name"), str):
            return None
        return {
            "name": user["name"],
            "admin": user.get("admin") is True,
            "deactivated": user.get("deactivated") is True,
            "locked": user.get("locked") is True,
            "is_guest": user.get("is_guest") is True,
        }

    @staticmethod
    def _safe_state(event: Any) -> dict[str, Any] | None:
        if not isinstance(event, dict) or event.get("type") not in MONITORED_STATE:
            return None
        event_type = event["type"]
        content = event.get("content") if isinstance(event.get("content"), dict) else {}
        safe: dict[str, Any] = {"type": event_type, "state_key": event.get("state_key", "")}
        if event_type == "m.room.member":
            membership = content.get("membership")
            if membership not in {"join", "invite", "knock", "leave", "ban"} or not isinstance(safe["state_key"], str):
                return None
            safe["content"] = {"membership": membership}
            timestamp = event.get("origin_server_ts")
            safe["origin_server_ts"] = timestamp if isinstance(timestamp, int) and timestamp >= 0 else 0
        elif event_type == "m.room.history_visibility":
            safe["content"] = {"history_visibility": content.get("history_visibility")}
        elif event_type == "m.room.join_rules":
            safe["content"] = {"join_rule": content.get("join_rule")}
        elif event_type == "m.room.guest_access":
            safe["content"] = {"guest_access": content.get("guest_access")}
        else:
            safe["content"] = {}
        return safe

    def snapshot(self, cookie: str) -> dict[str, Any]:
        resolved = self.store.resolve(cookie, int(time.time()), self.settings.idle_seconds)
        if not resolved:
            self.recover_orphaned_sessions()
            raise BrokerError("Administrator session is unavailable", HTTPStatus.UNAUTHORIZED, "session_unavailable")
        row, token = resolved
        users = self.matrix.request("GET", "/_synapse/admin/v2/users?limit=500", token=token)
        server = self.matrix.request("GET", "/_synapse/admin/v1/server_version", token=token)
        encoded_alias = urllib.parse.quote(self.settings.room_alias, safe="")
        alias = self.matrix.request("GET", f"/_matrix/client/v3/directory/room/{encoded_alias}", token=token)
        encoded_room = urllib.parse.quote(self.settings.room_id, safe="")
        state = self.matrix.request("GET", f"/_matrix/client/v3/rooms/{encoded_room}/state", token=token)
        encoded_type = urllib.parse.quote(self.settings.hermes_health_type, safe="")
        encoded_key = urllib.parse.quote(self.settings.hermes_health_key, safe="")
        hermes = self.matrix.request(
            "GET",
            f"/_matrix/client/v3/rooms/{encoded_room}/state/{encoded_type}/{encoded_key}",
            token=token,
            allow_not_found=True,
        )
        if not isinstance(users, dict) or not isinstance(server, dict) or not isinstance(alias, dict) or not isinstance(state, list):
            raise BrokerError("Matrix monitor response is invalid", HTTPStatus.BAD_GATEWAY, "matrix_response_invalid")
        safe_users = [safe for item in users.get("users", []) if (safe := self._safe_user(item)) is not None]
        safe_state = [safe for item in state if (safe := self._safe_state(item)) is not None]
        health = hermes if isinstance(hermes, dict) else {}
        safe_health = {
            key: health.get(key)
            for key in ("status", "observed_at", "profile", "user_id", "room_id", "gateway_version", "service_managed")
        }
        return {
            "schema": "neal.admin-snapshot/v1",
            "session": {"userId": row["user_id"]},
            "server": {"server_version": server.get("server_version")},
            "users": {"users": safe_users, "total": len(safe_users)},
            "alias": {"room_id": alias.get("room_id")},
            "state": safe_state,
            "hermes": safe_health,
            "generatedAt": int(time.time()),
        }

    def logout(self, cookie: str) -> None:
        resolved = self.store.deactivate(cookie)
        if resolved:
            self._revoke(*resolved)


class Handler(BaseHTTPRequestHandler):
    app: Application

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.log_date_time_string()} admin-monitor {format % args}", file=sys.stderr)

    def origin_allowed(self) -> bool:
        return self.headers.get("Origin") == self.app.settings.public_origin

    def cookie(self) -> str:
        value = SimpleCookie(self.headers.get("Cookie", "")).get(COOKIE_NAME)
        if not value:
            raise BrokerError("Administrator session is unavailable", HTTPStatus.UNAUTHORIZED, "session_unavailable")
        return value.value

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise BrokerError("Invalid request size") from error
        if length <= 0 or length > MAX_BODY:
            raise BrokerError("Invalid request size", HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large")
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise BrokerError("Invalid JSON body") from error
        if not isinstance(value, dict):
            raise BrokerError("JSON body must be an object")
        return value

    def security_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        if self.origin_allowed():
            self.send_header("Access-Control-Allow-Origin", self.app.settings.public_origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
            self.send_header("Vary", "Origin")

    def send_json(self, status: HTTPStatus, value: dict[str, Any], *, cookie: str | None = None, clear: bool = False) -> None:
        encoded = canonical_json(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.security_headers()
        if cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}={cookie}; Path=/; Max-Age={self.app.settings.absolute_seconds}; Secure; HttpOnly; SameSite=Strict",
            )
        elif clear:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
            )
        self.end_headers()
        self.wfile.write(encoded)

    def error(self, error: BrokerError, *, clear: bool = False) -> None:
        self.send_json(
            error.status,
            {"schema": "neal.error/v1", "code": error.code, "message": str(error), "retryable": error.status >= 500},
            clear=clear,
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self.origin_allowed() or self.path not in {"/_neal/admin/session", "/_neal/admin/snapshot"}:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.security_headers()
        self.send_header("Access-Control-Allow-Methods", ALLOWED_METHODS)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self.origin_allowed() or self.path != "/_neal/admin/session":
                raise BrokerError("Not found", HTTPStatus.NOT_FOUND, "not_found")
            result, cookie = self.app.login(self.read_json())
            self.send_json(HTTPStatus.OK, result, cookie=cookie)
        except BrokerError as error:
            self.error(error)

    def do_GET(self) -> None:  # noqa: N802
        try:
            if self.path == "/metrics":
                metrics = self.app.metrics()
                metrics["workers"] = {
                    "active": getattr(self.server, "active_workers", 0),
                    "capacity": 16,
                }
                self.send_json(HTTPStatus.OK, metrics)
                return
            if not self.origin_allowed() or self.path != "/_neal/admin/snapshot":
                raise BrokerError("Not found", HTTPStatus.NOT_FOUND, "not_found")
            self.send_json(HTTPStatus.OK, self.app.snapshot(self.cookie()))
        except BrokerError as error:
            self.error(error, clear=error.status == HTTPStatus.UNAUTHORIZED)

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            if not self.origin_allowed() or self.path != "/_neal/admin/session":
                raise BrokerError("Not found", HTTPStatus.NOT_FOUND, "not_found")
            self.app.logout(self.cookie())
            self.send_json(HTTPStatus.OK, {"schema": "neal.admin-session/v1", "status": "signed_out"}, clear=True)
        except BrokerError as error:
            self.error(error, clear=True)


class BoundedThreadingMixIn(socketserver.ThreadingMixIn):
    daemon_threads = True
    max_workers = 16

    def __init__(self, *args: Any, **kwargs: Any):
        import threading

        self.worker_slots = threading.BoundedSemaphore(self.max_workers)
        self.worker_lock = threading.Lock()
        self.active_workers = 0
        super().__init__(*args, **kwargs)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.worker_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        with self.worker_lock:
            self.active_workers += 1
        try:
            super().process_request(request, client_address)
        except Exception:
            with self.worker_lock:
                self.active_workers -= 1
            self.worker_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.worker_lock:
                self.active_workers -= 1
            self.worker_slots.release()


class UnixServer(BoundedThreadingMixIn, socketserver.UnixStreamServer):
    pass


def serve(settings: Settings) -> None:
    Handler.app = Application(settings)
    settings.socket_path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if settings.socket_path.exists() or settings.socket_path.is_symlink():
        if not stat.S_ISSOCK(settings.socket_path.lstat().st_mode):
            raise BrokerError("Refusing to replace a non-socket monitor path", HTTPStatus.INTERNAL_SERVER_ERROR)
        settings.socket_path.unlink()
    server = UnixServer(str(settings.socket_path), Handler)
    os.chmod(settings.socket_path, 0o660)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if settings.socket_path.exists() and stat.S_ISSOCK(settings.socket_path.lstat().st_mode):
            settings.socket_path.unlink()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=("serve", "generate-key"), default="serve")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "generate-key":
        if not args.output:
            parser.error("--output is required for generate-key")
        if args.output.exists() or args.output.is_symlink():
            raise BrokerError("Refusing to replace an existing broker key")
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        args.output.write_bytes(secrets.token_bytes(32))
        os.chmod(args.output, 0o600)
        return 0
    serve(Settings.from_environment())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BrokerError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
