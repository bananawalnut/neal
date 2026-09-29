from __future__ import annotations

import base64
import dataclasses
import os
import socket
import stat
import struct
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import issuer


class FakeSolana:
    def __init__(self, receipt: str):
        self.receipt = receipt

    def verify(self, _address: str) -> str:
        return self.receipt

    def config(self) -> dict[str, int]:
        return {"required_amount": 25_000_000, "minimum_lock_seconds": 604_800}


class FakeMatrix:
    def __init__(self):
        self.calls = 0

    def issue(self) -> tuple[str, int]:
        self.calls += 1
        return "one-use-token", int(time.time() * 1000) + 900_000

    def ready(self) -> None:
        return None


class FailingMatrix(FakeMatrix):
    def issue(self) -> tuple[str, int]:
        self.calls += 1
        raise RuntimeError("simulated Matrix failure")


class IssuerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.settings = issuer.Settings(
            database=Path(self.temp.name) / "issuer.sqlite3",
            rpc_url="https://rpc.invalid",
            program_id="11111111111111111111111111111111",
            config_address="11111111111111111111111111111111",
            mint="11111111111111111111111111111111",
            public_origin="https://nealtheseal.org",
            matrix_url="http://127.0.0.1:8008",
            matrix_secret_file=Path(self.temp.name) / "secret",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_siws_message_matches_wallet_standard_shape(self) -> None:
        value = {
            "domain": "nealtheseal.org",
            "address": "11111111111111111111111111111111",
            "statement": "Sign in to request a NEAL Matrix access token.",
            "uri": "https://nealtheseal.org",
            "version": "1",
            "chainId": "solana:mainnet",
            "nonce": "0123456789abcdef",
            "issuedAt": "2026-09-28T12:00:00.000Z",
            "expirationTime": "2026-09-28T12:05:00.000Z",
            "requestId": "neal-test",
            "resources": ["https://nealtheseal.org/wallet-policy.json"],
        }
        text = issuer.siws_message(value).decode()
        self.assertTrue(text.startswith("nealtheseal.org wants you to sign in"))
        self.assertIn("Request ID: neal-test", text)
        self.assertTrue(text.endswith("- https://nealtheseal.org/wallet-policy.json"))

    def test_wallet_challenge_is_single_use(self) -> None:
        private = Ed25519PrivateKey.generate()
        raw_public = private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        address = issuer.base58_encode(raw_public)
        app = issuer.Application(
            self.settings,
            matrix=FakeMatrix(),
            solana=FakeSolana("receipt"),
        )
        challenge = app.challenge(
            {"schema": "neal.wallet-challenge-request/v1", "address": address, "chain": "solana:mainnet"},
            "test",
        )["signInInput"]
        message = issuer.siws_message(challenge)
        signature = private.sign(message)
        encoded = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
        body = {
            "schema": "neal.wallet-verification/v1",
            "method": "solana:signIn",
            "signInInput": challenge,
            "output": {
                "account": {"address": address, "publicKey": encoded(raw_public)},
                "signedMessage": encoded(message),
                "signature": encoded(signature),
                "signatureType": "ed25519",
            },
        }
        result, session = app.verify(body, "test")
        self.assertTrue(result["authenticated"])
        self.assertEqual(app.store.session_address(session), address)
        with self.assertRaisesRegex(issuer.IssuerError, "already-used"):
            app.verify(body, "test-second")

    def test_claim_is_idempotent_without_issuing_a_second_token(self) -> None:
        matrix = FakeMatrix()
        solana = FakeSolana("receipt-address")
        app = issuer.Application(self.settings, matrix=matrix, solana=solana)
        address = "11111111111111111111111111111111"
        session = app.store.create_session(address, 600)
        first = app.access_token(session, "first")
        second = app.access_token(session, "second")
        self.assertEqual(first["token"], "one-use-token")
        self.assertEqual(second["token"], first["token"])
        self.assertEqual(matrix.calls, 1)

    def test_expired_or_failed_claim_never_issues_a_second_token(self) -> None:
        address = "11111111111111111111111111111111"
        matrix = FakeMatrix()
        app = issuer.Application(self.settings, matrix=matrix, solana=FakeSolana("expired-receipt"))
        session = app.store.create_session(address, 600)
        app.access_token(session, "first")
        with app.store.connection() as database:
            database.execute("UPDATE claims SET expires_at_ms = 0 WHERE receipt = 'expired-receipt'")
        with self.assertRaisesRegex(issuer.IssuerError, "already been consumed"):
            app.access_token(session, "second")
        self.assertEqual(matrix.calls, 1)

        failing = FailingMatrix()
        failed_app = issuer.Application(self.settings, matrix=failing, solana=FakeSolana("failed-receipt"))
        failed_session = failed_app.store.create_session(address, 600)
        with self.assertRaisesRegex(issuer.IssuerError, "must reconcile"):
            failed_app.access_token(failed_session, "third")
        with self.assertRaisesRegex(issuer.IssuerError, "already been consumed"):
            failed_app.access_token(failed_session, "fourth")
        self.assertEqual(failing.calls, 1)

    def test_readiness_checks_database_chain_terms_and_matrix(self) -> None:
        app = issuer.Application(
            self.settings,
            matrix=FakeMatrix(),
            solana=FakeSolana("readiness-receipt"),
        )
        self.assertEqual(
            app.ready(),
            {
                "status": "ready",
                "requiredAtomicAmount": "25000000",
                "minimumLockSeconds": 604_800,
            },
        )

    def test_unix_socket_serves_health_without_opening_tcp(self) -> None:
        socket_path = Path(self.temp.name) / "issuer.sock"
        settings = dataclasses.replace(self.settings, socket_path=socket_path)
        issuer.Handler.app = issuer.Application(
            settings,
            matrix=FakeMatrix(),
            solana=FakeSolana("socket-receipt"),
        )
        server = issuer.unix_server(settings)
        socket_mode = stat.S_IMODE(os.stat(socket_path).st_mode)
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        try:
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(socket_path))
            client.sendall(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            response = b""
            while chunk := client.recv(4096):
                response += chunk
            client.close()
        finally:
            thread.join(timeout=5)
            server.server_close()
            if socket_path.exists():
                socket_path.unlink()
        self.assertIn(b"HTTP/1.0 200 OK", response)
        self.assertIn(b'{"status":"ok"}', response)
        self.assertEqual(socket_mode, 0o660)

    def test_environment_requires_https_rpc_and_loopback_matrix(self) -> None:
        secret = Path(self.temp.name) / "registration-secret"
        secret.write_text("test-secret")
        environment = {
            "NEAL_ACCESS_DATABASE": str(Path(self.temp.name) / "issuer.sqlite3"),
            "NEAL_ACCESS_SOLANA_RPC": "https://solana-rpc.publicnode.com",
            "NEAL_ACCESS_PROGRAM_ID": "11111111111111111111111111111111",
            "NEAL_ACCESS_CONFIG_ADDRESS": "11111111111111111111111111111111",
            "NEAL_ACCESS_MINT": "11111111111111111111111111111111",
            "NEAL_ACCESS_PUBLIC_ORIGIN": "https://nealtheseal.org",
            "NEAL_ACCESS_MATRIX_URL": "http://127.0.0.1:8008",
            "NEAL_ACCESS_MATRIX_SECRET_FILE": str(secret),
            "NEAL_ACCESS_SOCKET": str(Path(self.temp.name) / "issuer.sock"),
        }
        with patch.dict(os.environ, environment, clear=True):
            settings = issuer.Settings.from_environment()
        self.assertEqual(settings.socket_path, Path(environment["NEAL_ACCESS_SOCKET"]))

        environment["NEAL_ACCESS_MATRIX_URL"] = "https://matrix.example.invalid"
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(issuer.IssuerError, "loopback"):
                issuer.Settings.from_environment()

    def test_wire_parsers_reject_wrong_size_and_decode_expected_offsets(self) -> None:
        key = bytes(range(32))
        config = b"".join(
            (
                issuer.CONFIG_DISCRIMINATOR,
                b"\x01",
                key,
                struct.pack("<Q", 7),
                key,
                issuer.public_key(issuer.TOKEN_2022_PROGRAM),
                struct.pack("<Qq", 25_000_000, 604_800),
                b"\x00\xfe",
            )
        )
        parsed = issuer.parse_config(config)
        self.assertEqual(parsed["config_id"], 7)
        self.assertEqual(parsed["required_amount"], 25_000_000)
        self.assertEqual(parsed["bump"], 254)
        with self.assertRaises(issuer.IssuerError):
            issuer.parse_config(config[:-1])


if __name__ == "__main__":
    unittest.main()
