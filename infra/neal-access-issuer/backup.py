#!/usr/bin/env python3
"""Authenticated, versioned encryption for NEAL issuer SQLite snapshots.

NEALBKP2 uses an off-host X25519 recovery key. The production issuer receives
only the public half. NEALBKP1 decoding remains for existing rehearsal data.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import getpass
import hashlib
import json
import os
import sqlite3
import stat
import struct
import tempfile
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


MAGIC = b"NEALBKP1"
MAGIC_V2 = b"NEALBKP2"
ENVELOPE_SCHEMA = "neal.encrypted-backup/v2"
SALT_BYTES = 16
NONCE_BYTES = 12
SCRYPT_N = 32_768
SCRYPT_R = 8
SCRYPT_P = 1
MAX_BACKUP_BYTES = 160 * 1024 * 1024
MAX_HEADER_BYTES = 16 * 1024
WRAP_INFO = b"neal-access-issuer/backup-data-key/v1"


class BackupError(RuntimeError):
    pass


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    if not isinstance(value, str) or len(value) > MAX_HEADER_BYTES:
        raise BackupError("Encrypted backup metadata is invalid")
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as error:
        raise BackupError("Encrypted backup metadata is invalid") from error


def _canonical_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _same_file(first: Path, second: Path) -> bool:
    if first.absolute() == second.absolute():
        return True
    try:
        return first.exists() and second.exists() and os.path.samefile(first, second)
    except OSError:
        return False


def _regular_file(path: Path, *, private: bool, label: str, maximum: int = 64 * 1024) -> bytes:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise BackupError(f"{label} is unavailable") from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise BackupError(f"{label} must be a regular, non-symlink file")
    if private and metadata.st_uid != os.geteuid():
        raise BackupError(f"{label} must be owned by the current user")
    if private and stat.S_IMODE(metadata.st_mode) != 0o600:
        raise BackupError(f"{label} mode must be exactly 0600")
    if metadata.st_size > maximum:
        raise BackupError(f"{label} is unexpectedly large")
    try:
        return path.read_bytes()
    except OSError as error:
        raise BackupError(f"{label} cannot be read") from error


def _passphrase(file: Path | None) -> bytes:
    if file is None:
        if not os.isatty(0):
            raise BackupError("Passphrase requires a TTY or --passphrase-file")
        value = getpass.getpass("Backup passphrase: ")
    else:
        try:
            value = _regular_file(file, private=True, label="Passphrase file", maximum=4096).decode(
                "utf-8"
            ).rstrip("\r\n")
        except UnicodeError as error:
            raise BackupError("Passphrase file cannot be read") from error
    if len(value) < 16:
        raise BackupError("Passphrase must contain at least 16 characters")
    return value.encode("utf-8")


def _derive(passphrase: bytes, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=32, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(passphrase)


def _atomic_write(destination: Path, payload: bytes, replace: bool, mode: int = 0o600) -> None:
    destination = destination.absolute()
    if destination.is_symlink():
        raise BackupError("Refusing to replace a symlink destination")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists() and not replace:
        raise BackupError(f"Refusing to replace existing file: {destination}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, mode)
        directory = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def _snapshot(database: Path) -> bytes:
    if database.is_symlink() or not database.is_file():
        raise BackupError("Issuer database does not exist")
    with tempfile.TemporaryDirectory(prefix="neal-issuer-snapshot-") as directory:
        snapshot = Path(directory) / "issuer.sqlite3"
        try:
            with contextlib.closing(sqlite3.connect(database)) as source, contextlib.closing(
                sqlite3.connect(snapshot)
            ) as target:
                source.backup(target)
                result = target.execute("PRAGMA integrity_check").fetchone()
                if not result or result[0] != "ok":
                    raise BackupError("SQLite online snapshot failed its integrity check")
        except sqlite3.Error as error:
            raise BackupError("SQLite online backup failed") from error
        if snapshot.stat().st_size > MAX_BACKUP_BYTES:
            raise BackupError("Issuer database exceeds the backup size limit")
        return snapshot.read_bytes()


def _load_public_key(path: Path) -> X25519PublicKey:
    try:
        key = serialization.load_pem_public_key(
            _regular_file(path, private=False, label="Recovery public key", maximum=4096)
        )
    except (ValueError, TypeError) as error:
        raise BackupError("Recovery public key is invalid") from error
    if not isinstance(key, X25519PublicKey):
        raise BackupError("Recovery public key must be X25519")
    return key


def _load_private_key(path: Path) -> X25519PrivateKey:
    try:
        key = serialization.load_pem_private_key(
            _regular_file(path, private=True, label="Recovery private key", maximum=4096), password=None
        )
    except (ValueError, TypeError) as error:
        raise BackupError("Recovery private key is invalid") from error
    if not isinstance(key, X25519PrivateKey):
        raise BackupError("Recovery private key must be X25519")
    return key


def recovery_key_fingerprint(key: X25519PublicKey) -> str:
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return hashlib.sha256(raw).hexdigest()


def generate_recovery_keypair(private_key: Path, public_key: Path, replace: bool = False) -> str:
    if _same_file(private_key, public_key):
        raise BackupError("Recovery private and public key paths must be different")
    key = X25519PrivateKey.generate()
    private_payload = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    public_payload = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    _atomic_write(private_key, private_payload, replace, mode=0o600)
    _atomic_write(public_key, public_payload, replace, mode=0o644)
    return recovery_key_fingerprint(key.public_key())


def create_backup(database: Path, output: Path, passphrase_file: Path | None, replace: bool = False) -> None:
    """Create a legacy v1 artifact for compatibility tests and old rehearsals."""
    if _same_file(database, output):
        raise BackupError("Backup input and output must be different files")
    plaintext = _snapshot(database.absolute())
    salt = os.urandom(SALT_BYTES)
    nonce = os.urandom(NONCE_BYTES)
    key = _derive(_passphrase(passphrase_file), salt)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, MAGIC)
    _atomic_write(output, MAGIC + salt + nonce + ciphertext, replace)


def create_envelope_backup(
    database: Path,
    output: Path,
    recipient_public_key: Path,
    *,
    source_commit: str,
    schema_version: int,
    ledger_generation: str,
    replace: bool = False,
    created_at: dt.datetime | None = None,
) -> dict[str, Any]:
    if _same_file(database, output):
        raise BackupError("Backup input and output must be different files")
    if len(source_commit) != 40 or any(character not in "0123456789abcdef" for character in source_commit):
        raise BackupError("Source commit must be a lowercase 40-character Git SHA")
    if schema_version < 1 or schema_version > 2**31 - 1:
        raise BackupError("Schema version is out of range")
    if not ledger_generation or len(ledger_generation) > 128:
        raise BackupError("Ledger generation is invalid")

    plaintext = _snapshot(database.absolute())
    recipient = _load_public_key(recipient_public_key)
    fingerprint = recovery_key_fingerprint(recipient)
    ephemeral = X25519PrivateKey.generate()
    ephemeral_public = ephemeral.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    shared = ephemeral.exchange(recipient)
    wrap_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=WRAP_INFO).derive(shared)
    data_key = os.urandom(32)
    wrap_nonce = os.urandom(NONCE_BYTES)
    wrap_aad = WRAP_INFO + b"\0" + fingerprint.encode("ascii")
    wrapped_key = AESGCM(wrap_key).encrypt(wrap_nonce, data_key, wrap_aad)
    data_nonce = os.urandom(NONCE_BYTES)
    timestamp = created_at or dt.datetime.now(dt.timezone.utc)
    if timestamp.tzinfo is None:
        raise BackupError("Backup creation time must include a timezone")
    header: dict[str, Any] = {
        "schema": ENVELOPE_SCHEMA,
        "createdAt": timestamp.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sourceCommit": source_commit,
        "databaseSchemaVersion": schema_version,
        "ledgerGeneration": ledger_generation,
        "recoveryKeyFingerprint": fingerprint,
        "ephemeralPublicKey": _b64(ephemeral_public),
        "wrappedKeyNonce": _b64(wrap_nonce),
        "wrappedKey": _b64(wrapped_key),
        "dataNonce": _b64(data_nonce),
        "plaintextBytes": len(plaintext),
        "plaintextSha256": hashlib.sha256(plaintext).hexdigest(),
    }
    header_bytes = _canonical_json(header)
    if len(header_bytes) > MAX_HEADER_BYTES:
        raise BackupError("Encrypted backup metadata exceeds the size limit")
    ciphertext = AESGCM(data_key).encrypt(data_nonce, plaintext, MAGIC_V2 + header_bytes)
    payload = MAGIC_V2 + struct.pack(">I", len(header_bytes)) + header_bytes + ciphertext
    _atomic_write(output, payload, replace)
    return {**header, "objectBytes": len(payload), "objectSha256": hashlib.sha256(payload).hexdigest()}


def _read_encrypted(source: Path) -> bytes:
    try:
        if source.is_symlink() or not source.is_file():
            raise BackupError("Encrypted backup is unavailable")
        if source.stat().st_size > MAX_BACKUP_BYTES + MAX_HEADER_BYTES + 4096:
            raise BackupError("Encrypted backup exceeds the size limit")
        return source.read_bytes()
    except OSError as error:
        raise BackupError("Encrypted backup is unavailable") from error


def _parse_v2(payload: bytes) -> tuple[dict[str, Any], bytes]:
    if len(payload) < len(MAGIC_V2) + 4 + 16:
        raise BackupError("Encrypted backup has an unsupported header")
    header_length = struct.unpack(">I", payload[len(MAGIC_V2) : len(MAGIC_V2) + 4])[0]
    if header_length < 2 or header_length > MAX_HEADER_BYTES:
        raise BackupError("Encrypted backup metadata exceeds the size limit")
    start = len(MAGIC_V2) + 4
    end = start + header_length
    if end + 16 > len(payload):
        raise BackupError("Encrypted backup is truncated")
    header_bytes = payload[start:end]
    try:
        header = json.loads(header_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackupError("Encrypted backup metadata is invalid") from error
    expected = {
        "schema", "createdAt", "sourceCommit", "databaseSchemaVersion", "ledgerGeneration",
        "recoveryKeyFingerprint", "ephemeralPublicKey", "wrappedKeyNonce", "wrappedKey",
        "dataNonce", "plaintextBytes", "plaintextSha256",
    }
    if not isinstance(header, dict) or set(header) != expected or header.get("schema") != ENVELOPE_SCHEMA:
        raise BackupError("Encrypted backup metadata contract is unsupported")
    if _canonical_json(header) != header_bytes:
        raise BackupError("Encrypted backup metadata is not canonical")
    return header, payload[end:]


def inspect_envelope(source: Path) -> dict[str, Any]:
    payload = _read_encrypted(source)
    if not payload.startswith(MAGIC_V2):
        raise BackupError("Encrypted backup is not a v2 recovery-key envelope")
    header, _ciphertext = _parse_v2(payload)
    return header


def _decrypt_v2(payload: bytes, private_key_file: Path) -> tuple[bytes, dict[str, Any]]:
    header, ciphertext = _parse_v2(payload)
    private_key = _load_private_key(private_key_file)
    fingerprint = recovery_key_fingerprint(private_key.public_key())
    if header["recoveryKeyFingerprint"] != fingerprint:
        raise BackupError("Recovery key fingerprint does not match the encrypted backup")
    try:
        ephemeral_public = X25519PublicKey.from_public_bytes(_unb64(header["ephemeralPublicKey"]))
        shared = private_key.exchange(ephemeral_public)
        wrap_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=WRAP_INFO).derive(shared)
        wrap_aad = WRAP_INFO + b"\0" + fingerprint.encode("ascii")
        data_key = AESGCM(wrap_key).decrypt(
            _unb64(header["wrappedKeyNonce"]), _unb64(header["wrappedKey"]), wrap_aad
        )
        plaintext = AESGCM(data_key).decrypt(
            _unb64(header["dataNonce"]), ciphertext, MAGIC_V2 + _canonical_json(header)
        )
    except (InvalidTag, ValueError) as error:
        raise BackupError("Encrypted backup authentication failed") from error
    if len(plaintext) != header["plaintextBytes"] or hashlib.sha256(plaintext).hexdigest() != header["plaintextSha256"]:
        raise BackupError("Encrypted backup plaintext digest does not match")
    return plaintext, header


def _decrypt_v1(payload: bytes, passphrase_file: Path | None) -> bytes:
    minimum = len(MAGIC) + SALT_BYTES + NONCE_BYTES + 16
    if len(payload) < minimum or payload[: len(MAGIC)] != MAGIC:
        raise BackupError("Encrypted backup has an unsupported header")
    offset = len(MAGIC)
    salt = payload[offset : offset + SALT_BYTES]
    offset += SALT_BYTES
    nonce = payload[offset : offset + NONCE_BYTES]
    ciphertext = payload[offset + NONCE_BYTES :]
    try:
        return AESGCM(_derive(_passphrase(passphrase_file), salt)).decrypt(nonce, ciphertext, MAGIC)
    except InvalidTag as error:
        raise BackupError("Encrypted backup authentication failed") from error


def decrypt_backup(
    source: Path, *, passphrase_file: Path | None = None, private_key_file: Path | None = None
) -> tuple[bytes, dict[str, Any] | None]:
    payload = _read_encrypted(source.resolve())
    if payload.startswith(MAGIC_V2):
        if private_key_file is None or passphrase_file is not None:
            raise BackupError("A recovery private key is required for a v2 encrypted backup")
        return _decrypt_v2(payload, private_key_file)
    if private_key_file is not None:
        raise BackupError("A passphrase is required for a legacy v1 encrypted backup")
    return _decrypt_v1(payload, passphrase_file), None


def validate_sqlite(plaintext: bytes) -> None:
    if not plaintext.startswith(b"SQLite format 3\0"):
        raise BackupError("Decrypted backup is not a SQLite database")
    with tempfile.TemporaryDirectory(prefix="neal-restore-verify-") as directory:
        database = Path(directory) / "issuer.sqlite3"
        database.write_bytes(plaintext)
        try:
            with contextlib.closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as restored:
                result = restored.execute("PRAGMA integrity_check").fetchone()
                if not result or result[0] != "ok":
                    raise BackupError("Restored SQLite database failed its integrity check")
        except sqlite3.Error as error:
            raise BackupError("Restored SQLite database is invalid") from error


def restore_backup(
    source: Path,
    database: Path,
    passphrase_file: Path | None = None,
    replace: bool = False,
    *,
    private_key_file: Path | None = None,
    reconciliation_marker: Path | None = None,
) -> dict[str, Any] | None:
    if _same_file(source, database):
        raise BackupError("Backup input and restored database must be different files")
    plaintext, metadata = decrypt_backup(
        source, passphrase_file=passphrase_file, private_key_file=private_key_file
    )
    validate_sqlite(plaintext)
    database = database.absolute()
    marker = reconciliation_marker or database.parent / "restore-reconciliation-required.json"
    marker_payload = {
        "schema": "neal.restore-reconciliation-marker/v1",
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "sourceCommit": metadata.get("sourceCommit") if metadata else None,
        "databaseSchemaVersion": metadata.get("databaseSchemaVersion") if metadata else None,
        "ledgerGeneration": metadata.get("ledgerGeneration") if metadata else None,
        "recoveryKeyFingerprint": metadata.get("recoveryKeyFingerprint") if metadata else None,
    }
    _atomic_write(marker, _canonical_json(marker_payload) + b"\n", replace=True, mode=0o600)
    if database.is_symlink():
        raise BackupError("Refusing to replace a symlink database")
    database.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{database.name}.", dir=database.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(plaintext)
            handle.flush()
            os.fsync(handle.fileno())
        if database.exists() and not replace:
            raise BackupError(f"Refusing to replace existing database: {database}")
        sidecars = [Path(f"{database}{suffix}") for suffix in ("-wal", "-shm")]
        if any(sidecar.exists() for sidecar in sidecars):
            raise BackupError(
                "Refusing restore while SQLite WAL/SHM sidecar files exist; stop and checkpoint the issuer first"
            )
        os.replace(temporary, database)
        os.chmod(database, 0o600)
        restored_descriptor = os.open(database, os.O_RDONLY)
        try:
            os.fsync(restored_descriptor)
        finally:
            os.close(restored_descriptor)
        directory_descriptor = os.open(database.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()
    return metadata


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    keypair = commands.add_parser("generate-keypair", help="create an off-host X25519 recovery keypair")
    keypair.add_argument("--private-key", type=Path, required=True)
    keypair.add_argument("--public-key", type=Path, required=True)
    keypair.add_argument("--replace", action="store_true")
    create = commands.add_parser("backup", help="create a public-key encrypted online SQLite backup")
    create.add_argument("--database", type=Path, required=True)
    create.add_argument("--output", type=Path, required=True)
    create_key = create.add_mutually_exclusive_group(required=True)
    create_key.add_argument("--recipient-public-key", type=Path)
    create_key.add_argument("--passphrase-file", type=Path, help="legacy v1 compatibility only")
    create.add_argument("--source-commit")
    create.add_argument("--schema-version", type=int)
    create.add_argument("--ledger-generation")
    create.add_argument("--replace", action="store_true")
    restore = commands.add_parser("restore", help="atomically restore an encrypted SQLite backup")
    restore.add_argument("--input", type=Path, required=True)
    restore.add_argument("--database", type=Path, required=True)
    restore_key = restore.add_mutually_exclusive_group(required=True)
    restore_key.add_argument("--private-key", type=Path)
    restore_key.add_argument("--passphrase-file", type=Path, help="legacy v1 compatibility only")
    restore.add_argument("--reconciliation-marker", type=Path)
    restore.add_argument("--replace", action="store_true")
    inspect = commands.add_parser("inspect", help="print non-sensitive v2 envelope metadata")
    inspect.add_argument("--input", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    if options.command == "generate-keypair":
        fingerprint = generate_recovery_keypair(options.private_key, options.public_key, options.replace)
        print(json.dumps({"schema": "neal.recovery-key/v1", "fingerprint": fingerprint}, sort_keys=True))
    elif options.command == "backup":
        if options.passphrase_file:
            if any(value is not None for value in (options.source_commit, options.schema_version, options.ledger_generation)):
                raise BackupError("Legacy v1 backup does not accept v2 metadata flags")
            create_backup(options.database, options.output, options.passphrase_file, options.replace)
            print(json.dumps({"schema": "neal.encrypted-backup/v1"}, sort_keys=True))
        else:
            if options.source_commit is None or options.schema_version is None or options.ledger_generation is None:
                raise BackupError("V2 backup requires source commit, schema version, and ledger generation")
            metadata = create_envelope_backup(
                options.database,
                options.output,
                options.recipient_public_key,
                source_commit=options.source_commit,
                schema_version=options.schema_version,
                ledger_generation=options.ledger_generation,
                replace=options.replace,
            )
            print(json.dumps(metadata, sort_keys=True))
    elif options.command == "restore":
        metadata = restore_backup(
            options.input,
            options.database,
            passphrase_file=options.passphrase_file,
            replace=options.replace,
            private_key_file=options.private_key,
            reconciliation_marker=options.reconciliation_marker,
        )
        print(json.dumps(metadata, sort_keys=True))
    else:
        print(json.dumps(inspect_envelope(options.input), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BackupError, OSError, ValueError) as error:
        print(f"error: {error}", file=os.sys.stderr)
        raise SystemExit(1)
