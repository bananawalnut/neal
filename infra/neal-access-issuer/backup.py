#!/usr/bin/env python3
"""Encrypted online backup and atomic restore for the access issuer ledger."""

from __future__ import annotations

import argparse
import getpass
import os
import sqlite3
import stat
import tempfile
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt


MAGIC = b"NEALBKP1"
SALT_BYTES = 16
NONCE_BYTES = 12
SCRYPT_N = 32_768
SCRYPT_R = 8
SCRYPT_P = 1
MAX_BACKUP_BYTES = 160 * 1024 * 1024


class BackupError(RuntimeError):
    pass


def _same_file(first: Path, second: Path) -> bool:
    """Return true for the same lexical path or existing filesystem object."""
    if first.absolute() == second.absolute():
        return True
    try:
        return first.exists() and second.exists() and os.path.samefile(first, second)
    except OSError:
        return False


def _passphrase(file: Path | None) -> bytes:
    if file is None:
        if not os.isatty(0):
            raise BackupError("Passphrase requires a TTY or --passphrase-file")
        value = getpass.getpass("Backup passphrase: ")
    else:
        try:
            metadata = file.lstat()
        except OSError as error:
            raise BackupError("Passphrase file is unavailable") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise BackupError("Passphrase file must be a regular, non-symlink file")
        if metadata.st_uid != os.geteuid():
            raise BackupError("Passphrase file must be owned by the current user")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise BackupError("Passphrase file mode must be exactly 0600")
        if metadata.st_size > 4096:
            raise BackupError("Passphrase file is unexpectedly large")
        try:
            value = file.read_text(encoding="utf-8").rstrip("\r\n")
        except (OSError, UnicodeError) as error:
            raise BackupError("Passphrase file cannot be read") from error
    if len(value) < 16:
        raise BackupError("Passphrase must contain at least 16 characters")
    return value.encode("utf-8")


def _derive(passphrase: bytes, salt: bytes) -> bytes:
    return Scrypt(salt=salt, length=32, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P).derive(passphrase)


def _atomic_write(destination: Path, payload: bytes, replace: bool) -> None:
    destination = destination.absolute()
    if destination.is_symlink():
        raise BackupError("Refusing to replace a symlink destination")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists() and not replace:
        raise BackupError(f"Refusing to replace existing file: {destination}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        os.chmod(destination, 0o600)
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
            with sqlite3.connect(database) as source, sqlite3.connect(snapshot) as target:
                source.backup(target)
                result = target.execute("PRAGMA integrity_check").fetchone()
                if not result or result[0] != "ok":
                    raise BackupError("SQLite online snapshot failed its integrity check")
        except sqlite3.Error as error:
            raise BackupError("SQLite online backup failed") from error
        if snapshot.stat().st_size > MAX_BACKUP_BYTES:
            raise BackupError("Issuer database exceeds the backup size limit")
        return snapshot.read_bytes()


def create_backup(database: Path, output: Path, passphrase_file: Path | None, replace: bool = False) -> None:
    if _same_file(database, output):
        raise BackupError("Backup input and output must be different files")
    plaintext = _snapshot(database.absolute())
    salt = os.urandom(SALT_BYTES)
    nonce = os.urandom(NONCE_BYTES)
    key = _derive(_passphrase(passphrase_file), salt)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, MAGIC)
    _atomic_write(output, MAGIC + salt + nonce + ciphertext, replace)


def _decrypt(source: Path, passphrase_file: Path | None) -> bytes:
    try:
        if source.stat().st_size > MAX_BACKUP_BYTES + 1024:
            raise BackupError("Encrypted backup exceeds the size limit")
        payload = source.read_bytes()
    except OSError as error:
        raise BackupError("Encrypted backup is unavailable") from error
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


def restore_backup(source: Path, database: Path, passphrase_file: Path | None, replace: bool = False) -> None:
    if _same_file(source, database):
        raise BackupError("Backup input and restored database must be different files")
    plaintext = _decrypt(source.resolve(), passphrase_file)
    if not plaintext.startswith(b"SQLite format 3\0"):
        raise BackupError("Decrypted backup is not a SQLite database")
    database = database.absolute()
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
        try:
            with sqlite3.connect(f"file:{temporary}?mode=ro", uri=True) as restored:
                result = restored.execute("PRAGMA integrity_check").fetchone()
                if not result or result[0] != "ok":
                    raise BackupError("Restored SQLite database failed its integrity check")
        except sqlite3.Error as error:
            raise BackupError("Restored SQLite database is invalid") from error
        if database.exists() and not replace:
            raise BackupError(f"Refusing to replace existing database: {database}")
        sidecars = [Path(f"{database}{suffix}") for suffix in ("-wal", "-shm")]
        if any(sidecar.exists() for sidecar in sidecars):
            raise BackupError("Refusing restore while SQLite WAL/SHM sidecar files exist; stop and checkpoint the issuer first")
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    backup = commands.add_parser("backup", help="create an encrypted online SQLite backup")
    backup.add_argument("--database", type=Path, required=True)
    backup.add_argument("--output", type=Path, required=True)
    backup.add_argument("--passphrase-file", type=Path)
    backup.add_argument("--replace", action="store_true")
    restore = commands.add_parser("restore", help="atomically restore an encrypted SQLite backup")
    restore.add_argument("--input", type=Path, required=True)
    restore.add_argument("--database", type=Path, required=True)
    restore.add_argument("--passphrase-file", type=Path)
    restore.add_argument("--replace", action="store_true")
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    if options.command == "backup":
        create_backup(options.database, options.output, options.passphrase_file, options.replace)
    else:
        restore_backup(options.input, options.database, options.passphrase_file, options.replace)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BackupError, OSError, ValueError) as error:
        print(f"error: {error}", file=os.sys.stderr)
        raise SystemExit(1)
