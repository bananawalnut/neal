#!/usr/bin/env python3
"""Upload immutable encrypted issuer snapshots and verify off-host restoration."""

from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import backup


TARGET_SCHEMA = "neal.s3-backup-target/v1"
UPLOAD_MODE = "append-only-upload"
RESTORE_MODE = "read-only-restore"
RECEIPT_SCHEMA = "neal.s3-backup-receipt/v1"
VERIFY_SCHEMA = "neal.s3-restore-verification/v1"
HEALTH_SCHEMA = "neal.backup-health/v1"
MIN_RETENTION_DAYS = 30
MAX_OBJECT_BYTES = backup.MAX_BACKUP_BYTES + backup.MAX_HEADER_BYTES + 4096
DEFAULT_UPLOAD_MAX_AGE_SECONDS = 24 * 60 * 60
DEFAULT_RESTORE_MAX_AGE_SECONDS = 35 * 24 * 60 * 60


class S3BackupError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True)
class S3Target:
    endpoint_url: str
    region: str
    bucket: str
    prefix: str
    access_key_id: str
    secret_access_key: str
    session_token: str | None
    retention_days: int
    credential_mode: str
    addressing_style: str


def _load_private_json(path: Path, label: str) -> dict[str, Any]:
    raw = backup._regular_file(path, private=True, label=label, maximum=32 * 1024)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise S3BackupError(f"{label} is not valid JSON") from error
    if not isinstance(value, dict):
        raise S3BackupError(f"{label} must contain a JSON object")
    return value


def load_target(path: Path, required_mode: str | None = None) -> S3Target:
    value = _load_private_json(path, "S3 target credential")
    expected = {
        "schema",
        "endpointUrl",
        "region",
        "bucket",
        "prefix",
        "accessKeyId",
        "secretAccessKey",
        "sessionToken",
        "retentionDays",
        "credentialMode",
        "addressingStyle",
    }
    if set(value) != expected or value.get("schema") != TARGET_SCHEMA:
        raise S3BackupError("S3 target credential does not match neal.s3-backup-target/v1")
    endpoint = value.get("endpointUrl")
    parsed = urlsplit(endpoint) if isinstance(endpoint, str) else None
    if (
        parsed is None
        or parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise S3BackupError("S3 endpoint must be an HTTPS origin without embedded credentials")
    for key in ("region", "bucket", "accessKeyId", "secretAccessKey"):
        if not isinstance(value.get(key), str) or not value[key] or len(value[key]) > 512:
            raise S3BackupError(f"S3 target field {key} is invalid")
    prefix = value.get("prefix")
    if not isinstance(prefix, str) or not prefix or len(prefix) > 512 or prefix.startswith("/") or ".." in prefix.split("/"):
        raise S3BackupError("S3 target prefix is invalid")
    if not re.fullmatch(r"[A-Za-z0-9!_.*'()/=-]+", prefix):
        raise S3BackupError("S3 target prefix contains unsupported characters")
    session_token = value.get("sessionToken")
    if session_token is not None and (not isinstance(session_token, str) or not session_token):
        raise S3BackupError("S3 session token must be null or a non-empty string")
    retention = value.get("retentionDays")
    if not isinstance(retention, int) or isinstance(retention, bool) or retention < MIN_RETENTION_DAYS or retention > 3650:
        raise S3BackupError(f"S3 immutable retention must be {MIN_RETENTION_DAYS} to 3650 days")
    mode = value.get("credentialMode")
    if mode not in (UPLOAD_MODE, RESTORE_MODE):
        raise S3BackupError("S3 credential mode is unsupported")
    if required_mode is not None and mode != required_mode:
        raise S3BackupError(f"This operation requires {required_mode} credentials")
    addressing_style = value.get("addressingStyle")
    if addressing_style not in ("virtual", "path"):
        raise S3BackupError("S3 addressingStyle must be virtual or path")
    return S3Target(
        endpoint_url=endpoint.rstrip("/"),
        region=value["region"],
        bucket=value["bucket"],
        prefix=prefix.rstrip("/"),
        access_key_id=value["accessKeyId"],
        secret_access_key=value["secretAccessKey"],
        session_token=session_token,
        retention_days=retention,
        credential_mode=mode,
        addressing_style=addressing_style,
    )


def s3_client(target: S3Target) -> Any:
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise S3BackupError("boto3 and botocore are required for S3 backup operations") from error
    return boto3.client(
        "s3",
        endpoint_url=target.endpoint_url,
        region_name=target.region,
        aws_access_key_id=target.access_key_id,
        aws_secret_access_key=target.secret_access_key,
        aws_session_token=target.session_token,
        config=Config(
            signature_version="s3v4",
            connect_timeout=5,
            read_timeout=30,
            retries={"max_attempts": 3, "mode": "standard"},
            s3={"addressing_style": target.addressing_style},
        ),
    )


def require_bucket_protection(client: Any, target: S3Target) -> dict[str, Any]:
    try:
        versioning = client.get_bucket_versioning(Bucket=target.bucket)
        lock = client.get_object_lock_configuration(Bucket=target.bucket)
    except Exception as error:
        raise S3BackupError("Unable to verify S3 bucket versioning and object-lock policy") from error
    if versioning.get("Status") != "Enabled":
        raise S3BackupError("S3 bucket versioning must be Enabled")
    configuration = lock.get("ObjectLockConfiguration", {})
    if configuration.get("ObjectLockEnabled") != "Enabled":
        raise S3BackupError("S3 Object Lock must be Enabled")
    retention = configuration.get("Rule", {}).get("DefaultRetention", {})
    if retention.get("Mode") != "COMPLIANCE":
        raise S3BackupError("S3 default retention must use COMPLIANCE mode")
    configured_days = retention.get("Days")
    if configured_days is None and isinstance(retention.get("Years"), int):
        configured_days = retention["Years"] * 365
    if not isinstance(configured_days, int) or configured_days < target.retention_days:
        raise S3BackupError("S3 default immutable retention is shorter than the configured requirement")
    return {
        "versioning": "Enabled",
        "objectLockMode": "COMPLIANCE",
        "defaultRetentionDays": configured_days,
    }


def _is_access_denied(error: Exception) -> bool:
    response = getattr(error, "response", None)
    if not isinstance(response, dict):
        return False
    code = str(response.get("Error", {}).get("Code", ""))
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in {"AccessDenied", "AllAccessDisabled", "Unauthorized"} or status in {401, 403}


def require_append_only_listing_denied(client: Any, target: S3Target) -> None:
    try:
        client.list_object_versions(Bucket=target.bucket, Prefix=f"{target.prefix}/", MaxKeys=1)
    except Exception as error:
        if _is_access_denied(error):
            return
        raise S3BackupError("Unable to prove that upload credentials deny object listing") from error
    raise S3BackupError("Upload credentials are not append-only: object listing is allowed")


def require_uploaded_object_read_denied(
    client: Any, target: S3Target, key: str, version_id: str
) -> None:
    try:
        response = client.get_object(
            Bucket=target.bucket,
            Key=key,
            VersionId=version_id,
            Range="bytes=0-0",
        )
    except Exception as error:
        if _is_access_denied(error):
            return
        raise S3BackupError("Unable to prove that upload credentials deny object reads") from error
    body = response.get("Body") if isinstance(response, dict) else None
    if body is not None and hasattr(body, "close"):
        body.close()
    raise S3BackupError("Upload credentials are not append-only: uploaded objects are readable")


def _object_key(target: S3Target, metadata: dict[str, Any]) -> str:
    created = dt.datetime.fromisoformat(metadata["createdAt"].replace("Z", "+00:00"))
    generation = re.sub(r"[^A-Za-z0-9._-]", "_", metadata["ledgerGeneration"])
    return (
        f"{target.prefix}/{created:%Y/%m/%d}/"
        f"issuer-{generation}-{metadata['objectSha256'][:20]}.nealbak"
    )


def upload_snapshot(
    target: S3Target,
    client: Any,
    database: Path,
    recipient_public_key: Path,
    *,
    source_commit: str,
    schema_version: int,
    ledger_generation: str,
) -> dict[str, Any]:
    if target.credential_mode != UPLOAD_MODE:
        raise S3BackupError(f"This operation requires {UPLOAD_MODE} credentials")
    protection = require_bucket_protection(client, target)
    require_append_only_listing_denied(client, target)
    with tempfile.TemporaryDirectory(prefix="neal-encrypted-backup-") as directory:
        encrypted = Path(directory) / "issuer.nealbak"
        metadata = backup.create_envelope_backup(
            database,
            encrypted,
            recipient_public_key,
            source_commit=source_commit,
            schema_version=schema_version,
            ledger_generation=ledger_generation,
        )
        key = _object_key(target, metadata)
        retain_until = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=target.retention_days)
        digest = hashlib.sha256(encrypted.read_bytes()).digest()
        try:
            with encrypted.open("rb") as handle:
                response = client.put_object(
                    Bucket=target.bucket,
                    Key=key,
                    Body=handle,
                    ContentLength=encrypted.stat().st_size,
                    ContentType="application/vnd.neal.encrypted-backup",
                    ChecksumSHA256=base64.b64encode(digest).decode("ascii"),
                    ObjectLockMode="COMPLIANCE",
                    ObjectLockRetainUntilDate=retain_until,
                    Metadata={
                        "schema": "neal-encrypted-backup-v2",
                        "source-commit": source_commit,
                        "recovery-key-fingerprint": metadata["recoveryKeyFingerprint"],
                        "ledger-generation": ledger_generation,
                    },
                )
        except Exception as error:
            raise S3BackupError("S3 immutable upload failed") from error
    version_id = response.get("VersionId")
    if not isinstance(version_id, str) or not version_id:
        raise S3BackupError("S3 upload did not return a version ID; versioning cannot be proven")
    require_uploaded_object_read_denied(client, target, key, version_id)
    return {
        "schema": RECEIPT_SCHEMA,
        "createdAt": metadata["createdAt"],
        "bucket": target.bucket,
        "objectKey": key,
        "versionId": version_id,
        "objectSha256": metadata["objectSha256"],
        "objectBytes": metadata["objectBytes"],
        "sourceCommit": source_commit,
        "databaseSchemaVersion": schema_version,
        "ledgerGeneration": ledger_generation,
        "recoveryKeyFingerprint": metadata["recoveryKeyFingerprint"],
        "retainUntil": retain_until.isoformat(timespec="seconds").replace("+00:00", "Z"),
        **protection,
    }


def _latest_version(client: Any, target: S3Target) -> tuple[str, str]:
    try:
        response = client.list_object_versions(Bucket=target.bucket, Prefix=f"{target.prefix}/", MaxKeys=1000)
    except Exception as error:
        raise S3BackupError("Unable to list immutable backup versions with restore credentials") from error
    candidates = [
        value
        for value in response.get("Versions", [])
        if value.get("IsLatest") and isinstance(value.get("Key"), str) and value["Key"].endswith(".nealbak")
    ]
    if not candidates:
        raise S3BackupError("No immutable backup object is available for restore verification")
    candidates.sort(key=lambda value: value.get("LastModified", dt.datetime.min.replace(tzinfo=dt.timezone.utc)))
    latest = candidates[-1]
    return latest["Key"], latest["VersionId"]


def verify_restore(
    target: S3Target,
    client: Any,
    private_key: Path,
    *,
    object_key: str | None = None,
    version_id: str | None = None,
) -> dict[str, Any]:
    if target.credential_mode != RESTORE_MODE:
        raise S3BackupError(f"This operation requires {RESTORE_MODE} credentials")
    protection = require_bucket_protection(client, target)
    if (object_key is None) != (version_id is None):
        raise S3BackupError("Object key and version ID must be supplied together")
    if object_key is None:
        object_key, version_id = _latest_version(client, target)
    if not object_key.startswith(f"{target.prefix}/") or not object_key.endswith(".nealbak"):
        raise S3BackupError("Restore object is outside the configured backup prefix")
    with tempfile.TemporaryDirectory(prefix="neal-restore-drill-") as directory:
        encrypted = Path(directory) / "issuer.nealbak"
        try:
            response = client.get_object(Bucket=target.bucket, Key=object_key, VersionId=version_id)
            content_length = response.get("ContentLength")
            if not isinstance(content_length, int) or content_length < 1 or content_length > MAX_OBJECT_BYTES:
                raise S3BackupError("Restore object size is invalid")
            body = response["Body"]
            payload = body.read(MAX_OBJECT_BYTES + 1)
        except S3BackupError:
            raise
        except Exception as error:
            raise S3BackupError("Unable to download the selected immutable backup version") from error
        if len(payload) != content_length or len(payload) > MAX_OBJECT_BYTES:
            raise S3BackupError("Restore object is truncated or exceeds the size limit")
        encrypted.write_bytes(payload)
        plaintext, metadata = backup.decrypt_backup(encrypted, private_key_file=private_key)
        backup.validate_sqlite(plaintext)
        object_digest = hashlib.sha256(payload).hexdigest()
    return {
        "schema": VERIFY_SCHEMA,
        "verifiedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "bucket": target.bucket,
        "objectKey": object_key,
        "versionId": version_id,
        "objectSha256": object_digest,
        "sourceCommit": metadata["sourceCommit"],
        "databaseSchemaVersion": metadata["databaseSchemaVersion"],
        "ledgerGeneration": metadata["ledgerGeneration"],
        "recoveryKeyFingerprint": metadata["recoveryKeyFingerprint"],
        "sqliteIntegrity": "ok",
        **protection,
    }


def check_receipt_age(
    receipt: dict[str, Any],
    kind: str,
    *,
    now: dt.datetime | None = None,
    max_age_seconds: int | None = None,
) -> dict[str, Any]:
    contracts = {
        "upload": (RECEIPT_SCHEMA, "createdAt", DEFAULT_UPLOAD_MAX_AGE_SECONDS),
        "restore": (VERIFY_SCHEMA, "verifiedAt", DEFAULT_RESTORE_MAX_AGE_SECONDS),
    }
    if kind not in contracts:
        raise S3BackupError("Receipt kind must be upload or restore")
    schema, timestamp_key, default_max_age = contracts[kind]
    if receipt.get("schema") != schema:
        raise S3BackupError(f"{kind} receipt schema is invalid")
    raw_timestamp = receipt.get(timestamp_key)
    if not isinstance(raw_timestamp, str):
        raise S3BackupError(f"{kind} receipt timestamp is missing")
    try:
        timestamp = dt.datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise S3BackupError(f"{kind} receipt timestamp is invalid") from error
    if timestamp.tzinfo is None:
        raise S3BackupError(f"{kind} receipt timestamp must include a timezone")
    checked_at = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    age_seconds = int((checked_at - timestamp.astimezone(dt.timezone.utc)).total_seconds())
    if age_seconds < -300:
        raise S3BackupError(f"{kind} receipt timestamp is in the future")
    limit = default_max_age if max_age_seconds is None else max_age_seconds
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 60:
        raise S3BackupError("Receipt maximum age must be at least 60 seconds")
    if age_seconds > limit:
        raise S3BackupError(f"{kind} receipt is stale")
    return {
        "schema": HEALTH_SCHEMA,
        "status": "ok",
        "kind": kind,
        "checkedAt": checked_at.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "receiptTimestamp": timestamp.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "ageSeconds": max(0, age_seconds),
        "maximumAgeSeconds": limit,
    }


def _write_receipt(path: Path | None, value: dict[str, Any]) -> None:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    if path is None:
        print(encoded.decode("utf-8"), end="")
    else:
        backup._atomic_write(path, encoded, replace=True, mode=0o600)


def _load_receipt(path: Path) -> dict[str, Any]:
    raw = backup._regular_file(path, private=True, label="Backup receipt", maximum=32 * 1024)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise S3BackupError("Backup receipt is not valid JSON") from error
    if not isinstance(value, dict):
        raise S3BackupError("Backup receipt must contain a JSON object")
    return value


def _text_file(path: Path, label: str) -> str:
    try:
        metadata = path.lstat()
        if path.is_symlink() or not path.is_file() or metadata.st_size > 4096:
            raise S3BackupError(f"{label} must be a small regular, non-symlink file")
        value = path.read_text(encoding="ascii").strip()
    except (OSError, UnicodeError) as error:
        raise S3BackupError(f"{label} is unavailable") from error
    if not value:
        raise S3BackupError(f"{label} is empty")
    return value


def _database_metadata(database: Path) -> tuple[int, str]:
    import sqlite3

    try:
        with contextlib.closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as connection:
            value = connection.execute("PRAGMA user_version").fetchone()[0]
            generation_row = connection.execute(
                "SELECT value FROM schema_metadata WHERE key = 'ledger_generation'"
            ).fetchone()
    except sqlite3.Error as error:
        raise S3BackupError("Unable to read the issuer database schema version") from error
    if not isinstance(value, int) or value < 1:
        raise S3BackupError("Issuer database schema version is not initialized")
    if not generation_row or not isinstance(generation_row[0], str) or not generation_row[0]:
        raise S3BackupError("Issuer ledger generation is not initialized")
    return value, generation_row[0]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    generation = commands.add_parser(
        "init-ledger-generation", help="create one durable random ledger-generation identifier"
    )
    generation.add_argument("--output", type=Path, required=True)
    check = commands.add_parser("check-target", help="verify versioning and immutable COMPLIANCE retention")
    check.add_argument("--target-credential", type=Path, required=True)
    upload = commands.add_parser("upload", help="encrypt a snapshot locally and append it to S3")
    upload.add_argument("--target-credential", type=Path, required=True)
    upload.add_argument("--recipient-public-key", type=Path, required=True)
    upload.add_argument("--database", type=Path, required=True)
    source = upload.add_mutually_exclusive_group(required=True)
    source.add_argument("--source-commit")
    source.add_argument("--source-commit-file", type=Path)
    upload.add_argument("--schema-version", type=int)
    ledger = upload.add_mutually_exclusive_group()
    ledger.add_argument("--ledger-generation")
    ledger.add_argument("--ledger-generation-file", type=Path)
    upload.add_argument("--receipt-output", type=Path)
    verify = commands.add_parser("verify-restore", help="download, decrypt, and integrity-check off-host")
    verify.add_argument("--target-credential", type=Path, required=True)
    verify.add_argument("--private-key", type=Path, required=True)
    verify.add_argument("--object-key")
    verify.add_argument("--version-id")
    verify.add_argument("--receipt-output", type=Path)
    health = commands.add_parser("check-receipt", help="fail when upload or restore evidence is stale")
    health.add_argument("--kind", choices=("upload", "restore"), required=True)
    health.add_argument("--receipt", type=Path, required=True)
    health.add_argument("--max-age-seconds", type=int)
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    if options.command == "init-ledger-generation":
        value = secrets.token_hex(16)
        backup._atomic_write(options.output, f"{value}\n".encode("ascii"), replace=False, mode=0o600)
        print(json.dumps({"schema": "neal.ledger-generation/v1", "generation": value}, sort_keys=True))
        return 0
    if options.command == "check-receipt":
        result = check_receipt_age(
            _load_receipt(options.receipt),
            options.kind,
            max_age_seconds=options.max_age_seconds,
        )
        print(json.dumps(result, sort_keys=True))
        return 0
    required_mode = None
    if options.command == "upload":
        required_mode = UPLOAD_MODE
    elif options.command == "verify-restore":
        required_mode = RESTORE_MODE
    target = load_target(options.target_credential, required_mode)
    client = s3_client(target)
    if options.command == "check-target":
        print(json.dumps(require_bucket_protection(client, target), sort_keys=True))
    elif options.command == "upload":
        source_commit = options.source_commit or _text_file(options.source_commit_file, "Source commit file")
        database_schema, database_generation = _database_metadata(options.database)
        ledger_generation = options.ledger_generation or (
            _text_file(options.ledger_generation_file, "Ledger generation file")
            if options.ledger_generation_file
            else database_generation
        )
        schema_version = options.schema_version or database_schema
        receipt = upload_snapshot(
            target,
            client,
            options.database,
            options.recipient_public_key,
            source_commit=source_commit,
            schema_version=schema_version,
            ledger_generation=ledger_generation,
        )
        _write_receipt(options.receipt_output, receipt)
    else:
        receipt = verify_restore(
            target,
            client,
            options.private_key,
            object_key=options.object_key,
            version_id=options.version_id,
        )
        _write_receipt(options.receipt_output, receipt)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (backup.BackupError, S3BackupError, OSError, ValueError) as error:
        print(f"error: {error}", file=os.sys.stderr)
        raise SystemExit(1)
