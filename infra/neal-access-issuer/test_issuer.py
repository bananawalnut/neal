from __future__ import annotations

import base64
import contextlib
import dataclasses
import datetime as dt
import io
import http.client
import json
import os
import re
import socket
import sqlite3
import stat
import struct
import tempfile
import threading
import time
import unittest
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import issuer
import backup
import matrix_loopback
import reconcile
import s3_backup


class MatrixLoopbackTests(unittest.TestCase):
    def test_routes_are_fixed_to_matrix_and_shared_secret_registration(self) -> None:
        self.assertTrue(matrix_loopback.route_allowed("GET", "/_matrix/client/versions"))
        self.assertTrue(matrix_loopback.route_allowed("POST", "/_matrix/client/v3/register?kind=user"))
        self.assertTrue(matrix_loopback.route_allowed("GET", "/_synapse/admin/v1/register"))
        self.assertFalse(matrix_loopback.route_allowed("GET", "/_synapse/admin/v2/users"))
        self.assertFalse(matrix_loopback.route_allowed("CONNECT", "/_matrix/client/versions"))
        self.assertFalse(matrix_loopback.route_allowed("GET", "http://example.invalid/_matrix/client/versions"))
        self.assertFalse(matrix_loopback.route_allowed("GET", "/_matrix/%2e%2e/_synapse/admin/v2/users"))
        self.assertFalse(matrix_loopback.route_allowed("GET", "//["))
        self.assertFalse(matrix_loopback.route_allowed("GET", "//[::1"))
        self.assertFalse(matrix_loopback.route_allowed("GET", "/_matrix/client/%ZZ"))
        self.assertEqual(matrix_loopback.WORKER_LIMIT, 32)
        self.assertEqual(
            matrix_loopback.validated_target(
                "GET", "/_matrix/client/v3/sync?since=opaque%26value&timeout=30000"
            ),
            "/_matrix/client/v3/sync?since=opaque%26value&timeout=30000",
        )

    def test_headers_are_allowlisted_and_reject_injected_values(self) -> None:
        headers = {
            "Authorization": "Bearer opaque",
            "Content-Type": "application/json",
            "Connection": "keep-alive",
            "X-Forwarded-Host": "attacker.invalid",
            "Accept": "application/json\r\nInjected: yes",
        }
        self.assertEqual(
            matrix_loopback.filtered_headers(headers, matrix_loopback.REQUEST_HEADERS),
            {"Authorization": "Bearer opaque", "Content-Type": "application/json"},
        )

    def test_proxy_forwards_only_allowed_routes_and_caps_bodies(self) -> None:
        calls: list[tuple[str, str, str | None]] = []

        class UpstreamHandler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *_arguments) -> None:
                return

            def _respond(self) -> None:
                calls.append((self.command, self.path, self.headers.get("Authorization")))
                if self.path == "/_matrix/slow":
                    time.sleep(0.1)
                body = b"x" * (matrix_loopback.MAX_BODY_BYTES + 1) if self.path == "/_matrix/large" else b'{"ok":true}'
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = _respond
            do_POST = _respond

        class QuietThreadingHTTPServer(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, _request, _client_address) -> None:
                return

        upstream = QuietThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        proxy = matrix_loopback.BoundedThreadingHTTPServer(
            ("127.0.0.1", 0), matrix_loopback.MatrixLoopbackHandler
        )
        original_host, original_port = matrix_loopback.UPSTREAM_HOST, matrix_loopback.UPSTREAM_PORT
        original_timeout = matrix_loopback.UPSTREAM_TIMEOUT_SECONDS
        matrix_loopback.UPSTREAM_HOST = "127.0.0.1"
        matrix_loopback.UPSTREAM_PORT = upstream.server_address[1]
        threads = [
            threading.Thread(target=upstream.serve_forever, daemon=True),
            threading.Thread(target=proxy.serve_forever, daemon=True),
        ]
        for thread in threads:
            thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            connection.request("GET", "/_matrix/client/versions", headers={"Authorization": "Bearer opaque"})
            response = connection.getresponse()
            self.assertEqual(response.status, HTTPStatus.OK)
            self.assertEqual(response.read(), b'{"ok":true}')
            connection.close()
            self.assertEqual(calls, [("GET", "/_matrix/client/versions", "Bearer opaque")])

            connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            connection.request("GET", "/_synapse/admin/v2/users")
            response = connection.getresponse()
            self.assertEqual(response.status, HTTPStatus.NOT_FOUND)
            response.read()
            connection.close()
            self.assertEqual(len(calls), 1)

            connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            connection.request("GET", "/_matrix/large")
            response = connection.getresponse()
            self.assertEqual(response.status, HTTPStatus.BAD_GATEWAY)
            response.read()
            connection.close()

            connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            connection.request(
                "POST", "/_matrix/client/v3/register", body=b"",
                headers={"Content-Length": str(matrix_loopback.MAX_BODY_BYTES + 1)},
            )
            response = connection.getresponse()
            self.assertEqual(response.status, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            response.read()
            connection.close()

            matrix_loopback.UPSTREAM_TIMEOUT_SECONDS = 0.01
            connection = http.client.HTTPConnection("127.0.0.1", proxy.server_address[1], timeout=5)
            connection.request("GET", "/_matrix/slow")
            response = connection.getresponse()
            self.assertEqual(response.status, HTTPStatus.BAD_GATEWAY)
            response.read()
            connection.close()
        finally:
            proxy.shutdown()
            upstream.shutdown()
            proxy.server_close()
            upstream.server_close()
            matrix_loopback.UPSTREAM_HOST = original_host
            matrix_loopback.UPSTREAM_PORT = original_port
            matrix_loopback.UPSTREAM_TIMEOUT_SECONDS = original_timeout


class FakeAccessDenied(RuntimeError):
    def __init__(self) -> None:
        super().__init__("access denied")
        self.response = {
            "Error": {"Code": "AccessDenied"},
            "ResponseMetadata": {"HTTPStatusCode": 403},
        }


class FakeSolana:
    def __init__(self, receipt: str):
        self.receipt = receipt
        self.consume_calls = 0

    def receipt_address(self, _address: str) -> str:
        return self.receipt

    def verify(self, _address: str) -> str:
        return self.receipt

    def consume(self, _address: str, receipt: str, persist_signed=None) -> str:
        self.consume_calls += 1
        if receipt != self.receipt:
            raise AssertionError("wrong receipt")
        if persist_signed:
            persist_signed(b"signed-transaction", "consume-signature", "blockhash", 100)
        return "consume-signature"

    def consumed(self, _receipt: str) -> bool:
        return self.consume_calls > 0

    def resume_consume(
        self,
        _address: str,
        receipt: str,
        _signed_transaction: bytes,
        _stored_signature: str,
        _blockhash: str,
        _last_valid_block_height: int,
        _replace_signed,
        attempted_signatures=None,
    ) -> str:
        if receipt != self.receipt:
            raise AssertionError("wrong receipt")
        self.consume_calls += 1
        return "consume-signature"

    def config(self) -> dict[str, int]:
        return {"required_amount": 25_000_000, "minimum_lock_seconds": 604_800, "revision": 0}


class GenesisContractTests(unittest.TestCase):
    def test_devnet_genesis_uses_the_canonical_full_hash(self) -> None:
        self.assertEqual(
            issuer.CHAIN_GENESIS["solana:devnet"],
            "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        )


class FakeMatrix:
    def __init__(self):
        self.calls = 0

    def issue(self, desired_token: str | None = None, _related_claim_id: str | None = None) -> tuple[str, int]:
        self.calls += 1
        return desired_token or "one-use-token", int(time.time() * 1000) + 900_000

    def ready(self) -> None:
        return None


class FailingMatrix(FakeMatrix):
    def issue(self, _desired_token: str | None = None, _related_claim_id: str | None = None) -> tuple[str, int]:
        self.calls += 1
        raise RuntimeError("simulated Matrix failure")


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str, str], bytes] = {}
        self.last_put: dict[str, object] | None = None
        self.deny_object_reads = False

    def get_bucket_versioning(self, **_kwargs: object) -> dict[str, str]:
        return {"Status": "Enabled"}

    def get_object_lock_configuration(self, **_kwargs: object) -> dict[str, object]:
        return {
            "ObjectLockConfiguration": {
                "ObjectLockEnabled": "Enabled",
                "Rule": {"DefaultRetention": {"Mode": "COMPLIANCE", "Days": 90}},
            }
        }

    def put_object(self, **kwargs: object) -> dict[str, str]:
        body = kwargs["Body"]
        payload = body.read()
        self.last_put = dict(kwargs)
        self.objects[(str(kwargs["Bucket"]), str(kwargs["Key"]), "version-1")] = payload
        return {"VersionId": "version-1"}

    def list_object_versions(self, **kwargs: object) -> dict[str, object]:
        if self.deny_object_reads:
            raise FakeAccessDenied()
        bucket = str(kwargs["Bucket"])
        prefix = str(kwargs["Prefix"])
        return {
            "Versions": [
                {
                    "Key": key,
                    "VersionId": version,
                    "IsLatest": True,
                    "LastModified": dt.datetime.now(dt.timezone.utc),
                }
                for (stored_bucket, key, version), _payload in self.objects.items()
                if stored_bucket == bucket and key.startswith(prefix)
            ]
        }

    def get_object(self, **kwargs: object) -> dict[str, object]:
        if self.deny_object_reads:
            raise FakeAccessDenied()
        payload = self.objects[(str(kwargs["Bucket"]), str(kwargs["Key"]), str(kwargs["VersionId"]))]
        return {"ContentLength": len(payload), "Body": io.BytesIO(payload)}


class FakeReconcileIssuer(issuer.MatrixIssuer):
    def __init__(self, settings: issuer.Settings, store: issuer.Store):
        super().__init__(settings, store)
        self.calls: list[tuple[str, str]] = []

    def temporary_admin(self) -> tuple[str, str]:
        return "@reconciler:test", "reconciler-token"

    def request_json(self, method: str, path: str, **_kwargs: object) -> dict[str, object]:
        self.calls.append((method, path))
        return {}

    def deactivate(self, user_id: str, _token: str) -> None:
        self.calls.append(("DEACTIVATE", user_id))


class IssuerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        secret = Path(self.temp.name) / "secret"
        secret.write_text("test-secret")
        recovery_key = Path(self.temp.name) / "recovery.key"
        recovery_key.write_bytes(b"r" * 32)
        issuer_keypair = Path(self.temp.name) / "issuer.json"
        signer = Ed25519PrivateKey.generate()
        signer_seed = signer.private_bytes(
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
        signer_public = signer.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
        issuer_keypair.write_text(str(list(signer_seed + signer_public)))
        self.settings = issuer.Settings(
            database=Path(self.temp.name) / "issuer.sqlite3",
            rpc_set=issuer.RpcSet(
                mode=issuer.RPC_QUORUM_MODE,
                threshold=2,
                endpoints=(
                    issuer.RpcEndpoint("provider-a", "operator-a", "https://rpc-a.invalid", "rpc-a.invalid"),
                    issuer.RpcEndpoint("provider-b", "operator-b", "https://rpc-b.invalid", "rpc-b.invalid"),
                    issuer.RpcEndpoint("provider-c", "operator-c", "https://rpc-c.invalid", "rpc-c.invalid"),
                ),
            ),
            chain_id="solana:mainnet",
            genesis_hash=issuer.CHAIN_GENESIS["solana:mainnet"],
            program_id="11111111111111111111111111111111",
            program_data_address="11111111111111111111111111111111",
            program_sha256="0" * 64,
            config_address="11111111111111111111111111111111",
            mint="11111111111111111111111111111111",
            expected_revision=0,
            expected_amount=25_000_000,
            expected_lock_seconds=604_800,
            issuer_keypair_file=issuer_keypair,
            public_origin="https://nealtheseal.org",
            matrix_url="http://127.0.0.1:8008",
            matrix_secret_file=secret,
            recovery_key_file=recovery_key,
            recovery_key_version=1,
            matrix_server_name="matrix.nealtheseal.org",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_matrix_request_json_uses_the_bounded_response_limit(self) -> None:
        matrix = issuer.MatrixIssuer(self.settings)
        response = contextlib.nullcontext(io.BytesIO(b'{"status":"ok"}'))
        with patch("issuer.urllib.request.urlopen", return_value=response):
            self.assertEqual(matrix.request_json("GET", "/_matrix/client/versions"), {"status": "ok"})

        oversized = contextlib.nullcontext(io.BytesIO(b"x" * (issuer.MAX_RPC_RESPONSE_BYTES + 1)))
        with patch("issuer.urllib.request.urlopen", return_value=oversized):
            with self.assertRaisesRegex(issuer.IssuerError, "response exceeded"):
                matrix.request_json("GET", "/_matrix/client/versions")

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

    def test_manual_expected_wallet_is_enforced_server_side(self) -> None:
        expected = "11111111111111111111111111111111"
        settings = dataclasses.replace(self.settings, expected_wallet=expected)
        app = issuer.Application(settings, matrix=FakeMatrix(), solana=FakeSolana("receipt"))
        other = issuer.base58_encode(Ed25519PrivateKey.generate().public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        ))
        with self.assertRaisesRegex(issuer.IssuerError, "not authorized"):
            app.challenge(
                {"schema": "neal.wallet-challenge-request/v2", "address": other, "chain": "solana:mainnet"},
                "test",
            )
        session = app.store.create_session(other, 600)
        with self.assertRaisesRegex(issuer.IssuerError, "not authorized"):
            app.access_token_v2(session, "test")

    def test_claim_is_idempotent_without_issuing_a_second_token(self) -> None:
        matrix = FakeMatrix()
        solana = FakeSolana("receipt-address")
        app = issuer.Application(self.settings, matrix=matrix, solana=solana)
        address = "11111111111111111111111111111111"
        session = app.store.create_session(address, 600)
        first = app.access_token(session, "first")
        second = app.access_token(session, "second")
        self.assertTrue(first["token"].startswith("neal_"))
        self.assertEqual(second["token"], first["token"])
        self.assertEqual(matrix.calls, 1)
        self.assertEqual(solana.consume_calls, 1)

    def test_chain_submitted_recovers_after_crash_and_forward_only_resign(self) -> None:
        class RecoveringSolana(FakeSolana):
            def __init__(self, receipt: str):
                super().__init__(receipt)
                self.resume_calls = 0

            def consume(self, _address: str, receipt: str, persist_signed=None) -> str:
                self.consume_calls += 1
                if persist_signed:
                    persist_signed(b"first-transaction", "first-signature", "first-blockhash", 100)
                raise RuntimeError("crash after durable journal")

            def resume_consume(
                self, _address, _receipt, _transaction, _signature, _blockhash, _height, replace_signed,
                attempted_signatures=None,
            ) -> str:
                self.resume_calls += 1
                replace_signed(b"replacement-transaction", "replacement-signature", "replacement-blockhash", 200)
                return "replacement-signature"

        address = "11111111111111111111111111111111"
        solana = RecoveringSolana("recoverable-receipt")
        app = issuer.Application(self.settings, matrix=FakeMatrix(), solana=solana)
        session = app.store.create_session(address, 600)

        status, pending = app.access_token_v2(session, "first")
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        self.assertEqual(pending["state"], "processing")
        journaled = app.store.claim("recoverable-receipt")
        self.assertEqual(journaled["phase"], "CHAIN_SUBMITTED")
        self.assertEqual(journaled["chain_signature"], "first-signature")
        self.assertEqual(journaled["chain_last_valid_block_height"], 100)

        app.store.clear_claim_attention("recoverable-receipt")
        status, recovered = app.access_token_v2(session, "second")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(recovered["state"], "token_ready")
        self.assertEqual(solana.resume_calls, 1)
        completed = app.store.claim("recoverable-receipt")
        self.assertEqual(completed["phase"], "TOKEN_READY")
        self.assertEqual(completed["chain_signature"], "replacement-signature")
        self.assertEqual(completed["chain_finalized_signature"], "replacement-signature")
        with app.store.connection() as database:
            phases = [row[0] for row in database.execute(
                "SELECT next_phase FROM claim_events WHERE operation_id = ? ORDER BY event_id",
                (completed["operation_id"],),
            ).fetchall()]
            attempts = [row[0] for row in database.execute(
                "SELECT signature FROM claim_chain_attempts WHERE operation_id = ? ORDER BY attempt_id",
                (completed["operation_id"],),
            ).fetchall()]
        self.assertIn("CHAIN_RETRY_REQUIRED", phases)
        self.assertEqual(attempts, ["first-signature", "replacement-signature"])

    def test_late_prior_attempt_finality_is_recorded_as_signature_ambiguous(self) -> None:
        class AmbiguousSolana(FakeSolana):
            def consume(self, _address: str, _receipt: str, persist_signed=None) -> str:
                if persist_signed:
                    persist_signed(b"attempt-a", "signature-a", "blockhash-a", 100)
                raise RuntimeError("submission response lost")

            def resume_consume(
                self, _address, _receipt, _transaction, _signature, _blockhash, _height, replace_signed,
                attempted_signatures=None,
            ) -> None:
                replace_signed(b"attempt-b", "signature-b", "blockhash-b", 200)
                return None

        address = "11111111111111111111111111111111"
        app = issuer.Application(self.settings, matrix=FakeMatrix(), solana=AmbiguousSolana("ambiguous-receipt"))
        session = app.store.create_session(address, 600)
        status, _pending = app.access_token_v2(session, "first")
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        status, ready = app.access_token_v2(session, "second")
        self.assertEqual(status, HTTPStatus.ACCEPTED)
        self.assertEqual(ready["state"], "processing")
        completed = app.store.claim("ambiguous-receipt")
        self.assertEqual(completed["phase"], "CHAIN_CONSUMED")
        self.assertIsNone(completed["chain_finalized_signature"])
        self.assertEqual(completed["attention_required"], 1)
        self.assertEqual(completed["last_error_code"], "chain_signature_ambiguous")
        with app.store.connection() as database:
            attempts = [row[0] for row in database.execute(
                "SELECT signature FROM claim_chain_attempts WHERE operation_id = ? ORDER BY attempt_id",
                (completed["operation_id"],),
            ).fetchall()]
        self.assertEqual(attempts, ["signature-a", "signature-b"])

    def _ambiguous_claim(self, receipt: str, operation_wallet: str = "wallet") -> tuple[issuer.Store, str]:
        store = issuer.Store(self.settings.database)
        row = store.reserve_claim(receipt, operation_wallet, "config", 1, 1)
        row = store.transition_claim(
            receipt,
            ("RESERVED",),
            "CHAIN_SUBMITTED",
            event_type="chain_transaction_signed",
            fields={
                "signed_transaction": b"attempt-transaction",
                "chain_signature": "attempt-signature",
                "chain_blockhash": "attempt-blockhash",
                "chain_last_valid_block_height": 100,
            },
            chain_attempt={
                "transaction": b"attempt-transaction",
                "signature": "attempt-signature",
                "blockhash": "attempt-blockhash",
                "last_valid_block_height": 100,
            },
        )
        row = store.transition_claim(
            receipt,
            ("CHAIN_SUBMITTED",),
            "CHAIN_CONSUMED",
            event_type="chain_consumption_recovered",
            fields={
                "chain_finalized_signature": None,
                "attention_required": 1,
                "last_error_code": "chain_signature_ambiguous",
            },
        )
        return store, row["operation_id"]

    def test_ambiguous_consumption_requires_explicit_attribution_and_journals_it(self) -> None:
        class FinalizedSolana(FakeSolana):
            def consumption_signature_finalized(self, receipt: str, signature: str) -> bool:
                return receipt == self.receipt and signature == "attempt-signature"

        store, operation_id = self._ambiguous_claim("attributed-receipt")
        with self.assertRaisesRegex(issuer.IssuerError, "explicit operator resolution"):
            store.clear_claim_attention("attributed-receipt")
        inspection = reconcile.inspect_operation(store, operation_id)
        self.assertIsNone(inspection["claim"]["chain_finalized_signature"])
        self.assertEqual(
            [attempt["signature"] for attempt in inspection["chainAttempts"]],
            ["attempt-signature"],
        )

        app = issuer.Application(
            self.settings,
            matrix=FakeMatrix(),
            solana=FinalizedSolana("attributed-receipt"),
        )
        resolved = reconcile.attribute_finalized_consumption(
            app, operation_id, "attempt-signature"
        )
        self.assertEqual(resolved["chain_finalized_signature"], "attempt-signature")
        self.assertEqual(resolved["attention_required"], 0)
        with store.connection() as database:
            event = database.execute(
                """SELECT event_type, metadata_json FROM claim_events
                   WHERE operation_id = ? ORDER BY event_id DESC LIMIT 1""",
                (operation_id,),
            ).fetchone()
        self.assertEqual(event["event_type"], "operator_attributed_finalized_chain_signature")
        self.assertEqual(
            json.loads(event["metadata_json"]),
            {"finalizedSignature": "attempt-signature"},
        )

    def test_ambiguous_consumption_can_be_explicitly_accepted_without_attribution(self) -> None:
        class ConsumedSolana(FakeSolana):
            def consumed(self, receipt: str) -> bool:
                return receipt == self.receipt

        store, operation_id = self._ambiguous_claim("unattributed-receipt")
        app = issuer.Application(
            self.settings,
            matrix=FakeMatrix(),
            solana=ConsumedSolana("unattributed-receipt"),
        )
        resolved = reconcile.accept_unattributed_consumption(app, operation_id)
        self.assertIsNone(resolved["chain_finalized_signature"])
        self.assertEqual(resolved["attention_required"], 0)
        with store.connection() as database:
            event = database.execute(
                """SELECT event_type, metadata_json FROM claim_events
                   WHERE operation_id = ? ORDER BY event_id DESC LIMIT 1""",
                (operation_id,),
            ).fetchone()
        self.assertEqual(event["event_type"], "operator_accepted_unattributed_chain_consumption")
        self.assertEqual(json.loads(event["metadata_json"]), {"acceptedWithoutSignature": True})

    def test_pre_v6_completed_claim_signature_is_not_inferred(self) -> None:
        database = sqlite3.connect(self.settings.database)
        database.executescript(
            """
            CREATE TABLE claim_operations (
              receipt TEXT PRIMARY KEY,
              operation_id TEXT NOT NULL UNIQUE,
              address TEXT NOT NULL,
              config_address TEXT,
              config_revision INTEGER,
              phase TEXT NOT NULL,
              attention_required INTEGER NOT NULL DEFAULT 0,
              chain_signature TEXT,
              chain_blockhash TEXT,
              chain_last_valid_block_height INTEGER,
              signed_transaction BLOB,
              recovery_key_version INTEGER NOT NULL,
              token_generation INTEGER NOT NULL DEFAULT 0,
              token_commitment TEXT,
              expires_at_ms INTEGER,
              matrix_pending INTEGER,
              matrix_completed INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              last_error_code TEXT
            );
            INSERT INTO claim_operations(
              receipt, operation_id, address, config_address, config_revision, phase,
              attention_required, chain_signature, chain_blockhash,
              chain_last_valid_block_height, signed_transaction, recovery_key_version,
              token_generation, created_at, updated_at
            ) VALUES (
              'pre-v6-receipt', 'pre-v6-operation', 'wallet', 'config', 1,
              'TOKEN_READY', 0, 'replacement-b', 'blockhash-b', 200,
              X'0102', 1, 0, 1, 1
            );
            PRAGMA user_version = 5;
            """
        )
        database.close()

        store = issuer.Store(self.settings.database)
        migrated = store.claim("pre-v6-receipt")
        self.assertEqual(migrated["phase"], "LEGACY_REVIEW")
        self.assertIsNone(migrated["chain_finalized_signature"])
        self.assertEqual(migrated["attention_required"], 1)
        self.assertEqual(
            migrated["last_error_code"],
            "legacy_chain_signature_attribution_required",
        )
        with store.connection() as connection:
            event = connection.execute(
                """SELECT previous_phase, next_phase, event_type, metadata_json
                   FROM claim_events WHERE operation_id = ?""",
                ("pre-v6-operation",),
            ).fetchone()
        self.assertEqual(event["previous_phase"], "TOKEN_READY")
        self.assertEqual(event["next_phase"], "LEGACY_REVIEW")
        self.assertEqual(event["event_type"], "legacy_chain_signature_attribution_quarantined")
        self.assertEqual(
            json.loads(event["metadata_json"]),
            {"reason": "pre_v6_finalized_signature_cannot_be_proven"},
        )

    def test_v3_chain_submissions_without_recovery_metadata_are_quarantined(self) -> None:
        database = sqlite3.connect(self.settings.database)
        database.executescript(
            """
            CREATE TABLE claim_operations (
              receipt TEXT PRIMARY KEY,
              operation_id TEXT NOT NULL UNIQUE,
              address TEXT NOT NULL,
              config_address TEXT,
              config_revision INTEGER,
              phase TEXT NOT NULL,
              attention_required INTEGER NOT NULL DEFAULT 0,
              chain_signature TEXT,
              signed_transaction BLOB,
              recovery_key_version INTEGER NOT NULL,
              token_generation INTEGER NOT NULL DEFAULT 0,
              token_commitment TEXT,
              expires_at_ms INTEGER,
              matrix_pending INTEGER,
              matrix_completed INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              last_error_code TEXT
            );
            INSERT INTO claim_operations(
              receipt, operation_id, address, config_address, config_revision, phase,
              attention_required, chain_signature, signed_transaction, recovery_key_version,
              token_generation, created_at, updated_at
            ) VALUES (
              'old-receipt', 'old-operation', 'old-wallet', 'old-config', 0,
              'CHAIN_SUBMITTED', 0, 'old-signature', X'0102', 1, 0, 1, 1
            );
            INSERT INTO claim_operations(
              receipt, operation_id, address, config_address, config_revision, phase,
              attention_required, chain_signature, signed_transaction, recovery_key_version,
              token_generation, created_at, updated_at
            ) VALUES (
              'old-finalized-receipt', 'old-finalized-operation', 'old-wallet', 'old-config', 0,
              'CHAIN_SUBMITTED', 0, 'old-finalized-signature', X'0304', 1, 0, 1, 1
            );
            PRAGMA user_version = 3;
            """
        )
        database.close()

        store = issuer.Store(self.settings.database)
        migrated = store.claim("old-receipt")
        self.assertEqual(migrated["phase"], "LEGACY_REVIEW")
        self.assertEqual(migrated["attention_required"], 1)
        self.assertEqual(migrated["last_error_code"], "legacy_chain_submission_review_required")
        finalized_on_chain_but_locally_ambiguous = store.claim("old-finalized-receipt")
        self.assertEqual(finalized_on_chain_but_locally_ambiguous["phase"], "LEGACY_REVIEW")
        self.assertEqual(finalized_on_chain_but_locally_ambiguous["attention_required"], 1)
        with store.connection() as connection:
            event = connection.execute(
                """SELECT previous_phase, next_phase, event_type, metadata_json
                   FROM claim_events WHERE operation_id = ?""",
                ("old-operation",),
            ).fetchone()
            self.assertEqual(event["previous_phase"], "CHAIN_SUBMITTED")
            self.assertEqual(event["next_phase"], "LEGACY_REVIEW")
            self.assertEqual(event["event_type"], "legacy_chain_submission_quarantined")
            self.assertEqual(
                json.loads(event["metadata_json"]),
                {"reason": "missing_recoverable_submission_metadata"},
            )

    def test_concurrent_chain_resign_compare_and_swap_converges_forward(self) -> None:
        store = issuer.Store(self.settings.database)
        row = store.reserve_claim("concurrent-receipt", "wallet", "config", 0, 1)
        store.transition_claim(
            row["receipt"], ("RESERVED",), "CHAIN_SUBMITTED",
            event_type="chain_transaction_signed",
            fields={
                "signed_transaction": b"first", "chain_signature": "first",
                "chain_blockhash": "blockhash", "chain_last_valid_block_height": 100,
            },
        )
        barrier = threading.Barrier(2)
        results: list[str] = []

        def replace(label: str) -> None:
            barrier.wait()
            try:
                store.transition_claim(
                    row["receipt"], ("CHAIN_SUBMITTED",), "CHAIN_RETRY_REQUIRED",
                    event_type="chain_transaction_replaced",
                    fields={
                        "signed_transaction": label.encode(), "chain_signature": label,
                        "chain_blockhash": f"{label}-blockhash", "chain_last_valid_block_height": 200,
                    },
                )
                results.append("won")
            except issuer.IssuerError:
                results.append("lost")

        threads = [threading.Thread(target=replace, args=(label,)) for label in ("one", "two")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertCountEqual(results, ["won", "lost"])
        recovered = store.claim(row["receipt"])
        self.assertEqual(recovered["phase"], "CHAIN_RETRY_REQUIRED")
        store.transition_claim(
            row["receipt"], ("CHAIN_RETRY_REQUIRED",), "CHAIN_CONSUMED",
            event_type="chain_consumption_recovered",
        )
        self.assertEqual(store.claim(row["receipt"])["phase"], "CHAIN_CONSUMED")

    def test_expired_or_failed_claim_never_issues_a_second_token(self) -> None:
        address = "11111111111111111111111111111111"
        matrix = FakeMatrix()
        app = issuer.Application(self.settings, matrix=matrix, solana=FakeSolana("expired-receipt"))
        session = app.store.create_session(address, 600)
        app.access_token(session, "first")
        with app.store.connection() as database:
            database.execute("UPDATE claim_operations SET expires_at_ms = 0 WHERE receipt = 'expired-receipt'")
        with self.assertRaisesRegex(issuer.IssuerError, "expired"):
            app.access_token(session, "second")
        self.assertEqual(matrix.calls, 1)

        failing = FailingMatrix()
        failed_app = issuer.Application(self.settings, matrix=failing, solana=FakeSolana("failed-receipt"))
        failed_session = failed_app.store.create_session(address, 600)
        with self.assertRaisesRegex(issuer.IssuerError, "processing"):
            failed_app.access_token(failed_session, "third")
        with self.assertRaisesRegex(issuer.IssuerError, "processing"):
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
                "schema": "neal.issuer-readiness/v2",
                "status": "ready",
                "checks": {
                    "database": "ok",
                    "restoreReconciliation": "ok",
                    "rpcQuorum": "ok",
                    "programAttestation": "ok",
                    "matrixControl": "ok",
                    "adminCleanup": "ok",
                },
                "chainId": self.settings.chain_id,
                "sourceCommit": None,
                "issuerImageId": None,
                "expectedWallet": None,
                "verificationMode": issuer.RPC_QUORUM_MODE,
                "programId": self.settings.program_id,
                "programDataAddress": self.settings.program_data_address,
                "programSha256": self.settings.program_sha256,
                "configAddress": self.settings.config_address,
                "mint": self.settings.mint,
                "requiredAtomicAmount": "25000000",
                "minimumLockSeconds": 604_800,
                "configRevision": "0",
            },
        )

    def test_admin_cleanup_reconciliation_revokes_token_and_both_admins(self) -> None:
        store = issuer.Store(self.settings.database)
        store.add_admin_cleanup("@orphan:test", "registration-token", "cleanup failed")
        matrix = FakeReconcileIssuer(self.settings, store)
        matrix.reconcile_admin_cleanup("@orphan:test")
        self.assertEqual(store.unresolved_admin_cleanups(), 0)
        self.assertEqual(
            matrix.calls,
            [
                ("DELETE", "/_synapse/admin/v1/registration_tokens/registration-token"),
                ("DEACTIVATE", "@orphan:test"),
                ("DEACTIVATE", "@reconciler:test"),
            ],
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
        self.assertIn(b'{"schema":"neal.health/v1","status":"ok"}', response)
        self.assertEqual(socket_mode, 0o660)

    def test_environment_requires_https_rpc_and_loopback_matrix(self) -> None:
        secret = Path(self.temp.name) / "registration-secret"
        secret.write_text("test-secret")
        rpc_set = Path(self.temp.name) / "rpc-set.json"
        rpc_set.write_text(json.dumps({
            "schema": issuer.RPC_SET_SCHEMA,
            "mode": issuer.RPC_QUORUM_MODE,
            "threshold": 2,
            "endpoints": [
                {"id": "helius-mainnet", "trustDomain": "helius.xyz", "url": "https://mainnet.helius-rpc.com/?api-key=test"},
                {"id": "quicknode-mainnet", "trustDomain": "quicknode.com", "url": "https://neal.solana-mainnet.quiknode.pro/test/"},
                {"id": "alchemy-mainnet", "trustDomain": "alchemy.com", "url": "https://solana-mainnet.g.alchemy.com/v2/test"},
            ],
        }))
        environment = {
            "NEAL_ACCESS_DATABASE": str(Path(self.temp.name) / "issuer.sqlite3"),
            "NEAL_ACCESS_SOLANA_RPC_SET_FILE": str(rpc_set),
            "NEAL_ACCESS_CHAIN_ID": "solana:mainnet",
            "NEAL_ACCESS_SOLANA_GENESIS_HASH": issuer.CHAIN_GENESIS["solana:mainnet"],
            "NEAL_ACCESS_PROGRAM_ID": "11111111111111111111111111111111",
            "NEAL_ACCESS_PROGRAM_DATA_ADDRESS": "11111111111111111111111111111111",
            "NEAL_ACCESS_PROGRAM_SHA256": "0" * 64,
            "NEAL_ACCESS_CONFIG_ADDRESS": "11111111111111111111111111111111",
            "NEAL_ACCESS_MINT": "11111111111111111111111111111111",
            "NEAL_ACCESS_EXPECTED_REVISION": "0",
            "NEAL_ACCESS_EXPECTED_AMOUNT": "25000000",
            "NEAL_ACCESS_EXPECTED_LOCK_SECONDS": "604800",
            "NEAL_ACCESS_ISSUER_KEYPAIR_FILE": str(self.settings.issuer_keypair_file),
            "NEAL_ACCESS_PUBLIC_ORIGIN": "https://nealtheseal.org",
            "NEAL_ACCESS_MATRIX_URL": "http://127.0.0.1:8008",
            "NEAL_ACCESS_MATRIX_SECRET_FILE": str(secret),
            "NEAL_ACCESS_RECOVERY_KEY_FILE": str(self.settings.recovery_key_file),
            "NEAL_ACCESS_RECOVERY_KEY_VERSION": "1",
            "NEAL_ACCESS_MATRIX_SERVER_NAME": "matrix.nealtheseal.org",
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
                b"\x02",
                key,
                key,
                struct.pack("<Q", 7),
                key,
                issuer.public_key(issuer.TOKEN_2022_PROGRAM),
                struct.pack("<QQq", 3, 25_000_000, 604_800),
                b"\x00\xfe",
            )
        )
        parsed = issuer.parse_config(config)
        self.assertEqual(parsed["config_id"], 7)
        self.assertEqual(parsed["required_amount"], 25_000_000)
        self.assertEqual(parsed["revision"], 3)
        self.assertEqual(parsed["bump"], 254)
        with self.assertRaises(issuer.IssuerError):
            issuer.parse_config(config[:-1])

    def test_independent_rpc_disagreement_fails_closed(self) -> None:
        verifier = issuer.SolanaVerifier(self.settings)
        with patch.object(verifier, "rpc_endpoint", side_effect=lambda endpoint, *_args: {
            "context": {"slot": 10}, "value": {"lamports": endpoint.id}
        }):
            with self.assertRaisesRegex(issuer.IssuerError, "quorum"):
                verifier.rpc("getAccountInfo", ["address"])

    def test_rpc_redirect_to_another_host_fails_closed(self) -> None:
        class RedirectedResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def geturl(self) -> str:
                return "https://attacker.invalid/rpc"

            def read(self, _maximum: int) -> bytes:
                return b'{"jsonrpc":"2.0","result":1}'

        verifier = issuer.SolanaVerifier(self.settings)
        with patch.object(issuer.urllib.request, "urlopen", return_value=RedirectedResponse()):
            with self.assertRaisesRegex(issuer.IssuerError, "redirect"):
                verifier.rpc_endpoint(self.settings.rpc_set.endpoints[0], "getBlockHeight", [])

    def test_consume_recovery_rebroadcasts_while_valid_and_resigns_after_quorum_expiry(self) -> None:
        verifier = issuer.SolanaVerifier(self.settings)
        address = "11111111111111111111111111111111"
        receipt = verifier.receipt_address(address)
        blockhash = issuer.base58_encode(b"b" * 32)
        replacement_blockhash = issuer.base58_encode(b"c" * 32)
        with patch.object(verifier, "rpc", return_value={
            "value": {"blockhash": blockhash, "lastValidBlockHeight": 100}
        }):
            transaction, signature, stored_blockhash, height = verifier._build_consume_transaction(address, receipt)

        with (
            patch.object(verifier, "consumed", return_value=False),
            patch.object(verifier, "rpc", return_value=99),
            patch.object(verifier, "_broadcast_consume", return_value=signature) as broadcast,
        ):
            self.assertEqual(
                verifier.resume_consume(
                    address, receipt, transaction, signature, stored_blockhash, height,
                    lambda *_args: self.fail("valid transaction must not be replaced"),
                ),
                signature,
            )
            broadcast.assert_called_once_with(transaction, signature, receipt)

        replacements = []
        def rpc(method, _params):
            if method == "getBlockHeight":
                return 101
            if method == "getLatestBlockhash":
                return {"value": {"blockhash": replacement_blockhash, "lastValidBlockHeight": 250}}
            raise AssertionError(method)

        with (
            patch.object(verifier, "consumed", side_effect=[False, False]),
            patch.object(verifier, "rpc", side_effect=rpc),
            patch.object(verifier, "_broadcast_consume", side_effect=lambda _tx, expected, _receipt: expected),
        ):
            recovered = verifier.resume_consume(
                address, receipt, transaction, signature, stored_blockhash, height,
                lambda *values: replacements.append(values),
            )
        self.assertEqual(len(replacements), 1)
        self.assertEqual(replacements[0][2], replacement_blockhash)
        self.assertEqual(replacements[0][3], 250)
        self.assertEqual(recovered, replacements[0][1])

    def test_consumed_receipt_without_finalized_current_attempt_is_signature_ambiguous(self) -> None:
        verifier = issuer.SolanaVerifier(self.settings)
        address = "11111111111111111111111111111111"
        receipt = verifier.receipt_address(address)
        blockhash = issuer.base58_encode(b"b" * 32)
        with patch.object(verifier, "rpc", return_value={
            "value": {"blockhash": blockhash, "lastValidBlockHeight": 100}
        }):
            transaction, signature, stored_blockhash, height = verifier._build_consume_transaction(address, receipt)
        with (
            patch.object(verifier, "consumed", return_value=True),
            patch.object(verifier, "_signature_finalized", return_value=False),
        ):
            self.assertIsNone(verifier.resume_consume(
                address, receipt, transaction, signature, stored_blockhash, height,
                lambda *_args: self.fail("consumed receipt must not be replaced"),
            ))

    def test_late_prior_attempt_is_attributed_from_append_only_history(self) -> None:
        verifier = issuer.SolanaVerifier(self.settings)
        address = "11111111111111111111111111111111"
        receipt = verifier.receipt_address(address)
        blockhash = issuer.base58_encode(b"b" * 32)
        with patch.object(verifier, "rpc", return_value={
            "value": {"blockhash": blockhash, "lastValidBlockHeight": 100}
        }):
            transaction, current, stored_blockhash, height = verifier._build_consume_transaction(address, receipt)
        prior = "prior-attempt-signature"
        with (
            patch.object(verifier, "consumed", return_value=True),
            patch.object(verifier, "_signature_finalized", side_effect=lambda value: value == prior),
        ):
            self.assertEqual(verifier.resume_consume(
                address, receipt, transaction, current, stored_blockhash, height,
                lambda *_args: self.fail("consumed receipt must not be replaced"),
                attempted_signatures=(prior, current),
            ), prior)

    def test_consume_broadcast_rejects_minority_acceptance(self) -> None:
        verifier = issuer.SolanaVerifier(self.settings)
        with patch.object(
            verifier,
            "rpc_endpoint",
            side_effect=["signature", issuer.IssuerError("down"), issuer.IssuerError("down")],
        ):
            with self.assertRaisesRegex(issuer.IssuerError, "required RPC quorum"):
                verifier.broadcast(b"signed-transaction")

    def test_rpc_quorum_accepts_two_matching_domains_and_rejects_single_rpc_mainnet(self) -> None:
        verifier = issuer.SolanaVerifier(self.settings)
        with patch.object(verifier, "rpc_endpoint", side_effect=lambda endpoint, *_args: {
            "context": {"slot": 10},
            "value": {"lamports": 2 if endpoint.id == "provider-c" else 1},
        }):
            self.assertEqual(verifier.rpc("getAccountInfo", ["address"])["value"]["lamports"], 1)

        preview = Path(self.temp.name) / "preview-rpc.json"
        preview.write_text(json.dumps({
            "schema": issuer.RPC_SET_SCHEMA,
            "mode": issuer.RPC_PREVIEW_MODE,
            "threshold": 1,
            "endpoints": [{"id": "preview", "trustDomain": "operator", "url": "https://rpc.invalid"}],
        }))
        with self.assertRaisesRegex(issuer.IssuerError, "devnet"):
            issuer.RpcSet.load(preview, "solana:mainnet")

        example = Path(__file__).with_name("solana-rpc-set.devnet-quorum.example.json")
        devnet = issuer.RpcSet.load(example, "solana:devnet")
        self.assertEqual(devnet.mode, issuer.RPC_QUORUM_MODE)
        self.assertEqual(devnet.threshold, 2)
        self.assertEqual(
            {endpoint.id for endpoint in devnet.endpoints},
            {"helius-devnet", "quicknode-devnet", "alchemy-devnet"},
        )
        self.assertEqual(
            {endpoint.host for endpoint in devnet.endpoints},
            {
                "devnet.helius-rpc.com",
                "neal.solana-devnet.quiknode.pro",
                "solana-devnet.g.alchemy.com",
            },
        )
        value = json.loads(example.read_text())
        for mutation in (
            lambda candidate: candidate["endpoints"][0].update({"trustDomain": "quicknode.com"}),
            lambda candidate: candidate["endpoints"][0].update({"url": "https://helius-rpc.com.evil.invalid/key"}),
            lambda candidate: candidate["endpoints"][0].update({"id": "quicknode-alias"}),
        ):
            candidate = json.loads(json.dumps(value))
            mutation(candidate)
            invalid = Path(self.temp.name) / f"invalid-{len(list(Path(self.temp.name).glob('invalid-*')))}.json"
            invalid.write_text(json.dumps(candidate))
            with self.assertRaisesRegex(issuer.IssuerError, "trust domains|approved trust registry"):
                issuer.RpcSet.load(invalid, "solana:devnet")

    def test_issuer_keypair_rejects_mismatched_public_half(self) -> None:
        self.settings.issuer_keypair_file.write_text(str([0] * 64))
        with self.assertRaisesRegex(issuer.IssuerError, "does not match"):
            issuer.SolanaVerifier(self.settings)

    def test_encrypted_online_backup_round_trip_and_authentication(self) -> None:
        store = issuer.Store(self.settings.database)
        store.add_admin_cleanup("@temporary:test", "registration-token", "cleanup failed")
        passphrase = Path(self.temp.name) / "backup-passphrase"
        passphrase.write_text("correct horse battery staple")
        os.chmod(passphrase, 0o600)
        encrypted = Path(self.temp.name) / "issuer.nealbak"
        restored = Path(self.temp.name) / "restored.sqlite3"

        backup.create_backup(self.settings.database, encrypted, passphrase)
        self.assertEqual(encrypted.read_bytes()[:8], backup.MAGIC)
        self.assertEqual(stat.S_IMODE(encrypted.stat().st_mode), 0o600)
        backup.restore_backup(encrypted, restored, passphrase)
        with contextlib.closing(sqlite3.connect(restored)) as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM admin_cleanups").fetchone()[0], 1)

        wrong = Path(self.temp.name) / "wrong-passphrase"
        wrong.write_text("this passphrase is definitely wrong")
        os.chmod(wrong, 0o600)
        with self.assertRaisesRegex(backup.BackupError, "authentication failed"):
            backup.restore_backup(encrypted, Path(self.temp.name) / "wrong.sqlite3", wrong)

    def test_backup_rejects_passphrase_file_with_broad_permissions(self) -> None:
        issuer.Store(self.settings.database)
        passphrase = Path(self.temp.name) / "backup-passphrase"
        passphrase.write_text("correct horse battery staple")
        os.chmod(passphrase, 0o644)
        with self.assertRaisesRegex(backup.BackupError, "exactly 0600"):
            backup.create_backup(
                self.settings.database,
                Path(self.temp.name) / "issuer.nealbak",
                passphrase,
            )

    def test_backup_rejects_same_input_and_output(self) -> None:
        issuer.Store(self.settings.database)
        passphrase = Path(self.temp.name) / "backup-passphrase"
        passphrase.write_text("correct horse battery staple")
        os.chmod(passphrase, 0o600)
        with self.assertRaisesRegex(backup.BackupError, "different files"):
            backup.create_backup(self.settings.database, self.settings.database, passphrase, replace=True)

    def test_restore_rejects_same_input_and_output_and_sqlite_sidecars(self) -> None:
        issuer.Store(self.settings.database)
        passphrase = Path(self.temp.name) / "backup-passphrase"
        passphrase.write_text("correct horse battery staple")
        os.chmod(passphrase, 0o600)
        encrypted = Path(self.temp.name) / "issuer.nealbak"
        restored = Path(self.temp.name) / "restored.sqlite3"
        backup.create_backup(self.settings.database, encrypted, passphrase)
        with self.assertRaisesRegex(backup.BackupError, "different files"):
            backup.restore_backup(encrypted, encrypted, passphrase, replace=True)
        restored.write_bytes(b"old database")
        Path(f"{restored}-wal").write_bytes(b"stale")
        with self.assertRaisesRegex(backup.BackupError, "sidecar"):
            backup.restore_backup(encrypted, restored, passphrase, replace=True)

    def test_v2_backup_uses_off_host_recovery_key_and_authenticates_metadata(self) -> None:
        issuer.Store(self.settings.database)
        private_key = Path(self.temp.name) / "recovery-private.pem"
        public_key = Path(self.temp.name) / "recovery-public.pem"
        fingerprint = backup.generate_recovery_keypair(private_key, public_key)
        encrypted = Path(self.temp.name) / "issuer-v2.nealbak"
        restored = Path(self.temp.name) / "restored-v2.sqlite3"
        metadata = backup.create_envelope_backup(
            self.settings.database,
            encrypted,
            public_key,
            source_commit="a" * 40,
            schema_version=2,
            ledger_generation="generation-7",
        )

        self.assertEqual(encrypted.read_bytes()[:8], backup.MAGIC_V2)
        self.assertEqual(metadata["recoveryKeyFingerprint"], fingerprint)
        restored_metadata = backup.restore_backup(
            encrypted, restored, private_key_file=private_key
        )
        self.assertEqual(restored_metadata["ledgerGeneration"], "generation-7")
        marker = restored.parent / "restore-reconciliation-required.json"
        self.assertEqual(json.loads(marker.read_text())["schema"], "neal.restore-reconciliation-marker/v1")
        with contextlib.closing(sqlite3.connect(restored)) as database:
            self.assertEqual(database.execute("PRAGMA integrity_check").fetchone()[0], "ok")

        payload = bytearray(encrypted.read_bytes())
        payload[-1] ^= 1
        encrypted.write_bytes(payload)
        with self.assertRaisesRegex(backup.BackupError, "authentication failed"):
            backup.restore_backup(
                encrypted,
                Path(self.temp.name) / "tampered.sqlite3",
                private_key_file=private_key,
            )

    def test_s3_upload_requires_protection_and_off_host_restore_verifies(self) -> None:
        issuer.Store(self.settings.database)
        private_key = Path(self.temp.name) / "recovery-private.pem"
        public_key = Path(self.temp.name) / "recovery-public.pem"
        backup.generate_recovery_keypair(private_key, public_key)
        uploader = s3_backup.S3Target(
            endpoint_url="https://objects.example.test",
            region="test-1",
            bucket="neal-backups",
            prefix="issuer",
            access_key_id="upload-key",
            secret_access_key="upload-secret",
            session_token=None,
            retention_days=30,
            credential_mode=s3_backup.UPLOAD_MODE,
            addressing_style="path",
        )
        fake = FakeS3()
        fake.deny_object_reads = True
        receipt = s3_backup.upload_snapshot(
            uploader,
            fake,
            self.settings.database,
            public_key,
            source_commit="b" * 40,
            schema_version=2,
            ledger_generation="generation-8",
        )
        self.assertEqual(receipt["versionId"], "version-1")
        self.assertEqual(fake.last_put["ObjectLockMode"], "COMPLIANCE")
        self.assertEqual(receipt["objectLockMode"], "COMPLIANCE")

        verifier = dataclasses.replace(
            uploader,
            access_key_id="restore-key",
            secret_access_key="restore-secret",
            credential_mode=s3_backup.RESTORE_MODE,
        )
        fake.deny_object_reads = False
        result = s3_backup.verify_restore(verifier, fake, private_key)
        self.assertEqual(result["sqliteIntegrity"], "ok")
        self.assertEqual(result["sourceCommit"], "b" * 40)
        self.assertEqual(result["versionId"], "version-1")

    def test_s3_target_contract_requires_append_only_mode_and_immutable_retention(self) -> None:
        credential = Path(self.temp.name) / "s3-target.json"
        credential.write_text(
            json.dumps(
                {
                    "schema": s3_backup.TARGET_SCHEMA,
                    "endpointUrl": "https://objects.example.test",
                    "region": "test-1",
                    "bucket": "neal-backups",
                    "prefix": "issuer",
                    "accessKeyId": "access",
                    "secretAccessKey": "secret",
                    "sessionToken": None,
                    "retentionDays": 30,
                    "credentialMode": s3_backup.UPLOAD_MODE,
                    "addressingStyle": "path",
                }
            )
        )
        os.chmod(credential, 0o600)
        target = s3_backup.load_target(credential, s3_backup.UPLOAD_MODE)
        self.assertEqual(target.bucket, "neal-backups")
        with self.assertRaisesRegex(s3_backup.S3BackupError, "read-only-restore"):
            s3_backup.load_target(credential, s3_backup.RESTORE_MODE)
        unsafe = json.loads(credential.read_text())
        unsafe["endpointUrl"] = "https://objects.example.test/untrusted-path"
        credential.write_text(json.dumps(unsafe))
        os.chmod(credential, 0o600)
        with self.assertRaisesRegex(s3_backup.S3BackupError, "HTTPS origin"):
            s3_backup.load_target(credential, s3_backup.UPLOAD_MODE)

        class UnprotectedS3(FakeS3):
            def get_bucket_versioning(self, **_kwargs: object) -> dict[str, str]:
                return {"Status": "Suspended"}

        with self.assertRaisesRegex(s3_backup.S3BackupError, "versioning"):
            s3_backup.require_bucket_protection(UnprotectedS3(), target)

        readable = FakeS3()
        with self.assertRaisesRegex(s3_backup.S3BackupError, "listing is allowed"):
            s3_backup.require_append_only_listing_denied(readable, target)

    def test_backup_health_requires_fresh_upload_and_restore_receipts(self) -> None:
        now = dt.datetime(2026, 10, 2, 12, 0, tzinfo=dt.timezone.utc)
        upload = {
            "schema": s3_backup.RECEIPT_SCHEMA,
            "createdAt": "2026-10-02T00:00:01Z",
        }
        restore = {
            "schema": s3_backup.VERIFY_SCHEMA,
            "verifiedAt": "2026-09-02T12:00:00Z",
        }
        self.assertEqual(s3_backup.check_receipt_age(upload, "upload", now=now)["status"], "ok")
        self.assertEqual(s3_backup.check_receipt_age(restore, "restore", now=now)["status"], "ok")
        with self.assertRaisesRegex(s3_backup.S3BackupError, "upload receipt is stale"):
            s3_backup.check_receipt_age(
                {**upload, "createdAt": "2026-10-01T11:59:59Z"}, "upload", now=now
            )
        with self.assertRaisesRegex(s3_backup.S3BackupError, "schema is invalid"):
            s3_backup.check_receipt_age({**restore, "schema": "unexpected"}, "restore", now=now)

    def test_stable_error_registry_covers_explicit_issuer_codes(self) -> None:
        repository = Path(__file__).resolve().parents[2]
        registry = json.loads(
            (repository / "programs/access-stake/contracts/error-codes.v1.json").read_text()
        )
        self.assertEqual(registry["schema"], "neal.error-code-registry/v1")
        source = "\n".join(
            Path(__file__).with_name(name).read_text()
            for name in ("issuer.py", "reconcile.py")
        )
        explicit = set(re.findall(r'code="([a-z0-9_]+)"', source))
        self.assertFalse(explicit - set(registry["codes"]))
        defaults = {
            HTTPStatus.UNAUTHORIZED: "wallet_reverification_required",
            HTTPStatus.FORBIDDEN: "forbidden",
            HTTPStatus.CONFLICT: "conflict",
            HTTPStatus.UNPROCESSABLE_ENTITY: "stake_ineligible",
            HTTPStatus.SERVICE_UNAVAILABLE: "dependency_unavailable",
        }
        for status, code in defaults.items():
            error = issuer.IssuerError("safe", status)
            self.assertEqual(error.code, code)
            self.assertEqual(registry["codes"][code]["http"], int(status))
            self.assertEqual(registry["codes"][code]["retryable"], error.retryable)


if __name__ == "__main__":
    unittest.main()
