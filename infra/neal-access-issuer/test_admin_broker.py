from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

from admin_broker import Application, BrokerError, Settings


class FakeMatrix:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None, dict[str, Any] | None]] = []
        self.logouts: list[str] = []

    def request(
        self,
        method: str,
        path: str,
        *,
        token: str | None = None,
        body: dict[str, Any] | None = None,
        allow_not_found: bool = False,
    ) -> dict[str, Any] | list[Any] | None:
        self.calls.append((method, path, token, body))
        if path == "/_matrix/client/v3/login":
            return {
                "access_token": "secret-matrix-token",
                "device_id": "DEVICE",
                "user_id": "@beaver:matrix.nealtheseal.org",
            }
        if path == "/_matrix/client/v3/logout":
            assert token is not None
            self.logouts.append(token)
            return {}
        if path.startswith("/_synapse/admin/v2/users/%40beaver"):
            return {"name": "@beaver:matrix.nealtheseal.org", "admin": True, "deactivated": False, "locked": False}
        if path == "/_synapse/admin/v2/users?limit=500":
            return {
                "users": [
                    {"name": "@beaver:matrix.nealtheseal.org", "admin": True, "password_hash": "must-not-leak"},
                    {"name": "@remote:elsewhere.example", "admin": False, "deactivated": False},
                ]
            }
        if path == "/_synapse/admin/v1/server_version":
            return {"server_version": "1.2.3", "python_version": "must-not-leak"}
        if path.startswith("/_matrix/client/v3/directory/room/"):
            return {"room_id": "!room:matrix.nealtheseal.org", "servers": ["must-not-leak"]}
        if path.endswith("/state"):
            return [
                {
                    "type": "m.room.member",
                    "state_key": "@remote:elsewhere.example",
                    "origin_server_ts": 123,
                    "content": {"membership": "knock", "displayname": "must-not-leak"},
                    "unsigned": {"must": "not-leak"},
                },
                {"type": "m.room.topic", "state_key": "", "content": {"topic": "must-not-leak"}},
                {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "knock"}},
            ]
        if "/state/org.neal.hermes.health/" in path:
            return {
                "status": "online",
                "observed_at": "2026-10-02T00:00:00Z",
                "user_id": "@neal:matrix.nealtheseal.org",
                "room_id": "!room:matrix.nealtheseal.org",
                "gateway_version": "1",
                "service_managed": True,
                "secret": "must-not-leak",
            }
        raise AssertionError(f"unexpected Matrix request: {method} {path}")


class AdminBrokerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.settings = Settings(
            socket_path=root / "monitor.sock",
            database_path=root / "sessions.sqlite3",
            encryption_key=b"k" * 32,
            matrix_base_url="http://127.0.0.1:8008",
            public_origin="https://nealtheseal.org",
            admin_user_id="@beaver:matrix.nealtheseal.org",
            room_alias="#neal-gc:matrix.nealtheseal.org",
            room_id="!room:matrix.nealtheseal.org",
            hermes_user_id="@neal:matrix.nealtheseal.org",
            hermes_health_type="org.neal.hermes.health",
            hermes_health_key="primary",
        )
        self.matrix = FakeMatrix()
        self.app = Application(self.settings, self.matrix)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def login(self) -> tuple[dict[str, Any], str]:
        return self.app.login(
            {
                "schema": "neal.admin-session-request/v1",
                "username": "beaver",
                "password": "correct horse battery staple",
            }
        )

    def test_token_is_encrypted_and_snapshot_is_allowlisted(self) -> None:
        session, cookie = self.login()
        self.assertEqual(session["userId"], "@beaver:matrix.nealtheseal.org")
        database_bytes = self.settings.database_path.read_bytes()
        self.assertNotIn(b"secret-matrix-token", database_bytes)
        self.assertNotIn(cookie.encode("ascii"), database_bytes)

        snapshot = self.app.snapshot(cookie)
        self.assertEqual(snapshot["schema"], "neal.admin-snapshot/v1")
        encoded = str(snapshot)
        self.assertNotIn("must-not-leak", encoded)
        self.assertNotIn("secret-matrix-token", encoded)
        self.assertEqual(snapshot["state"][0]["content"], {"membership": "knock"})
        self.assertEqual([event["type"] for event in snapshot["state"]], ["m.room.member", "m.room.join_rules"])

    def test_only_beaver_can_attempt_login(self) -> None:
        with self.assertRaises(BrokerError) as caught:
            self.app.login(
                {
                    "schema": "neal.admin-session-request/v1",
                    "username": "someone-else",
                    "password": "password",
                }
            )
        self.assertEqual(caught.exception.code, "authentication_failed")
        self.assertFalse(any(path == "/_matrix/client/v3/login" for _, path, _, _ in self.matrix.calls))

    def test_logout_revokes_and_removes_session(self) -> None:
        _, cookie = self.login()
        self.app.logout(cookie)
        self.assertEqual(self.matrix.logouts, ["secret-matrix-token"])
        with self.assertRaises(BrokerError) as caught:
            self.app.snapshot(cookie)
        self.assertEqual(caught.exception.code, "session_unavailable")

    def test_restart_revokes_orphaned_matrix_token(self) -> None:
        _, cookie = self.login()
        restarted_matrix = FakeMatrix()
        restarted = Application(self.settings, restarted_matrix)
        self.assertEqual(restarted_matrix.logouts, ["secret-matrix-token"])
        with self.assertRaises(BrokerError):
            restarted.snapshot(cookie)

    def test_idle_timeout_marks_token_for_revocation(self) -> None:
        _, cookie = self.login()
        session_hash = __import__("hashlib").sha256(cookie.encode("ascii")).hexdigest()
        with self.app.store.connection() as database:
            database.execute(
                "UPDATE broker_sessions SET last_used_at = ? WHERE session_hash = ?",
                (int(time.time()) - self.settings.idle_seconds - 1, session_hash),
            )
        with self.assertRaises(BrokerError):
            self.app.snapshot(cookie)
        self.assertEqual(self.matrix.logouts, ["secret-matrix-token"])


if __name__ == "__main__":
    unittest.main()
