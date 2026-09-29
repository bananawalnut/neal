from __future__ import annotations

import base64
import dataclasses
import struct
import tempfile
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import issuer


class FakeSolana:
    def __init__(self, receipt: str):
        self.receipt = receipt

    def verify(self, _address: str) -> str:
        return self.receipt


class FakeMatrix:
    def __init__(self):
        self.calls = 0

    def issue(self) -> tuple[str, int]:
        self.calls += 1
        return "one-use-token", int(time.time() * 1000) + 900_000


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
