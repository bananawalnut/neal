#!/usr/bin/env python3
"""Fail-closed SIWS and finalized-stake to Matrix registration-token issuer."""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import hmac
import json
import os
import secrets
import socketserver
import sqlite3
import stat
import struct
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
CHAIN_GENESIS = {
    "solana:mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "solana:devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
}
CONFIG_DISCRIMINATOR = b"NEALACFG"
STAKE_DISCRIMINATOR = b"NEALSTAK"
PDA_MARKER = b"ProgramDerivedAddress"
COOKIE_NAME = "neal_access_session"
MAX_BODY = 32_768
MAX_DATABASE_BYTES = 128 * 1024 * 1024
B58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
B58_INDEX = {character: index for index, character in enumerate(B58_ALPHABET)}


class IssuerError(RuntimeError):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def base58_decode(value: str) -> bytes:
    if not value or len(value) > 64:
        raise IssuerError("Invalid Solana address")
    number = 0
    try:
        for character in value.encode("ascii"):
            number = number * 58 + B58_INDEX[character]
    except (KeyError, UnicodeEncodeError) as error:
        raise IssuerError("Invalid Solana address") from error
    raw = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    return b"\0" * (len(value) - len(value.lstrip("1"))) + raw


def base58_encode(value: bytes) -> str:
    number = int.from_bytes(value, "big")
    encoded = bytearray()
    while number:
        number, remainder = divmod(number, 58)
        encoded.append(B58_ALPHABET[remainder])
    encoded.reverse()
    return (b"1" * (len(value) - len(value.lstrip(b"\0"))) + encoded).decode()


def public_key(value: str) -> bytes:
    decoded = base58_decode(value)
    if len(decoded) != 32:
        raise IssuerError("Invalid Solana public key")
    return decoded


def base64url_decode(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as error:
        raise IssuerError("Invalid proof encoding") from error


def is_ed25519_point(compressed: bytes) -> bool:
    if len(compressed) != 32:
        return False
    prime = 2**255 - 19
    y = int.from_bytes(compressed, "little") & ((1 << 255) - 1)
    sign = compressed[31] >> 7
    if y >= prime:
        return False
    y_squared = y * y % prime
    d = (-121665 * pow(121666, prime - 2, prime)) % prime
    denominator = (d * y_squared + 1) % prime
    if denominator == 0:
        return False
    x_squared = ((y_squared - 1) * pow(denominator, prime - 2, prime)) % prime
    if x_squared == 0:
        return sign == 0
    return pow(x_squared, (prime - 1) // 2, prime) == 1


def create_program_address(seeds: list[bytes], program_id: bytes) -> bytes:
    if len(seeds) > 16 or any(len(seed) > 32 for seed in seeds):
        raise IssuerError("Invalid PDA seeds", HTTPStatus.INTERNAL_SERVER_ERROR)
    address = hashlib.sha256(b"".join(seeds) + program_id + PDA_MARKER).digest()
    if is_ed25519_point(address):
        raise IssuerError("Invalid PDA bump", HTTPStatus.INTERNAL_SERVER_ERROR)
    return address


def pda(seeds: list[bytes], program_id: bytes, bump: int | None = None) -> tuple[bytes, int]:
    bumps = [bump] if bump is not None else range(255, -1, -1)
    for candidate in bumps:
        try:
            return create_program_address([*seeds, bytes([candidate])], program_id), candidate
        except IssuerError as error:
            if str(error) != "Invalid PDA bump":
                raise
    raise IssuerError("No valid PDA bump", HTTPStatus.INTERNAL_SERVER_ERROR)


def iso_millis(epoch_seconds: float) -> str:
    milliseconds = int(epoch_seconds * 1000)
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(milliseconds / 1000)) + f".{milliseconds % 1000:03d}Z"


def siws_message(sign_in: dict[str, Any]) -> bytes:
    required = ("domain", "address", "uri", "version", "chainId", "nonce", "issuedAt")
    if any(not isinstance(sign_in.get(field), str) or not sign_in[field] for field in required):
        raise IssuerError("Incomplete SIWS input")
    lines = [
        f"{sign_in['domain']} wants you to sign in with your Solana account:",
        sign_in["address"],
    ]
    statement = sign_in.get("statement")
    if statement:
        lines.extend(("", statement))
    lines.extend(("", f"URI: {sign_in['uri']}", f"Version: {sign_in['version']}", f"Chain ID: {sign_in['chainId']}", f"Nonce: {sign_in['nonce']}", f"Issued At: {sign_in['issuedAt']}"))
    for key, label in (("expirationTime", "Expiration Time"), ("notBefore", "Not Before"), ("requestId", "Request ID")):
        if sign_in.get(key):
            lines.append(f"{label}: {sign_in[key]}")
    resources = sign_in.get("resources")
    if resources:
        lines.append("Resources:")
        lines.extend(f"- {resource}" for resource in resources)
    return "\n".join(lines).encode()


@dataclasses.dataclass(frozen=True)
class Settings:
    database: Path
    rpc_urls: tuple[str, ...]
    chain_id: str
    genesis_hash: str
    program_id: str
    program_data_address: str
    program_sha256: str
    config_address: str
    mint: str
    expected_revision: int
    expected_amount: int
    expected_lock_seconds: int
    issuer_keypair_file: Path
    public_origin: str
    matrix_url: str
    matrix_secret_file: Path
    bind: str = "127.0.0.1"
    port: int = 8792
    socket_path: Path | None = None
    challenge_ttl_seconds: int = 300
    session_ttl_seconds: int = 600
    token_ttl_minutes: int = 15

    @classmethod
    def from_environment(cls) -> "Settings":
        def required(name: str) -> str:
            value = os.environ.get(name, "").strip()
            if not value:
                raise IssuerError(f"Missing {name}", HTTPStatus.INTERNAL_SERVER_ERROR)
            return value

        socket_value = os.environ.get("NEAL_ACCESS_SOCKET", "").strip()
        settings = cls(
            database=Path(required("NEAL_ACCESS_DATABASE")),
            rpc_urls=tuple(part.strip() for part in required("NEAL_ACCESS_SOLANA_RPCS").split(",") if part.strip()),
            chain_id=required("NEAL_ACCESS_CHAIN_ID"),
            genesis_hash=required("NEAL_ACCESS_SOLANA_GENESIS_HASH"),
            program_id=required("NEAL_ACCESS_PROGRAM_ID"),
            program_data_address=required("NEAL_ACCESS_PROGRAM_DATA_ADDRESS"),
            program_sha256=required("NEAL_ACCESS_PROGRAM_SHA256").lower(),
            config_address=required("NEAL_ACCESS_CONFIG_ADDRESS"),
            mint=required("NEAL_ACCESS_MINT"),
            expected_revision=int(required("NEAL_ACCESS_EXPECTED_REVISION")),
            expected_amount=int(required("NEAL_ACCESS_EXPECTED_AMOUNT")),
            expected_lock_seconds=int(required("NEAL_ACCESS_EXPECTED_LOCK_SECONDS")),
            issuer_keypair_file=Path(required("NEAL_ACCESS_ISSUER_KEYPAIR_FILE")),
            public_origin=required("NEAL_ACCESS_PUBLIC_ORIGIN").rstrip("/"),
            matrix_url=os.environ.get("NEAL_ACCESS_MATRIX_URL", "http://127.0.0.1:8008").rstrip("/"),
            matrix_secret_file=Path(required("NEAL_ACCESS_MATRIX_SECRET_FILE")),
            bind=os.environ.get("NEAL_ACCESS_BIND", "127.0.0.1"),
            port=int(os.environ.get("NEAL_ACCESS_PORT", "8792")),
            socket_path=Path(socket_value) if socket_value else None,
        )
        for value in (settings.program_id, settings.program_data_address, settings.config_address, settings.mint):
            public_key(value)
        if settings.chain_id not in CHAIN_GENESIS or settings.genesis_hash != CHAIN_GENESIS[settings.chain_id]:
            raise IssuerError("Chain ID and genesis hash are not an approved pair", HTTPStatus.INTERNAL_SERVER_ERROR)
        if len(settings.program_sha256) != 64 or any(character not in "0123456789abcdef" for character in settings.program_sha256):
            raise IssuerError("NEAL_ACCESS_PROGRAM_SHA256 must be a lowercase SHA-256", HTTPStatus.INTERNAL_SERVER_ERROR)
        origin = urllib.parse.urlsplit(settings.public_origin)
        if origin.scheme != "https" or not origin.netloc or origin.path not in {"", "/"} or origin.query or origin.fragment:
            raise IssuerError("NEAL_ACCESS_PUBLIC_ORIGIN must be an HTTPS origin", HTTPStatus.INTERNAL_SERVER_ERROR)
        if len(settings.rpc_urls) < 2:
            raise IssuerError("At least two independent Solana RPCs are required", HTTPStatus.INTERNAL_SERVER_ERROR)
        for rpc_url in settings.rpc_urls:
            rpc = urllib.parse.urlsplit(rpc_url)
            if rpc.scheme != "https" or not rpc.netloc:
                raise IssuerError("NEAL_ACCESS_SOLANA_RPCS must use HTTPS", HTTPStatus.INTERNAL_SERVER_ERROR)
        matrix = urllib.parse.urlsplit(settings.matrix_url)
        if matrix.scheme != "http" or matrix.hostname not in {"127.0.0.1", "::1", "localhost"}:
            raise IssuerError("NEAL_ACCESS_MATRIX_URL must use loopback HTTP", HTTPStatus.INTERNAL_SERVER_ERROR)
        if (
            not settings.database.is_absolute()
            or not settings.issuer_keypair_file.is_absolute()
            or (settings.socket_path and not settings.socket_path.is_absolute())
        ):
            raise IssuerError("Database, keypair, and socket paths must be absolute", HTTPStatus.INTERNAL_SERVER_ERROR)
        if settings.socket_path is None and settings.bind not in {"127.0.0.1", "::1"}:
            raise IssuerError("Issuer must bind to loopback", HTTPStatus.INTERNAL_SERVER_ERROR)
        if not settings.matrix_secret_file.is_file() or not os.access(settings.matrix_secret_file, os.R_OK):
            raise IssuerError("Matrix registration secret is unavailable", HTTPStatus.INTERNAL_SERVER_ERROR)
        if not settings.issuer_keypair_file.is_file() or not os.access(settings.issuer_keypair_file, os.R_OK):
            raise IssuerError("Issuer keypair is unavailable", HTTPStatus.INTERNAL_SERVER_ERROR)
        if (
            settings.expected_revision < 0
            or settings.expected_amount <= 0
            or not 1 <= settings.expected_lock_seconds <= 365 * 24 * 60 * 60
        ):
            raise IssuerError("Approved stake terms are invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        if settings.token_ttl_minutes > 15:
            raise IssuerError("Registration token TTL exceeds 15 minutes", HTTPStatus.INTERNAL_SERVER_ERROR)
        return settings


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = path
        self.initialize()
        os.chmod(path, 0o600)

    def connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def initialize(self) -> None:
        with self.connection() as database:
            database.executescript(
                """
                CREATE TABLE IF NOT EXISTS challenges (
                  request_id TEXT PRIMARY KEY, address TEXT NOT NULL, message BLOB NOT NULL,
                  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS sessions (
                  token_hash TEXT PRIMARY KEY, address TEXT NOT NULL,
                  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS claims (
                  receipt TEXT PRIMARY KEY, address TEXT NOT NULL,
                  state TEXT NOT NULL CHECK (state IN ('pending','issued','failed')),
                  registration_token TEXT, expires_at_ms INTEGER,
                  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
                );
                CREATE TABLE IF NOT EXISTS rate_events (key TEXT NOT NULL, occurred_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS rate_events_lookup ON rate_events(key, occurred_at);
                CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges(expires_at, used_at);
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS admin_cleanups (
                  user_id TEXT PRIMARY KEY, registration_token TEXT,
                  created_at INTEGER NOT NULL, resolved_at INTEGER, error TEXT
                );
                """
            )
            columns = {
                row[1] for row in database.execute("PRAGMA table_info(claims)").fetchall()
            }
            if "chain_consumed_at" not in columns:
                database.execute("ALTER TABLE claims ADD COLUMN chain_consumed_at INTEGER")

    def enforce_storage_limit(self) -> None:
        total = sum(
            candidate.stat().st_size
            for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm"))
            if candidate.exists()
        )
        if total >= MAX_DATABASE_BYTES:
            raise IssuerError("Issuer storage limit reached", HTTPStatus.SERVICE_UNAVAILABLE)

    def prune_ephemeral(self, database: sqlite3.Connection, now: int) -> None:
        database.execute("DELETE FROM challenges WHERE expires_at < ? OR used_at IS NOT NULL", (now,))
        database.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))

    def rate_limit(self, key: str, limit: int, window_seconds: int) -> None:
        self.enforce_storage_limit()
        now = int(time.time())
        with self.connection() as database:
            self.prune_ephemeral(database, now)
            database.execute("DELETE FROM rate_events WHERE occurred_at < ?", (now - 86_400,))
            count = database.execute(
                "SELECT COUNT(*) FROM rate_events WHERE key = ? AND occurred_at >= ?",
                (key, now - window_seconds),
            ).fetchone()[0]
            if count >= limit:
                raise IssuerError("Too many requests; try again later", HTTPStatus.TOO_MANY_REQUESTS)
            database.execute("INSERT INTO rate_events VALUES (?, ?)", (key, now))

    def create_challenge(self, address: str, message_factory: Callable[[str, str, int, int], bytes], ttl: int) -> tuple[dict[str, Any], bytes]:
        self.enforce_storage_limit()
        now = int(time.time())
        expires = now + ttl
        nonce = secrets.token_hex(16)
        request_id = f"neal-{secrets.token_urlsafe(18)}"
        message = message_factory(nonce, request_id, now, expires)
        with self.connection() as database:
            database.execute(
                "INSERT INTO challenges VALUES (?, ?, ?, ?, ?, NULL)",
                (request_id, address, message, now, expires),
            )
        return {"nonce": nonce, "requestId": request_id, "issuedAt": now, "expiresAt": expires}, message

    def consume_challenge(self, request_id: str, address: str, signed_message: bytes) -> None:
        now = int(time.time())
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute(
                "SELECT * FROM challenges WHERE request_id = ?", (request_id,)
            ).fetchone()
            if not row or row["address"] != address or row["used_at"] is not None:
                raise IssuerError("Unknown or already-used wallet challenge", HTTPStatus.UNAUTHORIZED)
            if row["expires_at"] < now:
                raise IssuerError("Wallet challenge expired", HTTPStatus.UNAUTHORIZED)
            if not hmac.compare_digest(row["message"], signed_message):
                raise IssuerError("Signed message does not match the issued challenge", HTTPStatus.UNAUTHORIZED)
            database.execute(
                "UPDATE challenges SET used_at = ? WHERE request_id = ?", (now, request_id)
            )

    def create_session(self, address: str, ttl: int) -> str:
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())
        with self.connection() as database:
            database.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
            database.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?)", (digest, address, now, now + ttl)
            )
        return token

    def session_address(self, token: str) -> str:
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())
        with self.connection() as database:
            row = database.execute(
                "SELECT address FROM sessions WHERE token_hash = ? AND expires_at >= ?",
                (digest, now),
            ).fetchone()
        if not row:
            raise IssuerError("Wallet session is missing or expired", HTTPStatus.UNAUTHORIZED)
        return row["address"]

    def reserve_claim(self, receipt: str, address: str) -> str | None:
        now = int(time.time())
        now_ms = now * 1000
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute("SELECT * FROM claims WHERE receipt = ?", (receipt,)).fetchone()
            if row:
                if row["address"] != address:
                    raise IssuerError("Stake receipt belongs to another wallet", HTTPStatus.FORBIDDEN)
                if row["state"] == "issued" and row["expires_at_ms"] > now_ms:
                    return row["registration_token"]
                if row["state"] == "pending":
                    raise IssuerError("Token issuance is already pending", HTTPStatus.CONFLICT)
                raise IssuerError("This stake receipt has already been consumed", HTTPStatus.CONFLICT)
            database.execute(
                """INSERT INTO claims(
                     receipt, address, state, registration_token, expires_at_ms,
                     created_at, updated_at, error, chain_consumed_at
                   ) VALUES (?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL)""",
                (receipt, address, now, now),
            )
        return None

    def existing_claim(self, receipt: str, address: str) -> str | None:
        now_ms = int(time.time()) * 1000
        with self.connection() as database:
            row = database.execute("SELECT * FROM claims WHERE receipt = ?", (receipt,)).fetchone()
        if not row:
            return None
        if row["address"] != address:
            raise IssuerError("Stake receipt belongs to another wallet", HTTPStatus.FORBIDDEN)
        if row["state"] == "issued" and row["expires_at_ms"] > now_ms:
            return row["registration_token"]
        if row["state"] == "pending":
            raise IssuerError("Token issuance is already pending", HTTPStatus.CONFLICT)
        raise IssuerError("This stake receipt has already been consumed", HTTPStatus.CONFLICT)

    def mark_chain_consumed(self, receipt: str) -> None:
        with self.connection() as database:
            changed = database.execute(
                "UPDATE claims SET chain_consumed_at = ?, updated_at = ? WHERE receipt = ? AND state = 'pending' AND chain_consumed_at IS NULL",
                (int(time.time()), int(time.time()), receipt),
            ).rowcount
            if changed != 1:
                raise IssuerError("Claim consumption reservation was lost", HTTPStatus.INTERNAL_SERVER_ERROR)

    def add_admin_cleanup(self, user_id: str, registration_token: str | None, error: str) -> None:
        with self.connection() as database:
            database.execute(
                "INSERT OR REPLACE INTO admin_cleanups(user_id, registration_token, created_at, resolved_at, error) VALUES (?, ?, ?, NULL, ?)",
                (user_id, registration_token, int(time.time()), error[:500]),
            )

    def unresolved_admin_cleanups(self) -> int:
        with self.connection() as database:
            return database.execute(
                "SELECT COUNT(*) FROM admin_cleanups WHERE resolved_at IS NULL"
            ).fetchone()[0]

    def pending_admin_cleanups(self) -> list[dict[str, Any]]:
        with self.connection() as database:
            rows = database.execute(
                "SELECT user_id, created_at, error FROM admin_cleanups WHERE resolved_at IS NULL ORDER BY created_at"
            ).fetchall()
        return [dict(row) for row in rows]

    def admin_cleanup(self, user_id: str) -> sqlite3.Row:
        with self.connection() as database:
            row = database.execute(
                "SELECT * FROM admin_cleanups WHERE user_id = ? AND resolved_at IS NULL",
                (user_id,),
            ).fetchone()
        if not row:
            raise IssuerError("Unknown or already-resolved administrator cleanup", HTTPStatus.NOT_FOUND)
        return row

    def resolve_admin_cleanup(self, user_id: str) -> None:
        with self.connection() as database:
            changed = database.execute(
                "UPDATE admin_cleanups SET resolved_at = ?, error = NULL WHERE user_id = ? AND resolved_at IS NULL",
                (int(time.time()), user_id),
            ).rowcount
        if changed != 1:
            raise IssuerError("Administrator cleanup state changed", HTTPStatus.CONFLICT)

    def finish_claim(self, receipt: str, token: str, expires_at_ms: int) -> None:
        now = int(time.time())
        with self.connection() as database:
            changed = database.execute(
                "UPDATE claims SET state = 'issued', registration_token = ?, expires_at_ms = ?, updated_at = ? WHERE receipt = ? AND state = 'pending'",
                (token, expires_at_ms, now, receipt),
            ).rowcount
            if changed != 1:
                raise IssuerError("Claim reservation was lost", HTTPStatus.INTERNAL_SERVER_ERROR)

    def fail_claim(self, receipt: str, error: str) -> None:
        with self.connection() as database:
            database.execute(
                "UPDATE claims SET state = 'failed', error = ?, updated_at = ? WHERE receipt = ? AND state = 'pending'",
                (error[:500], int(time.time()), receipt),
            )


class SolanaVerifier:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.program = public_key(settings.program_id)
        self.program_data = public_key(settings.program_data_address)
        self.config_key = public_key(settings.config_address)
        self.mint = public_key(settings.mint)
        self.token_program = public_key(TOKEN_2022_PROGRAM)
        try:
            secret = json.loads(settings.issuer_keypair_file.read_text())
            if not isinstance(secret, list) or len(secret) != 64:
                raise ValueError("wrong keypair length")
            raw = bytes(secret)
        except (OSError, ValueError, TypeError) as error:
            raise IssuerError("Issuer keypair is invalid", HTTPStatus.INTERNAL_SERVER_ERROR) from error
        self.issuer_private = Ed25519PrivateKey.from_private_bytes(raw[:32])
        self.issuer_public = self.issuer_private.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        if not hmac.compare_digest(self.issuer_public, raw[32:]):
            raise IssuerError("Issuer keypair public key does not match its private seed", HTTPStatus.INTERNAL_SERVER_ERROR)

    def rpc_endpoint(self, url: str, method: str, params: list[Any]) -> Any:
        request = urllib.request.Request(
            url,
            data=json.dumps({"jsonrpc": "2.0", "id": secrets.token_hex(4), "method": method, "params": params}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.loads(response.read())
        except (OSError, json.JSONDecodeError) as error:
            raise IssuerError("Solana RPC is unavailable", HTTPStatus.SERVICE_UNAVAILABLE) from error
        if body.get("error") or "result" not in body:
            raise IssuerError("Solana RPC rejected the finalized proof", HTTPStatus.SERVICE_UNAVAILABLE)
        return body["result"]

    @staticmethod
    def comparable_result(result: Any) -> Any:
        if isinstance(result, dict) and "context" in result and "value" in result:
            return result["value"]
        return result

    def rpc(self, method: str, params: list[Any]) -> Any:
        results = [self.rpc_endpoint(url, method, params) for url in self.settings.rpc_urls]
        expected = json.dumps(self.comparable_result(results[0]), sort_keys=True, separators=(",", ":"))
        if any(
            json.dumps(self.comparable_result(result), sort_keys=True, separators=(",", ":")) != expected
            for result in results[1:]
        ):
            raise IssuerError("Independent Solana RPCs disagree", HTTPStatus.SERVICE_UNAVAILABLE)
        return results[0]

    def rpc_primary(self, method: str, params: list[Any]) -> Any:
        return self.rpc_endpoint(self.settings.rpc_urls[0], method, params)

    def account(self, address: str) -> tuple[str, bytes]:
        result = self.rpc("getAccountInfo", [address, {"encoding": "base64", "commitment": "finalized"}])
        value = result.get("value") if isinstance(result, dict) else None
        if not isinstance(value, dict):
            raise IssuerError("Required stake account does not exist", HTTPStatus.UNPROCESSABLE_ENTITY)
        data = value.get("data")
        if not isinstance(data, list) or not data or not isinstance(data[0], str):
            raise IssuerError("Stake account encoding is invalid", HTTPStatus.SERVICE_UNAVAILABLE)
        try:
            return value["owner"], base64.b64decode(data[0], validate=True)
        except (KeyError, ValueError) as error:
            raise IssuerError("Stake account encoding is invalid", HTTPStatus.SERVICE_UNAVAILABLE) from error

    def program_attestation(self) -> None:
        program_result = self.rpc("getAccountInfo", [self.settings.program_id, {"encoding": "base64", "commitment": "finalized"}])
        program_value = program_result.get("value") if isinstance(program_result, dict) else None
        if not isinstance(program_value, dict) or not program_value.get("executable"):
            raise IssuerError("Reviewed stake program is not executable", HTTPStatus.SERVICE_UNAVAILABLE)
        try:
            program_data = base64.b64decode(program_value["data"][0], validate=True)
        except (KeyError, ValueError, TypeError) as error:
            raise IssuerError("Stake program account is invalid", HTTPStatus.SERVICE_UNAVAILABLE) from error
        if (
            program_value.get("owner") != "BPFLoaderUpgradeab1e11111111111111111111111"
            or len(program_data) < 36
            or struct.unpack_from("<I", program_data, 0)[0] != 2
            or program_data[4:36] != self.program_data
        ):
            raise IssuerError("Stake program does not match reviewed ProgramData", HTTPStatus.SERVICE_UNAVAILABLE)
        owner, data = self.account(self.settings.program_data_address)
        if (
            owner != "BPFLoaderUpgradeab1e11111111111111111111111"
            or len(data) <= 45
            or struct.unpack_from("<I", data, 0)[0] != 3
            or data[12] != 0
            or hashlib.sha256(data[45:]).hexdigest() != self.settings.program_sha256
        ):
            raise IssuerError("Deployed program bytes or immutable authority do not match review", HTTPStatus.SERVICE_UNAVAILABLE)

    def config(self) -> dict[str, Any]:
        if self.rpc("getGenesisHash", []) != self.settings.genesis_hash:
            raise IssuerError("Solana RPC genesis does not match the approved cluster", HTTPStatus.SERVICE_UNAVAILABLE)
        self.program_attestation()
        config_owner, config_data = self.account(self.settings.config_address)
        if config_owner != self.settings.program_id:
            raise IssuerError("Configured stake config has the wrong owner", HTTPStatus.SERVICE_UNAVAILABLE)
        config = parse_config(config_data)
        if (
            config["mint"] != self.mint
            or config["token_program"] != self.token_program
            or config["required_amount"] <= 0
            or not 1 <= config["minimum_lock_seconds"] <= 365 * 24 * 60 * 60
            or config["required_amount"] != self.settings.expected_amount
            or config["minimum_lock_seconds"] != self.settings.expected_lock_seconds
            or config["revision"] != self.settings.expected_revision
            or config["issuer_authority"] != self.issuer_public
            or config["paused"]
        ):
            raise IssuerError("Access staking is unavailable", HTTPStatus.SERVICE_UNAVAILABLE)
        expected_config, _ = pda(
            [b"access-config", config["authority"], struct.pack("<Q", config["config_id"])],
            self.program,
            config["bump"],
        )
        if expected_config != self.config_key:
            raise IssuerError("Configured stake config PDA is invalid", HTTPStatus.SERVICE_UNAVAILABLE)
        return config

    def verify(self, address: str) -> str:
        wallet = public_key(address)
        self.config()

        receipt_key, _ = pda([b"access-stake", self.config_key, wallet], self.program)
        receipt_address = base58_encode(receipt_key)
        receipt_owner, receipt_data = self.account(receipt_address)
        if receipt_owner != self.settings.program_id:
            raise IssuerError("Stake receipt has the wrong owner", HTTPStatus.UNPROCESSABLE_ENTITY)
        receipt = parse_receipt(receipt_data)
        if (
            receipt["config"] != self.config_key
            or receipt["staker"] != wallet
            or receipt["status"] != 0
            or receipt["amount"] <= 0
            or receipt["claimed_at"] <= 0
            or receipt["issued_at"] != 0
            or receipt["released_at"] != 0
        ):
            raise IssuerError("Finalized stake receipt is not eligible", HTTPStatus.UNPROCESSABLE_ENTITY)
        expected_receipt, _ = pda([b"access-stake", self.config_key, wallet], self.program, receipt["bump"])
        if expected_receipt != receipt_key:
            raise IssuerError("Stake receipt PDA is invalid", HTTPStatus.UNPROCESSABLE_ENTITY)

        vault_address = base58_encode(receipt["vault"])
        vault_owner, vault = self.account(vault_address)
        if vault_owner != TOKEN_2022_PROGRAM or len(vault) < 165:
            raise IssuerError("Stake vault is invalid", HTTPStatus.UNPROCESSABLE_ENTITY)
        vault_amount = struct.unpack_from("<Q", vault, 64)[0]
        if vault[:32] != self.mint or vault[32:64] != receipt_key or vault[108] == 0 or vault_amount < receipt["amount"]:
            raise IssuerError("Finalized stake vault is not funded", HTTPStatus.UNPROCESSABLE_ENTITY)
        return receipt_address

    def receipt_address(self, address: str) -> str:
        wallet = public_key(address)
        receipt_key, _ = pda([b"access-stake", self.config_key, wallet], self.program)
        return base58_encode(receipt_key)

    @staticmethod
    def shortvec(value: int) -> bytes:
        encoded = bytearray()
        while True:
            element = value & 0x7F
            value >>= 7
            if value:
                element |= 0x80
            encoded.append(element)
            if not value:
                return bytes(encoded)

    def consume(self, address: str, receipt_address: str) -> str:
        expected = self.receipt_address(address)
        if receipt_address != expected:
            raise IssuerError("Stake receipt address changed", HTTPStatus.CONFLICT)
        latest = self.rpc_primary("getLatestBlockhash", [{"commitment": "finalized"}])
        blockhash = latest.get("value", {}).get("blockhash") if isinstance(latest, dict) else None
        if not isinstance(blockhash, str) or len(base58_decode(blockhash)) != 32:
            raise IssuerError("Solana RPC returned no usable blockhash", HTTPStatus.SERVICE_UNAVAILABLE)
        receipt_key = public_key(receipt_address)
        clock_key = public_key("SysvarC1ock11111111111111111111111111111111")
        keys = [self.issuer_public, receipt_key, self.config_key, clock_key, self.program]
        message = bytearray((1, 0, 3))
        message.extend(self.shortvec(len(keys)))
        for key in keys:
            message.extend(key)
        message.extend(base58_decode(blockhash))
        message.extend(self.shortvec(1))
        message.append(4)
        message.extend(self.shortvec(4))
        message.extend((0, 2, 1, 3))
        message.extend(self.shortvec(1))
        message.append(5)
        signature = self.issuer_private.sign(bytes(message))
        transaction = self.shortvec(1) + signature + bytes(message)
        tx_signature = self.rpc_primary(
            "sendTransaction",
            [
                base64.b64encode(transaction).decode(),
                {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "finalized", "maxRetries": 3},
            ],
        )
        if not isinstance(tx_signature, str):
            raise IssuerError("Solana RPC returned no transaction signature", HTTPStatus.SERVICE_UNAVAILABLE)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            result = self.rpc_primary("getSignatureStatuses", [[tx_signature], {"searchTransactionHistory": True}])
            values = result.get("value") if isinstance(result, dict) else None
            status = values[0] if isinstance(values, list) and values else None
            if isinstance(status, dict) and status.get("err") is not None:
                raise IssuerError("On-chain claim consumption failed", HTTPStatus.SERVICE_UNAVAILABLE)
            if isinstance(status, dict) and status.get("confirmationStatus") == "finalized":
                _, data = self.account(receipt_address)
                if parse_receipt(data)["issued_at"] > 0:
                    return tx_signature
            time.sleep(0.5)
        raise IssuerError("On-chain claim consumption did not finalize", HTTPStatus.SERVICE_UNAVAILABLE)


def parse_config(data: bytes) -> dict[str, Any]:
    if len(data) != 171 or data[:8] != CONFIG_DISCRIMINATOR or data[8] != 2:
        raise IssuerError("Stake config data is invalid", HTTPStatus.SERVICE_UNAVAILABLE)
    return {
        "authority": data[9:41],
        "issuer_authority": data[41:73],
        "config_id": struct.unpack_from("<Q", data, 73)[0],
        "mint": data[81:113],
        "token_program": data[113:145],
        "revision": struct.unpack_from("<Q", data, 145)[0],
        "required_amount": struct.unpack_from("<Q", data, 153)[0],
        "minimum_lock_seconds": struct.unpack_from("<q", data, 161)[0],
        "paused": bool(data[169]),
        "bump": data[170],
    }


def parse_receipt(data: bytes) -> dict[str, Any]:
    if len(data) != 163 or data[:8] != STAKE_DISCRIMINATOR or data[8] != 2:
        raise IssuerError("Stake receipt data is invalid", HTTPStatus.UNPROCESSABLE_ENTITY)
    return {
        "config": data[9:41],
        "staker": data[41:73],
        "vault": data[73:105],
        "amount": struct.unpack_from("<Q", data, 105)[0],
        "config_revision": struct.unpack_from("<Q", data, 113)[0],
        "staked_at": struct.unpack_from("<q", data, 121)[0],
        "unlock_at": struct.unpack_from("<q", data, 129)[0],
        "claimed_at": struct.unpack_from("<q", data, 137)[0],
        "issued_at": struct.unpack_from("<q", data, 145)[0],
        "released_at": struct.unpack_from("<q", data, 153)[0],
        "status": data[161],
        "bump": data[162],
    }


class MatrixIssuer:
    def __init__(self, settings: Settings, store: Store | None = None):
        self.settings = settings
        self.store = store

    def request_json(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        token: str | None = None,
        allow_not_found: bool = False,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body).encode()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(self.settings.matrix_url + path, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            if allow_not_found and error.code == HTTPStatus.NOT_FOUND:
                return {}
            raise IssuerError("Matrix token service rejected the request", HTTPStatus.SERVICE_UNAVAILABLE) from error
        except (OSError, json.JSONDecodeError) as error:
            raise IssuerError("Matrix token service is unavailable", HTTPStatus.SERVICE_UNAVAILABLE) from error

    def temporary_admin(self) -> tuple[str, str]:
        shared = self.settings.matrix_secret_file.read_text().strip().encode()
        nonce = self.request_json("GET", "/_synapse/admin/v1/register")["nonce"]
        username = f"neal_access_issuer_{secrets.token_hex(8)}"
        password = secrets.token_urlsafe(48)
        mac_input = b"\x00".join((nonce.encode(), username.encode(), password.encode(), b"admin"))
        mac = hmac.new(shared, mac_input, hashlib.sha1).hexdigest()
        result = self.request_json(
            "POST",
            "/_synapse/admin/v1/register",
            body={"nonce": nonce, "username": username, "password": password, "admin": True, "mac": mac},
        )
        return result["user_id"], result["access_token"]

    def ready(self) -> None:
        if self.store and self.store.unresolved_admin_cleanups():
            raise IssuerError("Temporary administrator cleanup is required", HTTPStatus.SERVICE_UNAVAILABLE)
        if not self.settings.matrix_secret_file.read_text().strip():
            raise IssuerError("Matrix registration secret is empty", HTTPStatus.SERVICE_UNAVAILABLE)
        versions = self.request_json("GET", "/_matrix/client/versions")
        if not isinstance(versions.get("versions"), list):
            raise IssuerError("Matrix client API readiness check failed", HTTPStatus.SERVICE_UNAVAILABLE)

    def deactivate(self, user_id: str, token: str) -> None:
        self.request_json(
            "POST",
            f"/_synapse/admin/v1/deactivate/{urllib.parse.quote(user_id, safe='')}",
            token=token,
            body={"erase": True},
        )

    def reconcile_admin_cleanup(self, user_id: str) -> None:
        if not self.store:
            raise IssuerError("Reconciliation requires the issuer store", HTTPStatus.INTERNAL_SERVER_ERROR)
        cleanup = self.store.admin_cleanup(user_id)
        reconciler_id = ""
        reconciler_token = ""
        try:
            reconciler_id, reconciler_token = self.temporary_admin()
            registration_token = cleanup["registration_token"]
            if registration_token:
                self.request_json(
                    "DELETE",
                    f"/_synapse/admin/v1/registration_tokens/{urllib.parse.quote(registration_token, safe='')}",
                    token=reconciler_token,
                    allow_not_found=True,
                )
            self.deactivate(user_id, reconciler_token)
            self.store.resolve_admin_cleanup(user_id)
        finally:
            if reconciler_id and reconciler_token:
                try:
                    self.deactivate(reconciler_id, reconciler_token)
                except Exception as error:
                    self.store.add_admin_cleanup(reconciler_id, None, str(error))
                    raise IssuerError(
                        "Reconciliation administrator cleanup failed; issuance remains halted",
                        HTTPStatus.SERVICE_UNAVAILABLE,
                    ) from error

    def issue(self) -> tuple[str, int]:
        if self.store and self.store.unresolved_admin_cleanups():
            raise IssuerError("Issuance is halted pending administrator cleanup", HTTPStatus.SERVICE_UNAVAILABLE)
        admin_id = ""
        admin_token = ""
        registration_token = ""
        try:
            admin_id, admin_token = self.temporary_admin()
            expires_at_ms = int(time.time() * 1000) + self.settings.token_ttl_minutes * 60 * 1000
            result = self.request_json(
                "POST",
                "/_synapse/admin/v1/registration_tokens/new",
                token=admin_token,
                body={"uses_allowed": 1, "expiry_time": expires_at_ms},
            )
            token = result.get("token")
            if not isinstance(token, str) or not token:
                raise IssuerError("Synapse returned no registration token", HTTPStatus.SERVICE_UNAVAILABLE)
            registration_token = token
            return token, expires_at_ms
        finally:
            if admin_id and admin_token:
                try:
                    self.deactivate(admin_id, admin_token)
                except Exception as error:  # cleanup failure must be visible to operators
                    if self.store:
                        self.store.add_admin_cleanup(admin_id, registration_token or None, str(error))
                    print(f"temporary admin cleanup failed: {error}", file=sys.stderr)
                    raise IssuerError(
                        "Temporary administrator cleanup failed; issuance is halted for reconciliation",
                        HTTPStatus.SERVICE_UNAVAILABLE,
                    ) from error


class Application:
    def __init__(self, settings: Settings, matrix: MatrixIssuer | None = None, solana: SolanaVerifier | None = None):
        self.settings = settings
        self.store = Store(settings.database)
        self.matrix = matrix or MatrixIssuer(settings, self.store)
        self.solana = solana or SolanaVerifier(settings)

    def ready(self) -> dict[str, Any]:
        with self.store.connection() as database:
            database.execute("SELECT 1").fetchone()
        config = self.solana.config()
        self.matrix.ready()
        return {
            "status": "ready",
            "requiredAtomicAmount": str(config["required_amount"]),
            "minimumLockSeconds": config["minimum_lock_seconds"],
            "configRevision": str(config["revision"]),
        }

    def sign_in_input(self, address: str, nonce: str, request_id: str, issued: int, expires: int) -> dict[str, Any]:
        origin = urllib.parse.urlsplit(self.settings.public_origin)
        return {
            "domain": origin.netloc,
            "address": address,
            "statement": "Sign in to request a NEAL Matrix access token.",
            "uri": self.settings.public_origin,
            "version": "1",
            "chainId": self.settings.chain_id,
            "nonce": nonce,
            "issuedAt": iso_millis(issued),
            "expirationTime": iso_millis(expires),
            "requestId": request_id,
            "resources": [f"{self.settings.public_origin}/wallet-policy.json"],
        }

    def challenge(self, body: dict[str, Any], client_key: str) -> dict[str, Any]:
        address = body.get("address")
        if body.get("schema") != "neal.wallet-challenge-request/v1" or body.get("chain") != self.settings.chain_id or not isinstance(address, str):
            raise IssuerError("Invalid wallet challenge request")
        public_key(address)
        self.store.rate_limit(f"challenge:{client_key}:{address}", 10, 3600)
        self.store.rate_limit(f"challenge-ip:{client_key}", 60, 3600)
        self.store.rate_limit("challenge-global", 1_000, 60)
        result: dict[str, Any] = {}

        def factory(nonce: str, request_id: str, issued: int, expires: int) -> bytes:
            nonlocal result
            result = self.sign_in_input(address, nonce, request_id, issued, expires)
            return siws_message(result)

        self.store.create_challenge(address, factory, self.settings.challenge_ttl_seconds)
        return {"schema": "neal.wallet-challenge/v1", "signInInput": result}

    def verify(self, body: dict[str, Any], client_key: str) -> tuple[dict[str, Any], str]:
        if body.get("schema") != "neal.wallet-verification/v1":
            raise IssuerError("Invalid wallet verification")
        sign_in = body.get("signInInput")
        output = body.get("output")
        if not isinstance(sign_in, dict) or not isinstance(output, dict):
            raise IssuerError("Invalid wallet proof")
        account = output.get("account")
        if not isinstance(account, dict):
            raise IssuerError("Invalid wallet account proof")
        address = account.get("address")
        request_id = sign_in.get("requestId")
        if not isinstance(address, str) or not isinstance(request_id, str):
            raise IssuerError("Invalid wallet proof")
        self.store.rate_limit(f"verify:{client_key}", 20, 600)
        key = public_key(address)
        if base64url_decode(account.get("publicKey", "")) != key:
            raise IssuerError("Wallet public key does not match its address", HTTPStatus.UNAUTHORIZED)
        message = base64url_decode(output.get("signedMessage", ""))
        signature = base64url_decode(output.get("signature", ""))
        if output.get("signatureType", "ed25519") != "ed25519" or len(signature) != 64:
            raise IssuerError("Unsupported wallet signature", HTTPStatus.UNAUTHORIZED)
        try:
            Ed25519PublicKey.from_public_bytes(key).verify(signature, message)
        except (InvalidSignature, ValueError) as error:
            raise IssuerError("Wallet signature is invalid", HTTPStatus.UNAUTHORIZED) from error
        self.store.consume_challenge(request_id, address, message)
        session = self.store.create_session(address, self.settings.session_ttl_seconds)
        return {
            "schema": "neal.wallet-authentication/v1",
            "authenticated": True,
            "address": address,
            "sessionExpiresAt": (int(time.time()) + self.settings.session_ttl_seconds) * 1000,
        }, session

    def access_token(self, session: str, client_key: str) -> dict[str, Any]:
        address = self.store.session_address(session)
        self.store.rate_limit(f"token:{client_key}:{address}", 5, 3600)
        receipt = self.solana.receipt_address(address)
        existing = self.store.existing_claim(receipt, address)
        if existing:
            with self.store.connection() as database:
                row = database.execute("SELECT expires_at_ms FROM claims WHERE receipt = ?", (receipt,)).fetchone()
            return {"schema": "neal.matrix-access-token/v1", "token": existing, "expiresAt": row["expires_at_ms"], "receipt": receipt}
        verified_receipt = self.solana.verify(address)
        if verified_receipt != receipt:
            raise IssuerError("Stake receipt verification changed", HTTPStatus.CONFLICT)
        existing = self.store.reserve_claim(receipt, address)
        if existing:
            raise IssuerError("Unexpected duplicate claim state", HTTPStatus.CONFLICT)
        try:
            self.solana.consume(address, receipt)
            self.store.mark_chain_consumed(receipt)
            token, expires_at_ms = self.matrix.issue()
            self.store.finish_claim(receipt, token, expires_at_ms)
        except Exception as error:
            self.store.fail_claim(receipt, str(error))
            raise IssuerError(
                "Token issuance was reserved but did not complete; an administrator must reconcile it before retrying",
                HTTPStatus.SERVICE_UNAVAILABLE,
            ) from error
        return {"schema": "neal.matrix-access-token/v1", "token": token, "expiresAt": expires_at_ms, "receipt": receipt}


class Handler(BaseHTTPRequestHandler):
    app: Application

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.log_date_time_string()} {self.peer_address()} {format % args}", file=sys.stderr)

    def peer_address(self) -> str:
        if isinstance(self.client_address, tuple) and self.client_address:
            return str(self.client_address[0])[:128]
        return "local"

    def client_key(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
        value = forwarded or self.peer_address()
        return value[:128]

    def origin_allowed(self) -> bool:
        return self.headers.get("Origin") == self.app.settings.public_origin

    def send_json(self, status: int, body: dict[str, Any], *, session: str | None = None) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", self.app.settings.public_origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Vary", "Origin")
        if session:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}={session}; Max-Age={self.app.settings.session_ttl_seconds}; Path=/v1/; Secure; HttpOnly; SameSite=Strict",
            )
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise IssuerError("Invalid request size") from error
        if length <= 0 or length > MAX_BODY:
            raise IssuerError("Invalid request size", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        try:
            body = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise IssuerError("Invalid JSON body") from error
        if not isinstance(body, dict):
            raise IssuerError("JSON body must be an object")
        return body

    def cookie(self) -> str:
        parsed = SimpleCookie(self.headers.get("Cookie", ""))
        value = parsed.get(COOKIE_NAME)
        if not value:
            raise IssuerError("Wallet session is missing", HTTPStatus.UNAUTHORIZED)
        return value.value

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self.origin_allowed() or self.path not in {"/v1/challenge", "/v1/verify", "/v1/access-token"}:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", self.app.settings.public_origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.send_json(HTTPStatus.OK, {"status": "ok"})
        elif self.path == "/readyz":
            try:
                self.send_json(HTTPStatus.OK, self.app.ready())
            except IssuerError as error:
                self.send_json(error.status, {"status": "unavailable", "error": str(error)})
            except Exception as error:
                print(f"issuer readiness failed: {type(error).__name__}", file=sys.stderr)
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"status": "unavailable"})
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self.origin_allowed():
                raise IssuerError("Origin is not allowed", HTTPStatus.FORBIDDEN)
            body = self.read_json()
            session = None
            if self.path == "/v1/challenge":
                result = self.app.challenge(body, self.client_key())
            elif self.path == "/v1/verify":
                result, session = self.app.verify(body, self.client_key())
            elif self.path == "/v1/access-token":
                if body.get("schema") != "neal.matrix-access-token-request/v1":
                    raise IssuerError("Invalid access-token request")
                result = self.app.access_token(self.cookie(), self.client_key())
            else:
                raise IssuerError("Route not found", HTTPStatus.NOT_FOUND)
            self.send_json(HTTPStatus.OK, result, session=session)
        except IssuerError as error:
            self.send_json(error.status, {"error": str(error)})
        except Exception:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "Internal issuer error"})
            raise


class BoundedThreadingMixIn(socketserver.ThreadingMixIn):
    daemon_threads = True
    worker_slots = threading.BoundedSemaphore(32)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.worker_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.worker_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.worker_slots.release()


class BoundedThreadingHTTPServer(BoundedThreadingMixIn, HTTPServer):
    allow_reuse_address = True


class ThreadingUnixHTTPServer(BoundedThreadingMixIn, socketserver.UnixStreamServer):
    pass


def unix_server(settings: Settings) -> ThreadingUnixHTTPServer:
    assert settings.socket_path is not None
    path = settings.socket_path
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        mode = path.lstat().st_mode
        if not stat.S_ISSOCK(mode):
            raise IssuerError("Refusing to replace a non-socket issuer path", HTTPStatus.INTERNAL_SERVER_ERROR)
        path.unlink()
    server = ThreadingUnixHTTPServer(str(path), Handler)
    os.chmod(path, 0o660)
    return server


def main() -> int:
    settings = Settings.from_environment()
    Handler.app = Application(settings)
    server: BoundedThreadingHTTPServer | ThreadingUnixHTTPServer
    if settings.socket_path:
        server = unix_server(settings)
        location = str(settings.socket_path)
    else:
        server = BoundedThreadingHTTPServer((settings.bind, settings.port), Handler)
        location = f"{settings.bind}:{settings.port}"
    print(f"NEAL access issuer listening on {location}", file=sys.stderr)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        if settings.socket_path and settings.socket_path.exists() and stat.S_ISSOCK(settings.socket_path.lstat().st_mode):
            settings.socket_path.unlink()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (IssuerError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
