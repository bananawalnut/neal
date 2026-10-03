#!/usr/bin/env python3
"""Fail-closed SIWS and finalized-stake to Matrix registration-token issuer."""

from __future__ import annotations

import base64
import concurrent.futures
import collections
import contextlib
import dataclasses
import hashlib
import hmac
import json
import os
import ipaddress
import re
import secrets
import shutil
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
from typing import Any, Callable, Iterator

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
CHAIN_GENESIS = {
    "solana:mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "solana:devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
}
CONFIG_DISCRIMINATOR = b"NEALACFG"
STAKE_DISCRIMINATOR = b"NEALSTAK"
PDA_MARKER = b"ProgramDerivedAddress"
COOKIE_NAME = "neal_access_session"
MAX_BODY = 32_768
MAX_DATABASE_BYTES = 128 * 1024 * 1024
MAX_RPC_RESPONSE_BYTES = 1024 * 1024
RPC_TIMEOUT_SECONDS = 5
RPC_SET_SCHEMA = "neal.solana-rpc-set/v1"
RPC_PREVIEW_MODE = "single-rpc-devnet-preview"
RPC_QUORUM_MODE = "quorum-2-of-3"
MAX_CHALLENGES = 10_000
MAX_SESSIONS = 10_000
MAX_RATE_KEYS = 50_000
CLAIM_PHASES = (
    "RESERVED",
    "CHAIN_SUBMITTED",
    "CHAIN_CONSUMED",
    "MATRIX_TOKEN_ENSURING",
    "ADMIN_CLEANUP_PENDING",
    "TOKEN_READY",
    "REGISTRATION_IN_PROGRESS",
    "REGISTRATION_COMPLETED",
)
TERMINAL_CLAIM_PHASES = {"LEGACY_REVIEW", "CANCELLED_BEFORE_CONSUMPTION"}
B58_ALPHABET = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
B58_INDEX = {character: index for index, character in enumerate(B58_ALPHABET)}


class IssuerError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: int = HTTPStatus.BAD_REQUEST,
        *,
        code: str | None = None,
        retryable: bool | None = None,
        operation_id: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        defaults = {
            HTTPStatus.BAD_REQUEST: ("invalid_request", False),
            HTTPStatus.UNAUTHORIZED: ("wallet_reverification_required", False),
            HTTPStatus.FORBIDDEN: ("forbidden", False),
            HTTPStatus.NOT_FOUND: ("not_found", False),
            HTTPStatus.CONFLICT: ("conflict", False),
            HTTPStatus.REQUEST_ENTITY_TOO_LARGE: ("request_too_large", False),
            HTTPStatus.UNPROCESSABLE_ENTITY: ("stake_ineligible", False),
            HTTPStatus.TOO_MANY_REQUESTS: ("rate_limited", True),
            HTTPStatus.BAD_GATEWAY: ("dependency_unavailable", True),
            HTTPStatus.SERVICE_UNAVAILABLE: ("dependency_unavailable", True),
            HTTPStatus.INTERNAL_SERVER_ERROR: ("internal_error", False),
        }
        default_code, default_retryable = defaults.get(status, ("internal_error", False))
        self.code = code or default_code
        self.retryable = default_retryable if retryable is None and code is None else bool(retryable)
        self.operation_id = operation_id


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
class RpcEndpoint:
    id: str
    trust_domain: str
    url: str
    host: str


@dataclasses.dataclass(frozen=True)
class RpcSet:
    mode: str
    threshold: int
    endpoints: tuple[RpcEndpoint, ...]

    @classmethod
    def load(cls, path: Path, chain_id: str) -> "RpcSet":
        try:
            metadata = path.lstat()
            if path.is_symlink() or not path.is_file() or metadata.st_size > 64 * 1024:
                raise ValueError("unsafe credential")
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            raise IssuerError("Solana RPC set credential is unavailable or invalid", HTTPStatus.INTERNAL_SERVER_ERROR) from error
        if not isinstance(value, dict) or set(value) != {"schema", "mode", "threshold", "endpoints"}:
            raise IssuerError("Solana RPC set contract is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        if value.get("schema") != RPC_SET_SCHEMA or not isinstance(value.get("endpoints"), list):
            raise IssuerError("Solana RPC set contract is unsupported", HTTPStatus.INTERNAL_SERVER_ERROR)
        endpoints: list[RpcEndpoint] = []
        for item in value["endpoints"]:
            if not isinstance(item, dict) or set(item) != {"id", "trustDomain", "url"}:
                raise IssuerError("Solana RPC endpoint contract is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
            endpoint_id = item.get("id")
            trust_domain = item.get("trustDomain")
            url = item.get("url")
            if (
                not isinstance(endpoint_id, str)
                or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", endpoint_id)
                or not isinstance(trust_domain, str)
                or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,126}", trust_domain)
                or not isinstance(url, str)
                or len(url) > 4096
            ):
                raise IssuerError("Solana RPC endpoint fields are invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
            parsed = urllib.parse.urlsplit(url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.fragment
            ):
                raise IssuerError("Solana RPC endpoints must be credential-safe HTTPS URLs", HTTPStatus.INTERNAL_SERVER_ERROR)
            host = parsed.hostname.rstrip(".").lower().encode("idna").decode("ascii")
            try:
                ipaddress.ip_address(host)
            except ValueError:
                if "." not in host:
                    raise IssuerError("Solana RPC endpoint host is not globally qualified", HTTPStatus.INTERNAL_SERVER_ERROR)
            endpoints.append(RpcEndpoint(endpoint_id, trust_domain, url, host))
        mode = value.get("mode")
        threshold = value.get("threshold")
        if mode == RPC_PREVIEW_MODE:
            if chain_id != "solana:devnet" or threshold != 1 or len(endpoints) != 1:
                raise IssuerError("Single-RPC mode is permitted only for one-provider devnet preview", HTTPStatus.INTERNAL_SERVER_ERROR)
        elif mode == RPC_QUORUM_MODE:
            if threshold != 2 or len(endpoints) != 3:
                raise IssuerError("Quorum mode requires exactly three providers and threshold two", HTTPStatus.INTERNAL_SERVER_ERROR)
            if len({endpoint.id for endpoint in endpoints}) != 3:
                raise IssuerError("Solana RPC provider IDs must be distinct", HTTPStatus.INTERNAL_SERVER_ERROR)
            if len({endpoint.host for endpoint in endpoints}) != 3:
                raise IssuerError("Solana RPC provider hosts must be distinct", HTTPStatus.INTERNAL_SERVER_ERROR)
            if len({endpoint.trust_domain for endpoint in endpoints}) != 3:
                raise IssuerError("Solana RPC trust domains must be distinct", HTTPStatus.INTERNAL_SERVER_ERROR)
        else:
            raise IssuerError("Solana RPC verification mode is unsupported", HTTPStatus.INTERNAL_SERVER_ERROR)
        return cls(mode=mode, threshold=threshold, endpoints=tuple(endpoints))


class EphemeralState:
    """Thread-safe, restart-discardable, bounded TTL/LRU state."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.challenges: collections.OrderedDict[str, dict[str, Any]] = collections.OrderedDict()
        self.sessions: collections.OrderedDict[str, dict[str, Any]] = collections.OrderedDict()
        self.rates: collections.OrderedDict[str, collections.deque[int]] = collections.OrderedDict()

    @staticmethod
    def _trim(mapping: collections.OrderedDict[str, Any], maximum: int) -> None:
        while len(mapping) >= maximum:
            mapping.popitem(last=False)

    def prune(self, now: int) -> None:
        for key in [
            key for key, value in self.challenges.items()
            if value["expires_at"] < now or value["used_at"] is not None
        ]:
            self.challenges.pop(key, None)
        for key in [key for key, value in self.sessions.items() if value["expires_at"] < now]:
            self.sessions.pop(key, None)
        for key in list(self.rates):
            values = self.rates[key]
            while values and values[0] < now - 86_400:
                values.popleft()
            if not values:
                self.rates.pop(key, None)

    def rate_limit(self, key: str, limit: int, window_seconds: int) -> None:
        now = int(time.time())
        with self.lock:
            self.prune(now)
            values = self.rates.get(key)
            if values is None:
                self._trim(self.rates, MAX_RATE_KEYS)
                values = collections.deque()
                self.rates[key] = values
            else:
                self.rates.move_to_end(key)
            cutoff = now - window_seconds
            while values and values[0] < cutoff:
                values.popleft()
            if len(values) >= limit:
                raise IssuerError(
                    "Too many requests; try again later",
                    HTTPStatus.TOO_MANY_REQUESTS,
                    code="rate_limited",
                    retryable=True,
                )
            values.append(now)

    def occupancy(self) -> dict[str, int]:
        with self.lock:
            self.prune(int(time.time()))
            return {
                "challenges": len(self.challenges),
                "sessions": len(self.sessions),
                "rateKeys": len(self.rates),
            }

    def create_challenge(self, request_id: str, address: str, message: bytes, expires_at: int) -> None:
        with self.lock:
            self.prune(int(time.time()))
            self._trim(self.challenges, MAX_CHALLENGES)
            self.challenges[request_id] = {
                "address": address,
                "message": message,
                "expires_at": expires_at,
                "used_at": None,
            }

    def consume_challenge(self, request_id: str, address: str, signed_message: bytes) -> None:
        now = int(time.time())
        with self.lock:
            row = self.challenges.get(request_id)
            if not row or row["address"] != address or row["used_at"] is not None:
                raise IssuerError("Unknown or already-used wallet challenge", HTTPStatus.UNAUTHORIZED)
            if row["expires_at"] < now:
                self.challenges.pop(request_id, None)
                raise IssuerError("Wallet challenge expired", HTTPStatus.UNAUTHORIZED)
            if not hmac.compare_digest(row["message"], signed_message):
                raise IssuerError("Signed message does not match the issued challenge", HTTPStatus.UNAUTHORIZED)
            row["used_at"] = now
            self.challenges.move_to_end(request_id)

    def create_session(self, address: str, ttl: int) -> str:
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())
        with self.lock:
            self.prune(now)
            self._trim(self.sessions, MAX_SESSIONS)
            self.sessions[digest] = {"address": address, "expires_at": now + ttl}
        return token

    def session_address(self, token: str) -> str:
        digest = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time())
        with self.lock:
            self.prune(now)
            row = self.sessions.get(digest)
            if not row:
                raise IssuerError("Wallet session is missing or expired", HTTPStatus.UNAUTHORIZED)
            self.sessions.move_to_end(digest)
            return str(row["address"])


@dataclasses.dataclass(frozen=True)
class Settings:
    database: Path
    rpc_set: RpcSet
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
    recovery_key_file: Path
    recovery_key_version: int
    matrix_server_name: str
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
        chain_id = required("NEAL_ACCESS_CHAIN_ID")
        settings = cls(
            database=Path(required("NEAL_ACCESS_DATABASE")),
            rpc_set=RpcSet.load(Path(required("NEAL_ACCESS_SOLANA_RPC_SET_FILE")), chain_id),
            chain_id=chain_id,
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
            recovery_key_file=Path(required("NEAL_ACCESS_RECOVERY_KEY_FILE")),
            recovery_key_version=int(required("NEAL_ACCESS_RECOVERY_KEY_VERSION")),
            matrix_server_name=required("NEAL_ACCESS_MATRIX_SERVER_NAME").lower(),
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
        if settings.chain_id == "solana:mainnet" and settings.rpc_set.mode != RPC_QUORUM_MODE:
            raise IssuerError("Mainnet requires strict 2-of-3 RPC quorum", HTTPStatus.INTERNAL_SERVER_ERROR)
        matrix = urllib.parse.urlsplit(settings.matrix_url)
        if matrix.scheme != "http" or matrix.hostname not in {"127.0.0.1", "::1", "localhost"}:
            raise IssuerError("NEAL_ACCESS_MATRIX_URL must use loopback HTTP", HTTPStatus.INTERNAL_SERVER_ERROR)
        if (
            not settings.database.is_absolute()
            or not settings.issuer_keypair_file.is_absolute()
            or not settings.recovery_key_file.is_absolute()
            or (settings.socket_path and not settings.socket_path.is_absolute())
        ):
            raise IssuerError("Database, keypair, and socket paths must be absolute", HTTPStatus.INTERNAL_SERVER_ERROR)
        if settings.socket_path is None and settings.bind not in {"127.0.0.1", "::1"}:
            raise IssuerError("Issuer must bind to loopback", HTTPStatus.INTERNAL_SERVER_ERROR)
        if not settings.matrix_secret_file.is_file() or not os.access(settings.matrix_secret_file, os.R_OK):
            raise IssuerError("Matrix registration secret is unavailable", HTTPStatus.INTERNAL_SERVER_ERROR)
        if not settings.issuer_keypair_file.is_file() or not os.access(settings.issuer_keypair_file, os.R_OK):
            raise IssuerError("Issuer keypair is unavailable", HTTPStatus.INTERNAL_SERVER_ERROR)
        try:
            recovery_key = settings.recovery_key_file.read_bytes()
        except OSError as error:
            raise IssuerError("Issuance recovery key is unavailable", HTTPStatus.INTERNAL_SERVER_ERROR) from error
        if len(recovery_key) != 32 or settings.recovery_key_version < 1:
            raise IssuerError("Issuance recovery credential is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        if not re.fullmatch(r"[a-z0-9.-]{1,255}", settings.matrix_server_name):
            raise IssuerError("Matrix server name is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
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
        self.ephemeral = EphemeralState()
        self.initialize()
        os.chmod(path, 0o600)

    @contextlib.contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connection() as database:
            tables = {
                row[0] for row in database.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            if "claims" in tables and "legacy_claim_rows" not in tables:
                database.execute("ALTER TABLE claims RENAME TO legacy_claim_rows")
            database.executescript(
                """
                CREATE TABLE IF NOT EXISTS claim_operations (
                  receipt TEXT PRIMARY KEY,
                  operation_id TEXT NOT NULL UNIQUE,
                  address TEXT NOT NULL,
                  config_address TEXT,
                  config_revision INTEGER,
                  phase TEXT NOT NULL,
                  attention_required INTEGER NOT NULL DEFAULT 0 CHECK (attention_required IN (0, 1)),
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
                CREATE TABLE IF NOT EXISTS claim_events (
                  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                  operation_id TEXT NOT NULL,
                  previous_phase TEXT,
                  next_phase TEXT NOT NULL,
                  event_type TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  metadata_json TEXT NOT NULL,
                  previous_hash TEXT,
                  event_hash TEXT NOT NULL UNIQUE,
                  FOREIGN KEY(operation_id) REFERENCES claim_operations(operation_id)
                );
                CREATE INDEX IF NOT EXISTS claim_phase_age ON claim_operations(phase, updated_at);
                CREATE TABLE IF NOT EXISTS admin_cleanups (
                  user_id TEXT PRIMARY KEY, registration_token TEXT,
                  created_at INTEGER NOT NULL, resolved_at INTEGER, error TEXT
                );
                CREATE TABLE IF NOT EXISTS admin_operations (
                  operation_id TEXT PRIMARY KEY,
                  username TEXT NOT NULL UNIQUE,
                  expected_user_id TEXT NOT NULL UNIQUE,
                  purpose TEXT NOT NULL,
                  state TEXT NOT NULL,
                  related_claim_id TEXT,
                  registration_token_commitment TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  last_error_code TEXT
                );
                CREATE TABLE IF NOT EXISTS schema_metadata (
                  key TEXT PRIMARY KEY, value TEXT NOT NULL
                );
                """
            )
            database.execute("DROP TABLE IF EXISTS challenges")
            database.execute("DROP TABLE IF EXISTS sessions")
            database.execute("DROP TABLE IF EXISTS rate_events")
            database.execute(
                "INSERT OR IGNORE INTO schema_metadata(key, value) VALUES ('ledger_generation', ?)",
                (secrets.token_hex(16),),
            )
            if "legacy_claim_rows" in {
                row[0] for row in database.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }:
                columns = {
                    row[1] for row in database.execute("PRAGMA table_info(legacy_claim_rows)").fetchall()
                }
                for row in database.execute("SELECT * FROM legacy_claim_rows").fetchall():
                    receipt = row["receipt"]
                    operation_id = f"legacy-{hashlib.sha256(receipt.encode()).hexdigest()[:32]}"
                    token = row["registration_token"] if "registration_token" in columns else None
                    commitment = hashlib.sha256(token.encode()).hexdigest() if token else None
                    created_at = row["created_at"] if "created_at" in columns else int(time.time())
                    updated_at = row["updated_at"] if "updated_at" in columns else created_at
                    database.execute(
                        """INSERT OR IGNORE INTO claim_operations(
                             receipt, operation_id, address, config_address, config_revision,
                             phase, attention_required, recovery_key_version, token_generation,
                             token_commitment, expires_at_ms, created_at, updated_at, last_error_code
                           ) VALUES (?, ?, ?, NULL, NULL, 'LEGACY_REVIEW', 1, 0, 0, ?, ?, ?, ?, 'legacy_review_required')""",
                        (
                            receipt,
                            operation_id,
                            row["address"],
                            commitment,
                            row["expires_at_ms"] if "expires_at_ms" in columns else None,
                            created_at,
                            updated_at,
                        ),
                    )
                if "registration_token" in columns:
                    database.execute("UPDATE legacy_claim_rows SET registration_token = NULL")
            database.execute("PRAGMA user_version = 3")

    def enforce_storage_limit(self) -> None:
        total = sum(
            candidate.stat().st_size
            for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm"))
            if candidate.exists()
        )
        if total >= MAX_DATABASE_BYTES:
            raise IssuerError("Issuer storage limit reached", HTTPStatus.SERVICE_UNAVAILABLE)

    def ledger_generation(self) -> str:
        with self.connection() as database:
            row = database.execute(
                "SELECT value FROM schema_metadata WHERE key = 'ledger_generation'"
            ).fetchone()
        if not row or not isinstance(row[0], str) or not row[0]:
            raise IssuerError("Ledger generation is unavailable", HTTPStatus.SERVICE_UNAVAILABLE)
        return row[0]

    def rate_limit(self, key: str, limit: int, window_seconds: int) -> None:
        self.ephemeral.rate_limit(key, limit, window_seconds)

    def metrics(self) -> dict[str, Any]:
        now = int(time.time())
        with self.connection() as database:
            phases = {
                row["phase"]: row["count"]
                for row in database.execute(
                    "SELECT phase, COUNT(*) AS count FROM claim_operations GROUP BY phase"
                ).fetchall()
            }
            oldest = database.execute(
                "SELECT MIN(updated_at) FROM claim_operations WHERE phase NOT IN ('REGISTRATION_COMPLETED', 'CANCELLED_BEFORE_CONSUMPTION')"
            ).fetchone()[0]
            attention = database.execute(
                "SELECT COUNT(*) FROM claim_operations WHERE attention_required = 1"
            ).fetchone()[0]
        database_bytes = sum(
            candidate.stat().st_size
            for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm"))
            if candidate.exists()
        )
        return {
            "claimsByPhase": phases,
            "oldestOpenClaimAgeSeconds": max(0, now - oldest) if oldest else 0,
            "claimsAttentionRequired": attention,
            "unresolvedAdminOperations": self.unresolved_admin_cleanups(),
            "ephemeralOccupancy": self.ephemeral.occupancy(),
            "databaseBytes": database_bytes,
        }

    def create_challenge(self, address: str, message_factory: Callable[[str, str, int, int], bytes], ttl: int) -> tuple[dict[str, Any], bytes]:
        now = int(time.time())
        expires = now + ttl
        nonce = secrets.token_hex(16)
        request_id = f"neal-{secrets.token_urlsafe(18)}"
        message = message_factory(nonce, request_id, now, expires)
        self.ephemeral.create_challenge(request_id, address, message, expires)
        return {"nonce": nonce, "requestId": request_id, "issuedAt": now, "expiresAt": expires}, message

    def consume_challenge(self, request_id: str, address: str, signed_message: bytes) -> None:
        self.ephemeral.consume_challenge(request_id, address, signed_message)

    def create_session(self, address: str, ttl: int) -> str:
        return self.ephemeral.create_session(address, ttl)

    def session_address(self, token: str) -> str:
        return self.ephemeral.session_address(token)

    @staticmethod
    def _append_claim_event(
        database: sqlite3.Connection,
        operation_id: str,
        previous_phase: str | None,
        next_phase: str,
        event_type: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        previous = database.execute(
            "SELECT event_hash FROM claim_events WHERE operation_id = ? ORDER BY event_id DESC LIMIT 1",
            (operation_id,),
        ).fetchone()
        previous_hash = previous[0] if previous else None
        created_at = int(time.time())
        metadata_json = json.dumps(metadata or {}, sort_keys=True, separators=(",", ":"))
        event_hash = hashlib.sha256(
            json.dumps(
                {
                    "operationId": operation_id,
                    "previousPhase": previous_phase,
                    "nextPhase": next_phase,
                    "eventType": event_type,
                    "createdAt": created_at,
                    "metadata": json.loads(metadata_json),
                    "previousHash": previous_hash,
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        database.execute(
            """INSERT INTO claim_events(
                 operation_id, previous_phase, next_phase, event_type, created_at,
                 metadata_json, previous_hash, event_hash
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (operation_id, previous_phase, next_phase, event_type, created_at, metadata_json, previous_hash, event_hash),
        )

    def claim(self, receipt: str, address: str | None = None) -> sqlite3.Row | None:
        with self.connection() as database:
            row = database.execute(
                "SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)
            ).fetchone()
        if row and address is not None and row["address"] != address:
            raise IssuerError("Stake receipt belongs to another wallet", HTTPStatus.FORBIDDEN)
        return row

    def reserve_claim(
        self,
        receipt: str,
        address: str,
        config_address: str,
        config_revision: int,
        recovery_key_version: int,
    ) -> sqlite3.Row:
        self.enforce_storage_limit()
        now = int(time.time())
        operation_id = secrets.token_urlsafe(24)
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute(
                "SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)
            ).fetchone()
            if row:
                if row["address"] != address:
                    raise IssuerError("Stake receipt belongs to another wallet", HTTPStatus.FORBIDDEN)
                return row
            database.execute(
                """INSERT INTO claim_operations(
                     receipt, operation_id, address, config_address, config_revision,
                     phase, attention_required, recovery_key_version, token_generation,
                     created_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'RESERVED', 0, ?, 0, ?, ?)""",
                (receipt, operation_id, address, config_address, config_revision, recovery_key_version, now, now),
            )
            self._append_claim_event(database, operation_id, None, "RESERVED", "claim_reserved")
            return database.execute(
                "SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)
            ).fetchone()

    def transition_claim(
        self,
        receipt: str,
        expected_phases: tuple[str, ...],
        next_phase: str,
        *,
        event_type: str,
        fields: dict[str, Any] | None = None,
    ) -> sqlite3.Row:
        allowed = {
            "chain_signature",
            "signed_transaction",
            "token_commitment",
            "expires_at_ms",
            "matrix_pending",
            "matrix_completed",
            "attention_required",
            "last_error_code",
            "token_generation",
        }
        values = fields or {}
        if set(values) - allowed:
            raise IssuerError("Unsupported claim update", HTTPStatus.INTERNAL_SERVER_ERROR)
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute(
                "SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)
            ).fetchone()
            if not row or row["phase"] not in expected_phases:
                raise IssuerError("Claim phase changed concurrently", HTTPStatus.CONFLICT)
            if next_phase not in CLAIM_PHASES and next_phase not in TERMINAL_CLAIM_PHASES:
                raise IssuerError("Claim phase is unsupported", HTTPStatus.INTERNAL_SERVER_ERROR)
            if next_phase in CLAIM_PHASES and (
                row["phase"] in CLAIM_PHASES
                and CLAIM_PHASES.index(next_phase) < CLAIM_PHASES.index(row["phase"])
            ):
                raise IssuerError("Claim phases may not move backward", HTTPStatus.INTERNAL_SERVER_ERROR)
            assignments = ["phase = ?", "updated_at = ?"]
            parameters: list[Any] = [next_phase, int(time.time())]
            for key, value in values.items():
                assignments.append(f"{key} = ?")
                parameters.append(value)
            parameters.extend((receipt, row["phase"]))
            changed = database.execute(
                f"UPDATE claim_operations SET {', '.join(assignments)} WHERE receipt = ? AND phase = ?",
                parameters,
            ).rowcount
            if changed != 1:
                raise IssuerError("Claim phase changed concurrently", HTTPStatus.CONFLICT)
            self._append_claim_event(database, row["operation_id"], row["phase"], next_phase, event_type)
            return database.execute(
                "SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)
            ).fetchone()

    def mark_claim_attention(self, receipt: str, error_code: str) -> None:
        with self.connection() as database:
            database.execute(
                "UPDATE claim_operations SET attention_required = 1, last_error_code = ?, updated_at = ? WHERE receipt = ?",
                (error_code, int(time.time()), receipt),
            )

    def claim_by_operation(self, operation_id: str) -> sqlite3.Row:
        with self.connection() as database:
            row = database.execute(
                "SELECT * FROM claim_operations WHERE operation_id = ?", (operation_id,)
            ).fetchone()
        if not row:
            raise IssuerError("Unknown claim operation", HTTPStatus.NOT_FOUND, code="operation_not_found")
        return row

    def clear_claim_attention(self, receipt: str) -> None:
        with self.connection() as database:
            database.execute(
                "UPDATE claim_operations SET attention_required = 0, last_error_code = NULL, updated_at = ? WHERE receipt = ?",
                (int(time.time()), receipt),
            )

    def reserve_token_replacement(self, receipt: str) -> sqlite3.Row:
        with self.connection() as database:
            database.execute("BEGIN IMMEDIATE")
            row = database.execute("SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)).fetchone()
            if not row or row["phase"] not in {"TOKEN_READY", "REGISTRATION_IN_PROGRESS"}:
                raise IssuerError("Claim is not eligible for token replacement", HTTPStatus.CONFLICT)
            database.execute(
                """UPDATE claim_operations
                   SET token_generation = token_generation + 1, token_commitment = NULL,
                       expires_at_ms = NULL, attention_required = 1,
                       last_error_code = 'token_replacement_pending', updated_at = ?
                   WHERE receipt = ?""",
                (int(time.time()), receipt),
            )
            self._append_claim_event(
                database,
                row["operation_id"],
                row["phase"],
                row["phase"],
                "registration_token_replacement_reserved",
                {"nextGeneration": row["token_generation"] + 1},
            )
            return database.execute("SELECT * FROM claim_operations WHERE receipt = ?", (receipt,)).fetchone()

    def complete_token_replacement(self, receipt: str, token: str, expires_at_ms: int) -> sqlite3.Row:
        row = self.claim(receipt)
        if not row or row["last_error_code"] != "token_replacement_pending":
            raise IssuerError("Token replacement is not pending", HTTPStatus.CONFLICT)
        return self.transition_claim(
            receipt,
            (row["phase"],),
            row["phase"],
            event_type="registration_token_replaced",
            fields={
                "token_commitment": hashlib.sha256(token.encode()).hexdigest(),
                "expires_at_ms": expires_at_ms,
                "attention_required": 0,
                "last_error_code": None,
            },
        )

    def operation_summaries(self) -> list[dict[str, Any]]:
        with self.connection() as database:
            rows = database.execute(
                """SELECT operation_id, receipt, address, phase, attention_required,
                          token_generation, expires_at_ms, created_at, updated_at, last_error_code
                   FROM claim_operations ORDER BY created_at, operation_id"""
            ).fetchall()
        return [dict(row) for row in rows]

    def add_admin_cleanup(self, user_id: str, registration_token: str | None, error: str) -> None:
        with self.connection() as database:
            database.execute(
                "INSERT OR REPLACE INTO admin_cleanups(user_id, registration_token, created_at, resolved_at, error) VALUES (?, ?, ?, NULL, ?)",
                (user_id, registration_token, int(time.time()), error[:500]),
            )

    def plan_admin(self, purpose: str, related_claim_id: str | None) -> tuple[str, str, str]:
        operation_id = secrets.token_hex(16)
        username = f"neal_access_issuer_{operation_id}"
        expected_user_id = f"@{username}:{self._matrix_server_name}"
        now = int(time.time())
        with self.connection() as database:
            database.execute(
                """INSERT INTO admin_operations(
                     operation_id, username, expected_user_id, purpose, state,
                     related_claim_id, created_at, updated_at
                   ) VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?)""",
                (operation_id, username, expected_user_id, purpose, related_claim_id, now, now),
            )
        return operation_id, username, expected_user_id

    def set_matrix_server_name(self, server_name: str) -> None:
        self._matrix_server_name = server_name

    def transition_admin(
        self,
        operation_id: str,
        expected_states: tuple[str, ...],
        next_state: str,
        *,
        error_code: str | None = None,
        token_commitment: str | None = None,
    ) -> None:
        assignments = ["state = ?", "updated_at = ?", "last_error_code = ?"]
        parameters: list[Any] = [next_state, int(time.time()), error_code]
        if token_commitment is not None:
            assignments.append("registration_token_commitment = ?")
            parameters.append(token_commitment)
        placeholders = ",".join("?" for _ in expected_states)
        parameters.extend((operation_id, *expected_states))
        with self.connection() as database:
            changed = database.execute(
                f"UPDATE admin_operations SET {', '.join(assignments)} WHERE operation_id = ? AND state IN ({placeholders})",
                parameters,
            ).rowcount
        if changed != 1:
            raise IssuerError("Administrator operation state changed", HTTPStatus.CONFLICT)

    def admin_operation_for_user(self, user_id: str) -> sqlite3.Row | None:
        with self.connection() as database:
            return database.execute(
                "SELECT * FROM admin_operations WHERE expected_user_id = ?", (user_id,)
            ).fetchone()

    def mark_admin_reconciliation(self, user_id: str, error_code: str) -> None:
        operation = self.admin_operation_for_user(user_id)
        if operation:
            self.transition_admin(
                operation["operation_id"],
                ("PLANNED", "CREATE_REQUESTED", "ACTIVE", "CLEANUP_REQUESTED", "RECONCILIATION_REQUIRED"),
                "RECONCILIATION_REQUIRED",
                error_code=error_code,
            )
        else:
            self.add_admin_cleanup(user_id, None, error_code)

    def unresolved_admin_cleanups(self) -> int:
        with self.connection() as database:
            legacy = database.execute(
                "SELECT COUNT(*) FROM admin_cleanups WHERE resolved_at IS NULL"
            ).fetchone()[0]
            journaled = database.execute(
                "SELECT COUNT(*) FROM admin_operations WHERE state != 'RESOLVED'"
            ).fetchone()[0]
            return legacy + journaled

    def pending_admin_cleanups(self) -> list[dict[str, Any]]:
        with self.connection() as database:
            legacy = database.execute(
                "SELECT user_id, created_at, error FROM admin_cleanups WHERE resolved_at IS NULL ORDER BY created_at"
            ).fetchall()
            journaled = database.execute(
                """SELECT operation_id, expected_user_id AS user_id, purpose, state,
                          related_claim_id, created_at, updated_at, last_error_code
                   FROM admin_operations WHERE state != 'RESOLVED' ORDER BY created_at"""
            ).fetchall()
        return [
            *({"kind": "legacy", **dict(row)} for row in legacy),
            *({"kind": "journaled", **dict(row)} for row in journaled),
        ]

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
        self.metrics_lock = threading.Lock()
        self.rpc_disagreements = 0
        self.rpc_failures = 0

    def rpc_endpoint(self, endpoint: RpcEndpoint, method: str, params: list[Any]) -> Any:
        request = urllib.request.Request(
            endpoint.url,
            data=json.dumps({"jsonrpc": "2.0", "id": secrets.token_hex(4), "method": method, "params": params}).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=RPC_TIMEOUT_SECONDS) as response:
                raw = response.read(MAX_RPC_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RPC_RESPONSE_BYTES:
                    raise IssuerError("Solana RPC response exceeds the size limit", HTTPStatus.SERVICE_UNAVAILABLE)
                body = json.loads(raw)
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
        results: list[tuple[RpcEndpoint, Any]] = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.settings.rpc_set.endpoints)) as executor:
            pending = {
                executor.submit(self.rpc_endpoint, endpoint, method, params): endpoint
                for endpoint in self.settings.rpc_set.endpoints
            }
            for future, endpoint in ((future, pending[future]) for future in pending):
                try:
                    results.append((endpoint, future.result(timeout=RPC_TIMEOUT_SECONDS + 1)))
                except Exception:
                    with self.metrics_lock:
                        self.rpc_failures += 1
                    continue
        groups: dict[str, list[tuple[RpcEndpoint, Any]]] = {}
        for endpoint, result in results:
            comparable = json.dumps(self.comparable_result(result), sort_keys=True, separators=(",", ":"))
            groups.setdefault(comparable, []).append((endpoint, result))
        agreed = [group for group in groups.values() if len({entry[0].trust_domain for entry in group}) >= self.settings.rpc_set.threshold]
        if len(agreed) != 1:
            with self.metrics_lock:
                self.rpc_disagreements += 1
            raise IssuerError("Solana RPC quorum is unavailable", HTTPStatus.SERVICE_UNAVAILABLE)
        return agreed[0][0][1]

    def metrics(self) -> dict[str, int]:
        with self.metrics_lock:
            return {
                "rpcFailures": self.rpc_failures,
                "rpcDisagreements": self.rpc_disagreements,
            }

    def broadcast(self, transaction: bytes) -> str:
        encoded = base64.b64encode(transaction).decode()
        params = [
            encoded,
            {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "finalized", "maxRetries": 3},
        ]
        signatures: dict[str, set[str]] = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(self.settings.rpc_set.endpoints)) as executor:
            pending = {
                executor.submit(self.rpc_endpoint, endpoint, "sendTransaction", params): endpoint
                for endpoint in self.settings.rpc_set.endpoints
            }
            for future, endpoint in ((future, pending[future]) for future in pending):
                try:
                    signature = future.result(timeout=RPC_TIMEOUT_SECONDS + 1)
                except Exception:
                    continue
                if isinstance(signature, str):
                    signatures.setdefault(signature, set()).add(endpoint.trust_domain)
        accepted = [signature for signature, domains in signatures.items() if len(domains) >= self.settings.rpc_set.threshold]
        if len(accepted) != 1:
            raise IssuerError("Signed transaction did not reach the required RPC quorum", HTTPStatus.SERVICE_UNAVAILABLE)
        return accepted[0]

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

    def consume(
        self,
        address: str,
        receipt_address: str,
        persist_signed: Callable[[bytes], None] | None = None,
    ) -> str:
        expected = self.receipt_address(address)
        if receipt_address != expected:
            raise IssuerError("Stake receipt address changed", HTTPStatus.CONFLICT)
        latest = self.rpc("getLatestBlockhash", [{"commitment": "finalized"}])
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
        if persist_signed:
            persist_signed(transaction)
        tx_signature = self.broadcast(transaction)
        if not isinstance(tx_signature, str):
            raise IssuerError("Solana RPC returned no transaction signature", HTTPStatus.SERVICE_UNAVAILABLE)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            result = self.rpc("getSignatureStatuses", [[tx_signature], {"searchTransactionHistory": True}])
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

    def consumed(self, receipt_address: str) -> bool:
        owner, data = self.account(receipt_address)
        if owner != self.settings.program_id:
            raise IssuerError("Stake receipt has the wrong owner", HTTPStatus.UNPROCESSABLE_ENTITY)
        return parse_receipt(data)["issued_at"] > 0


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
                raw = response.read(MAX_RPC_RESPONSE + 1)
                if len(raw) > MAX_RPC_RESPONSE:
                    raise IssuerError("Matrix response exceeded the issuer limit", HTTPStatus.SERVICE_UNAVAILABLE)
                value = json.loads(raw) if raw else {}
                if not isinstance(value, dict):
                    raise IssuerError("Matrix returned an invalid response", HTTPStatus.SERVICE_UNAVAILABLE)
                return value
        except urllib.error.HTTPError as error:
            if allow_not_found and error.code == HTTPStatus.NOT_FOUND:
                return {}
            raise IssuerError("Matrix token service rejected the request", HTTPStatus.SERVICE_UNAVAILABLE) from error
        except (OSError, json.JSONDecodeError) as error:
            raise IssuerError("Matrix token service is unavailable", HTTPStatus.SERVICE_UNAVAILABLE) from error

    def temporary_admin(
        self, purpose: str = "reconciliation", related_claim_id: str | None = None
    ) -> tuple[str, str]:
        shared = self.settings.matrix_secret_file.read_text().strip().encode()
        nonce = self.request_json("GET", "/_synapse/admin/v1/register")["nonce"]
        operation_id = ""
        expected_user_id = ""
        if self.store:
            operation_id, username, expected_user_id = self.store.plan_admin(purpose, related_claim_id)
            self.store.transition_admin(operation_id, ("PLANNED",), "CREATE_REQUESTED")
        else:
            username = f"neal_access_issuer_{secrets.token_hex(16)}"
        password = secrets.token_urlsafe(48)
        mac_input = b"\x00".join((nonce.encode(), username.encode(), password.encode(), b"admin"))
        mac = hmac.new(shared, mac_input, hashlib.sha1).hexdigest()
        try:
            result = self.request_json(
                "POST",
                "/_synapse/admin/v1/register",
                body={"nonce": nonce, "username": username, "password": password, "admin": True, "mac": mac},
            )
            user_id = result["user_id"]
            token = result["access_token"]
            if expected_user_id and user_id != expected_user_id:
                raise IssuerError("Synapse created an unexpected administrator identity", HTTPStatus.SERVICE_UNAVAILABLE)
            if operation_id:
                self.store.transition_admin(operation_id, ("CREATE_REQUESTED",), "ACTIVE")
            return user_id, token
        except Exception:
            if operation_id:
                self.store.transition_admin(
                    operation_id,
                    ("CREATE_REQUESTED",),
                    "RECONCILIATION_REQUIRED",
                    error_code="matrix_admin_create_ambiguous",
                )
            raise

    def ready(self) -> None:
        if self.store and self.store.unresolved_admin_cleanups():
            raise IssuerError("Temporary administrator cleanup is required", HTTPStatus.SERVICE_UNAVAILABLE)
        if not self.settings.matrix_secret_file.read_text().strip():
            raise IssuerError("Matrix registration secret is empty", HTTPStatus.SERVICE_UNAVAILABLE)
        versions = self.request_json("GET", "/_matrix/client/versions")
        if not isinstance(versions.get("versions"), list):
            raise IssuerError("Matrix client API readiness check failed", HTTPStatus.SERVICE_UNAVAILABLE)

    def registration_token_status(self, registration_token: str, admin_token: str) -> dict[str, Any] | None:
        result = self.request_json(
            "GET",
            f"/_synapse/admin/v1/registration_tokens/{urllib.parse.quote(registration_token, safe='')}",
            token=admin_token,
            allow_not_found=True,
        )
        return result if result.get("token") == registration_token else None

    @staticmethod
    def validate_registration_token_status(status: dict[str, Any], registration_token: str) -> int:
        if status.get("token") != registration_token:
            raise IssuerError("Synapse returned a different registration token", HTTPStatus.SERVICE_UNAVAILABLE)
        pending = status.get("pending")
        completed = status.get("completed")
        expiry = status.get("expiry_time")
        if not isinstance(pending, int) or not isinstance(completed, int) or not isinstance(expiry, int):
            raise IssuerError("Synapse registration-token state is invalid", HTTPStatus.SERVICE_UNAVAILABLE)
        if completed > 0:
            raise IssuerError("Registration token is already consumed", HTTPStatus.CONFLICT)
        if pending > 0:
            raise IssuerError("Registration token is already in use", HTTPStatus.CONFLICT)
        return expiry

    def observe_reserved_admin_prefix(self) -> list[str]:
        """Journal active reserved-prefix identities without changing them."""
        if not self.store:
            raise IssuerError("Administrator scanning requires the issuer store", HTTPStatus.INTERNAL_SERVER_ERROR)
        scanner_id = ""
        scanner_token = ""
        observed: list[str] = []
        try:
            scanner_id, scanner_token = self.temporary_admin("reserved-prefix-scan")
            next_token: str | None = None
            scanned = 0
            while True:
                query = "?limit=500"
                if next_token:
                    query += f"&from={urllib.parse.quote(next_token, safe='')}"
                result = self.request_json("GET", f"/_synapse/admin/v2/users{query}", token=scanner_token)
                users = result.get("users")
                if not isinstance(users, list):
                    raise IssuerError("Synapse user scan is invalid", HTTPStatus.SERVICE_UNAVAILABLE)
                for user in users:
                    if not isinstance(user, dict):
                        continue
                    user_id = user.get("name")
                    if (
                        not isinstance(user_id, str)
                        or not user_id.startswith("@neal_access_issuer_")
                        or user_id == scanner_id
                        or user.get("deactivated") is True
                    ):
                        continue
                    observed.append(user_id)
                    operation = self.store.admin_operation_for_user(user_id)
                    if operation and operation["state"] != "RESOLVED":
                        self.store.mark_admin_reconciliation(user_id, "reserved_prefix_scan")
                    else:
                        self.store.add_admin_cleanup(user_id, None, "reserved_prefix_scan")
                scanned += len(users)
                if scanned > 50_000:
                    raise IssuerError("Synapse user scan exceeded its safety limit", HTTPStatus.SERVICE_UNAVAILABLE)
                candidate = result.get("next_token")
                if not isinstance(candidate, str) or not candidate:
                    break
                next_token = candidate
        finally:
            if scanner_id and scanner_token:
                self.deactivate(scanner_id, scanner_token)
        return observed

    def deactivate(self, user_id: str, token: str) -> None:
        operation = self.store.admin_operation_for_user(user_id) if self.store else None
        if operation:
            self.store.transition_admin(
                operation["operation_id"],
                ("PLANNED", "CREATE_REQUESTED", "ACTIVE", "RECONCILIATION_REQUIRED"),
                "CLEANUP_REQUESTED",
            )
        try:
            self.request_json(
                "POST",
                f"/_synapse/admin/v1/deactivate/{urllib.parse.quote(user_id, safe='')}",
                token=token,
                body={"erase": True},
            )
        except Exception:
            if operation:
                self.store.transition_admin(
                    operation["operation_id"],
                    ("CLEANUP_REQUESTED",),
                    "RECONCILIATION_REQUIRED",
                    error_code="matrix_admin_cleanup_ambiguous",
                )
            raise
        if operation:
            self.store.transition_admin(
                operation["operation_id"], ("CLEANUP_REQUESTED",), "RESOLVED"
            )

    def reconcile_admin_cleanup(self, user_id: str) -> None:
        if not self.store:
            raise IssuerError("Reconciliation requires the issuer store", HTTPStatus.INTERNAL_SERVER_ERROR)
        operation = self.store.admin_operation_for_user(user_id)
        cleanup = None if operation else self.store.admin_cleanup(user_id)
        reconciler_id = ""
        reconciler_token = ""
        try:
            reconciler_id, reconciler_token = self.temporary_admin()
            registration_token = cleanup["registration_token"] if cleanup else None
            if registration_token:
                self.request_json(
                    "DELETE",
                    f"/_synapse/admin/v1/registration_tokens/{urllib.parse.quote(registration_token, safe='')}",
                    token=reconciler_token,
                    allow_not_found=True,
                )
            self.deactivate(user_id, reconciler_token)
            if cleanup:
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

    def revoke_unused_registration_token(self, registration_token: str) -> None:
        """Explicit operator primitive: prove unused, revoke, and verify absence."""
        admin_id = ""
        admin_token = ""
        try:
            admin_id, admin_token = self.temporary_admin("token-replacement")
            status = self.registration_token_status(registration_token, admin_token)
            if status is None:
                return
            pending = status.get("pending")
            completed = status.get("completed")
            if pending != 0 or completed != 0:
                raise IssuerError(
                    "Registration token has pending or completed uses",
                    HTTPStatus.CONFLICT,
                    code="registration_token_in_use",
                )
            self.request_json(
                "DELETE",
                f"/_synapse/admin/v1/registration_tokens/{urllib.parse.quote(registration_token, safe='')}",
                token=admin_token,
                allow_not_found=True,
            )
            if self.registration_token_status(registration_token, admin_token) is not None:
                raise IssuerError(
                    "Registration token revocation was not confirmed",
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    code="registration_token_revocation_unconfirmed",
                )
        finally:
            if admin_id and admin_token:
                self.deactivate(admin_id, admin_token)

    def issue(self, desired_token: str | None = None, related_claim_id: str | None = None) -> tuple[str, int]:
        if self.store and self.store.unresolved_admin_cleanups():
            raise IssuerError("Issuance is halted pending administrator cleanup", HTTPStatus.SERVICE_UNAVAILABLE)
        admin_id = ""
        admin_token = ""
        registration_token = ""
        try:
            admin_id, admin_token = self.temporary_admin("claim-token", related_claim_id)
            expires_at_ms = int(time.time() * 1000) + self.settings.token_ttl_minutes * 60 * 1000
            request_body: dict[str, Any] = {"uses_allowed": 1, "expiry_time": expires_at_ms}
            if desired_token is not None:
                request_body["token"] = desired_token
            existing = self.registration_token_status(desired_token, admin_token) if desired_token is not None else None
            if existing is not None:
                expires_at_ms = self.validate_registration_token_status(existing, desired_token)
                result = existing
            else:
                try:
                    result = self.request_json(
                        "POST",
                        "/_synapse/admin/v1/registration_tokens/new",
                        token=admin_token,
                        body=request_body,
                    )
                except IssuerError:
                    recovered = self.registration_token_status(desired_token, admin_token) if desired_token is not None else None
                    if recovered is None:
                        raise
                    expires_at_ms = self.validate_registration_token_status(recovered, desired_token)
                    result = recovered
            token = result.get("token")
            if not isinstance(token, str) or not token:
                raise IssuerError("Synapse returned no registration token", HTTPStatus.SERVICE_UNAVAILABLE)
            if desired_token is not None and not hmac.compare_digest(token, desired_token):
                raise IssuerError("Synapse returned a different registration token", HTTPStatus.SERVICE_UNAVAILABLE)
            registration_token = token
            if self.store:
                operation = self.store.admin_operation_for_user(admin_id)
                if operation:
                    self.store.transition_admin(
                        operation["operation_id"],
                        ("ACTIVE",),
                        "ACTIVE",
                        token_commitment=hashlib.sha256(token.encode()).hexdigest(),
                    )
            return token, expires_at_ms
        finally:
            if admin_id and admin_token:
                try:
                    self.deactivate(admin_id, admin_token)
                except Exception as error:  # cleanup failure must be visible to operators
                    if self.store:
                        if not self.store.admin_operation_for_user(admin_id):
                            self.store.add_admin_cleanup(admin_id, None, "matrix_admin_cleanup_ambiguous")
                    print("temporary admin cleanup failed: matrix_admin_cleanup_ambiguous", file=sys.stderr)
                    raise IssuerError(
                        "Temporary administrator cleanup failed; issuance is halted for reconciliation",
                        HTTPStatus.SERVICE_UNAVAILABLE,
                    ) from error


class Application:
    def __init__(self, settings: Settings, matrix: MatrixIssuer | None = None, solana: SolanaVerifier | None = None):
        self.settings = settings
        self.store = Store(settings.database)
        self.store.set_matrix_server_name(settings.matrix_server_name)
        self.recovery_key = settings.recovery_key_file.read_bytes()
        self.matrix = matrix or MatrixIssuer(settings, self.store)
        self.solana = solana or SolanaVerifier(settings)
        self.startup_admin_scan_error: str | None = None
        scan = getattr(self.matrix, "observe_reserved_admin_prefix", None)
        if callable(scan):
            try:
                if scan():
                    self.startup_admin_scan_error = "reserved_admin_identity_active"
            except Exception:
                self.startup_admin_scan_error = "reserved_admin_scan_failed"

    def ready(self) -> dict[str, Any]:
        if self.startup_admin_scan_error:
            raise IssuerError(
                "Reserved administrator reconciliation is required",
                HTTPStatus.SERVICE_UNAVAILABLE,
                code=self.startup_admin_scan_error,
                retryable=self.startup_admin_scan_error == "reserved_admin_scan_failed",
            )
        if (self.settings.database.parent / "restore-reconciliation-required.json").exists():
            raise IssuerError("Post-restore reconciliation is required", HTTPStatus.SERVICE_UNAVAILABLE)
        with self.store.connection() as database:
            database.execute("SELECT 1").fetchone()
        config = self.solana.config()
        self.matrix.ready()
        return {
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
            "verificationMode": self.settings.rpc_set.mode,
            "programId": self.settings.program_id,
            "programDataAddress": self.settings.program_data_address,
            "programSha256": self.settings.program_sha256,
            "configAddress": self.settings.config_address,
            "mint": self.settings.mint,
            "requiredAtomicAmount": str(config["required_amount"]),
            "minimumLockSeconds": config["minimum_lock_seconds"],
            "configRevision": str(config["revision"]),
        }

    def metrics(self) -> dict[str, Any]:
        result = self.store.metrics()
        solana_metrics = getattr(self.solana, "metrics", None)
        if callable(solana_metrics):
            result.update(solana_metrics())
        result["diskFreeBytes"] = shutil.disk_usage(self.settings.database.parent).free
        receipt_path = self.settings.database.parent / "last-backup-receipt.json"
        result["backupAgeSeconds"] = None
        if receipt_path.is_file() and not receipt_path.is_symlink():
            try:
                receipt = json.loads(receipt_path.read_text())
                created = datetime.fromisoformat(receipt["createdAt"].replace("Z", "+00:00"))
                result["backupAgeSeconds"] = max(
                    0, int((datetime.now(timezone.utc) - created.astimezone(timezone.utc)).total_seconds())
                )
            except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                result["backupAgeSeconds"] = -1
        try:
            balance = self.solana.rpc("getBalance", [base58_encode(self.solana.issuer_public), {"commitment": "finalized"}])
            value = balance.get("value") if isinstance(balance, dict) else None
            result["issuerLamports"] = value if isinstance(value, int) else None
        except Exception:
            result["issuerLamports"] = None
        return {
            "schema": "neal.issuer-metrics/v1",
            "recordedAt": iso_millis(int(time.time())),
            **result,
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
        request_schema = body.get("schema")
        if request_schema not in {"neal.wallet-challenge-request/v1", "neal.wallet-challenge-request/v2"} or body.get("chain") != self.settings.chain_id or not isinstance(address, str):
            raise IssuerError("Invalid wallet challenge request")
        public_key(address)
        self.store.rate_limit("challenge-global", 1_000, 60)
        self.store.rate_limit(f"challenge-ip:{client_key}", 60, 3600)
        self.store.rate_limit(f"challenge:{client_key}:{address}", 10, 3600)
        result: dict[str, Any] = {}

        def factory(nonce: str, request_id: str, issued: int, expires: int) -> bytes:
            nonlocal result
            result = self.sign_in_input(address, nonce, request_id, issued, expires)
            return siws_message(result)

        self.store.create_challenge(address, factory, self.settings.challenge_ttl_seconds)
        version = "v2" if request_schema.endswith("/v2") else "v1"
        return {"schema": f"neal.wallet-challenge/{version}", "signInInput": result}

    def verify(self, body: dict[str, Any], client_key: str) -> tuple[dict[str, Any], str]:
        request_schema = body.get("schema")
        if request_schema not in {"neal.wallet-verification/v1", "neal.wallet-verification/v2"}:
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
            "schema": f"neal.wallet-authentication/{'v2' if request_schema.endswith('/v2') else 'v1'}",
            "authenticated": True,
            "address": address,
            "sessionExpiresAt": (int(time.time()) + self.settings.session_ttl_seconds) * 1000,
        }, session

    def derive_registration_token(self, row: sqlite3.Row) -> str:
        material = b"\0".join(
            (
                b"neal-access-issuer/registration-token/v1",
                self.settings.chain_id.encode(),
                (row["config_address"] or self.settings.config_address).encode(),
                str(row["config_revision"] if row["config_revision"] is not None else self.settings.expected_revision).encode(),
                row["receipt"].encode(),
                str(row["recovery_key_version"]).encode(),
                str(row["token_generation"]).encode(),
            )
        )
        digest = hmac.new(self.recovery_key, material, hashlib.sha256).digest()
        return f"neal_{base64.urlsafe_b64encode(digest).decode().rstrip('=')}"

    @staticmethod
    def processing_response(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "schema": "neal.matrix-access-token-operation/v2",
            "state": "processing",
            "operationId": row["operation_id"],
            "receipt": row["receipt"],
            "retryAfterMs": 2_000,
        }

    def advance_claim(self, row: sqlite3.Row, address: str) -> tuple[int, dict[str, Any]]:
        receipt = row["receipt"]
        for _step in range(8):
            phase = row["phase"]
            if row["attention_required"] and phase in {
                "MATRIX_TOKEN_ENSURING",
                "ADMIN_CLEANUP_PENDING",
            }:
                return HTTPStatus.ACCEPTED, self.processing_response(row)
            if phase == "LEGACY_REVIEW":
                raise IssuerError(
                    "This pre-production claim requires manual review",
                    HTTPStatus.CONFLICT,
                    code="legacy_claim_review_required",
                    operation_id=row["operation_id"],
                )
            if phase == "REGISTRATION_COMPLETED":
                raise IssuerError(
                    "Registration is already completed; sign in with the account password",
                    HTTPStatus.CONFLICT,
                    code="registration_completed",
                    operation_id=row["operation_id"],
                )
            if phase in {"TOKEN_READY", "REGISTRATION_IN_PROGRESS"}:
                if not row["expires_at_ms"] or row["expires_at_ms"] <= int(time.time() * 1000):
                    raise IssuerError(
                        "The registration token expired and requires operator review",
                        HTTPStatus.CONFLICT,
                        code="token_expired_operator_action",
                        operation_id=row["operation_id"],
                    )
                token = self.derive_registration_token(row)
                if not row["token_commitment"] or not hmac.compare_digest(
                    row["token_commitment"], hashlib.sha256(token.encode()).hexdigest()
                ):
                    self.store.mark_claim_attention(receipt, "token_commitment_mismatch")
                    raise IssuerError(
                        "Registration-token recovery is unavailable",
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        code="token_commitment_mismatch",
                        operation_id=row["operation_id"],
                    )
                return HTTPStatus.OK, {
                    "schema": "neal.matrix-access-token/v2",
                    "state": "token_ready",
                    "operationId": row["operation_id"],
                    "receipt": receipt,
                    "token": token,
                    "expiresAt": row["expires_at_ms"],
                }
            if phase == "RESERVED":
                try:
                    def persist_signed(transaction: bytes) -> None:
                        self.store.transition_claim(
                            receipt,
                            ("RESERVED",),
                            "CHAIN_SUBMITTED",
                            event_type="chain_transaction_signed",
                            fields={"signed_transaction": transaction},
                        )

                    signature = self.solana.consume(address, receipt, persist_signed)
                    row = self.store.transition_claim(
                        receipt,
                        ("CHAIN_SUBMITTED",),
                        "CHAIN_CONSUMED",
                        event_type="chain_consumption_finalized",
                        fields={"chain_signature": signature, "attention_required": 0, "last_error_code": None},
                    )
                    continue
                except Exception as error:
                    row = self.store.claim(receipt, address)
                    if row and row["phase"] == "RESERVED":
                        self.store.mark_claim_attention(receipt, "chain_submission_failed")
                        raise IssuerError(
                            "Finalized stake consumption is temporarily unavailable",
                            HTTPStatus.SERVICE_UNAVAILABLE,
                            code="chain_submission_failed",
                            retryable=True,
                            operation_id=row["operation_id"],
                        ) from error
                    if row:
                        self.store.mark_claim_attention(receipt, "chain_finality_ambiguous")
                        return HTTPStatus.ACCEPTED, self.processing_response(row)
                    raise
            if phase == "CHAIN_SUBMITTED":
                try:
                    consumed = self.solana.consumed(receipt)
                except Exception:
                    self.store.mark_claim_attention(receipt, "chain_finality_unavailable")
                    return HTTPStatus.ACCEPTED, self.processing_response(row)
                if not consumed:
                    return HTTPStatus.ACCEPTED, self.processing_response(row)
                row = self.store.transition_claim(
                    receipt,
                    ("CHAIN_SUBMITTED",),
                    "CHAIN_CONSUMED",
                    event_type="chain_consumption_recovered",
                    fields={"attention_required": 0, "last_error_code": None},
                )
                continue
            if phase == "CHAIN_CONSUMED":
                row = self.store.transition_claim(
                    receipt,
                    ("CHAIN_CONSUMED",),
                    "MATRIX_TOKEN_ENSURING",
                    event_type="matrix_token_started",
                )
                continue
            if phase == "MATRIX_TOKEN_ENSURING":
                desired_token = self.derive_registration_token(row)
                try:
                    token, expires_at_ms = self.matrix.issue(desired_token, row["operation_id"])
                except Exception:
                    self.store.mark_claim_attention(receipt, "matrix_token_ambiguous")
                    return HTTPStatus.ACCEPTED, self.processing_response(row)
                if not hmac.compare_digest(token, desired_token):
                    self.store.mark_claim_attention(receipt, "matrix_token_mismatch")
                    raise IssuerError(
                        "Matrix token identity did not match recovery state",
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        code="matrix_token_mismatch",
                        operation_id=row["operation_id"],
                    )
                row = self.store.transition_claim(
                    receipt,
                    ("MATRIX_TOKEN_ENSURING",),
                    "ADMIN_CLEANUP_PENDING",
                    event_type="matrix_token_ensured",
                    fields={
                        "token_commitment": hashlib.sha256(token.encode()).hexdigest(),
                        "expires_at_ms": expires_at_ms,
                    },
                )
                continue
            if phase == "ADMIN_CLEANUP_PENDING":
                if self.store.unresolved_admin_cleanups():
                    self.store.mark_claim_attention(receipt, "matrix_admin_cleanup_pending")
                    return HTTPStatus.ACCEPTED, self.processing_response(row)
                row = self.store.transition_claim(
                    receipt,
                    ("ADMIN_CLEANUP_PENDING",),
                    "TOKEN_READY",
                    event_type="matrix_admin_cleanup_confirmed",
                    fields={"attention_required": 0, "last_error_code": None},
                )
                continue
            raise IssuerError(
                "Claim phase requires operator review",
                HTTPStatus.CONFLICT,
                code="claim_phase_unsupported",
                operation_id=row["operation_id"],
            )
        return HTTPStatus.ACCEPTED, self.processing_response(row)

    def access_token_v2(self, session: str, client_key: str) -> tuple[int, dict[str, Any]]:
        address = self.store.session_address(session)
        self.store.rate_limit("token-global", 1_000, 60)
        self.store.rate_limit(f"token:{client_key}:{address}", 5, 3600)
        receipt = self.solana.receipt_address(address)
        row = self.store.claim(receipt, address)
        if row is None:
            verified_receipt = self.solana.verify(address)
            if verified_receipt != receipt:
                raise IssuerError("Stake receipt verification changed", HTTPStatus.CONFLICT, code="receipt_changed")
            row = self.store.reserve_claim(
                receipt,
                address,
                self.settings.config_address,
                self.settings.expected_revision,
                self.settings.recovery_key_version,
            )
        return self.advance_claim(row, address)

    def access_token(self, session: str, client_key: str) -> dict[str, Any]:
        status, result = self.access_token_v2(session, client_key)
        if status != HTTPStatus.OK:
            raise IssuerError(
                "Token issuance is processing; retry with the v2 API",
                HTTPStatus.SERVICE_UNAVAILABLE,
                code="claim_processing",
                retryable=True,
                operation_id=result.get("operationId"),
            )
        return {
            "schema": "neal.matrix-access-token/v1",
            "token": result["token"],
            "expiresAt": result["expiresAt"],
            "receipt": result["receipt"],
        }

    def registration_stage(self, session: str, body: dict[str, Any]) -> dict[str, Any]:
        address = self.store.session_address(session)
        operation_id = body.get("operationId")
        stage = body.get("stage")
        if body.get("schema") != "neal.matrix-registration-stage/v2" or stage not in {
            "registration_in_progress",
            "registration_completed",
        } or not isinstance(operation_id, str):
            raise IssuerError("Invalid registration-stage request", code="invalid_registration_stage")
        with self.store.connection() as database:
            row = database.execute(
                "SELECT * FROM claim_operations WHERE operation_id = ?", (operation_id,)
            ).fetchone()
        if not row or row["address"] != address:
            raise IssuerError("Registration operation is unavailable", HTTPStatus.NOT_FOUND, code="operation_not_found")
        if stage == "registration_in_progress" and row["phase"] == "TOKEN_READY":
            row = self.store.transition_claim(
                row["receipt"],
                ("TOKEN_READY",),
                "REGISTRATION_IN_PROGRESS",
                event_type="registration_started",
            )
        elif stage == "registration_completed" and row["phase"] == "REGISTRATION_IN_PROGRESS":
            row = self.store.transition_claim(
                row["receipt"],
                ("REGISTRATION_IN_PROGRESS",),
                "REGISTRATION_COMPLETED",
                event_type="registration_completed",
                fields={"matrix_completed": 1},
            )
        elif row["phase"] != ("REGISTRATION_IN_PROGRESS" if stage == "registration_in_progress" else "REGISTRATION_COMPLETED"):
            raise IssuerError("Registration stage conflicts with durable state", HTTPStatus.CONFLICT, code="registration_stage_conflict")
        return {
            "schema": "neal.matrix-registration-stage-result/v2",
            "operationId": operation_id,
            "stage": stage,
        }


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
        if value == "local":
            return value
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return "untrusted"
        if address.version == 6:
            return f"{ipaddress.ip_network(f'{address}/64', strict=False).network_address}/64"
        return str(address)

    def origin_allowed(self) -> bool:
        return self.headers.get("Origin") == self.app.settings.public_origin

    def send_json(
        self,
        status: int,
        body: dict[str, Any],
        *,
        session: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        payload = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", self.app.settings.public_origin)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Vary", "Origin")
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        if session:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE_NAME}={session}; Max-Age={self.app.settings.session_ttl_seconds}; Path=/; Secure; HttpOnly; SameSite=Strict",
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
        routes = {
            "/v1/challenge", "/v1/verify", "/v1/access-token",
            "/v2/challenge", "/v2/verify", "/v2/access-token", "/v2/registration-stage",
        }
        if not self.origin_allowed() or self.path not in routes:
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
            self.send_json(HTTPStatus.OK, {"schema": "neal.health/v1", "status": "ok"})
        elif self.path == "/readyz":
            try:
                self.send_json(HTTPStatus.OK, self.app.ready())
            except IssuerError as error:
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {
                    "schema": "neal.issuer-readiness/v2",
                    "status": "unavailable",
                    "code": error.code,
                })
            except Exception as error:
                print(f"issuer readiness failed: {type(error).__name__}", file=sys.stderr)
                self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"status": "unavailable"})
        elif self.path == "/metrics":
            metrics = self.app.metrics()
            metrics["workers"] = {
                "active": getattr(self.server, "active_workers", 0),
                "capacity": 32,
            }
            self.send_json(HTTPStatus.OK, metrics)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self.origin_allowed():
                raise IssuerError("Origin is not allowed", HTTPStatus.FORBIDDEN)
            body = self.read_json()
            session = None
            status = HTTPStatus.OK
            if self.path in {"/v1/challenge", "/v2/challenge"}:
                result = self.app.challenge(body, self.client_key())
            elif self.path in {"/v1/verify", "/v2/verify"}:
                result, session = self.app.verify(body, self.client_key())
            elif self.path == "/v1/access-token":
                if body.get("schema") != "neal.matrix-access-token-request/v1":
                    raise IssuerError("Invalid access-token request")
                result = self.app.access_token(self.cookie(), self.client_key())
            elif self.path == "/v2/access-token":
                if body.get("schema") != "neal.matrix-access-token-request/v2":
                    raise IssuerError("Invalid access-token request", code="invalid_access_token_request")
                status, result = self.app.access_token_v2(self.cookie(), self.client_key())
            elif self.path == "/v2/registration-stage":
                result = self.app.registration_stage(self.cookie(), body)
            else:
                raise IssuerError("Route not found", HTTPStatus.NOT_FOUND)
            self.send_json(status, result, session=session, retry_after=2 if status == HTTPStatus.ACCEPTED else None)
        except IssuerError as error:
            self.send_json(error.status, {
                "schema": "neal.error/v1",
                "code": error.code,
                "message": str(error),
                "retryable": error.retryable,
                "operationId": error.operation_id,
            })
        except Exception:
            print("issuer request failed: internal_error", file=sys.stderr)
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "schema": "neal.error/v1",
                "code": "internal_error",
                "message": "Internal issuer error",
                "retryable": False,
                "operationId": None,
            })


class BoundedThreadingMixIn(socketserver.ThreadingMixIn):
    daemon_threads = True

    def __init__(self, *args: Any, **kwargs: Any):
        self.worker_slots = threading.BoundedSemaphore(32)
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
