#!/usr/bin/env python3
"""Operator-only claim, administrator, and post-restore reconciliation."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import backup as backup_tool
from issuer import Application, IssuerError, MatrixIssuer, Settings, Store


def load_environment(path: Path) -> None:
    if not path.is_file():
        return
    for number, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if separator != "=" or not name.startswith("NEAL_ACCESS_") or not name.replace("_", "").isalnum():
            raise IssuerError(f"Invalid environment entry on line {number}")
        os.environ.setdefault(name, value)


def sanitized_claim(row: Any) -> dict[str, Any]:
    return {
        key: row[key]
        for key in (
            "operation_id",
            "receipt",
            "phase",
            "attention_required",
            "config_address",
            "config_revision",
            "chain_signature",
            "recovery_key_version",
            "token_generation",
            "expires_at_ms",
            "matrix_pending",
            "matrix_completed",
            "created_at",
            "updated_at",
            "last_error_code",
        )
    }


def inspect_operation(store: Store, operation_id: str) -> dict[str, Any]:
    row = store.claim_by_operation(operation_id)
    with store.connection() as database:
        events = database.execute(
            """SELECT previous_phase, next_phase, event_type, created_at, metadata_json,
                      previous_hash, event_hash
               FROM claim_events WHERE operation_id = ? ORDER BY event_id""",
            (operation_id,),
        ).fetchall()
        admins = database.execute(
            """SELECT operation_id, expected_user_id, purpose, state, created_at,
                      updated_at, last_error_code
               FROM admin_operations WHERE related_claim_id = ? ORDER BY created_at""",
            (operation_id,),
        ).fetchall()
    return {
        "schema": "neal.reconciliation-inspection/v1",
        "claim": sanitized_claim(row),
        "events": [{**dict(event), "metadata": json.loads(event["metadata_json"])} for event in events],
        "administrators": [dict(admin) for admin in admins],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment-file", default="/etc/neal-access-issuer.env")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--list", action="store_true", help="list claims and unresolved administrator work")
    action.add_argument("--inspect", metavar="OPERATION_ID")
    action.add_argument("--resume", metavar="OPERATION_ID")
    action.add_argument("--cancel-before-consumption", metavar="OPERATION_ID")
    action.add_argument("--revoke-and-replace", metavar="OPERATION_ID")
    action.add_argument("--post-restore", action="store_true")
    action.add_argument("--user-id", help="legacy-compatible exact temporary-administrator reconciliation")
    options = parser.parse_args()

    load_environment(Path(options.environment_file))
    settings = Settings.from_environment()
    store = Store(settings.database)
    store.set_matrix_server_name(settings.matrix_server_name)

    if options.list:
        print(json.dumps({
            "schema": "neal.reconciliation-list/v1",
            "claims": store.operation_summaries(),
            "administrators": store.pending_admin_cleanups(),
        }, indent=2, sort_keys=True))
        return 0
    if options.inspect:
        print(json.dumps(inspect_operation(store, options.inspect), indent=2, sort_keys=True))
        return 0
    if options.user_id:
        MatrixIssuer(settings, store).reconcile_admin_cleanup(options.user_id)
        print(json.dumps({
            "schema": "neal.admin-reconciliation-result/v1",
            "reconciled": options.user_id,
            "pendingCount": store.unresolved_admin_cleanups(),
        }, sort_keys=True))
        return 0
    if options.cancel_before_consumption:
        row = store.claim_by_operation(options.cancel_before_consumption)
        if row["phase"] != "RESERVED" or row["signed_transaction"] is not None or row["chain_signature"] is not None:
            raise IssuerError("Only an unsubmitted RESERVED claim can be cancelled")
        row = store.transition_claim(
            row["receipt"],
            ("RESERVED",),
            "CANCELLED_BEFORE_CONSUMPTION",
            event_type="operator_cancelled_before_consumption",
            fields={"attention_required": 0, "last_error_code": None},
        )
        print(json.dumps({"schema": "neal.claim-cancellation/v1", "claim": sanitized_claim(row)}, sort_keys=True))
        return 0

    app = Application(settings)
    if options.resume:
        row = app.store.claim_by_operation(options.resume)
        app.store.clear_claim_attention(row["receipt"])
        row = app.store.claim_by_operation(options.resume)
        status, result = app.advance_claim(row, row["address"])
        result.pop("token", None)
        print(json.dumps({
            "schema": "neal.claim-resume-result/v1",
            "httpStatus": int(status),
            "result": result,
            "claim": sanitized_claim(app.store.claim_by_operation(options.resume)),
        }, sort_keys=True))
        return 0
    if options.revoke_and_replace:
        row = app.store.claim_by_operation(options.revoke_and_replace)
        if row["phase"] not in {"TOKEN_READY", "REGISTRATION_IN_PROGRESS"}:
            raise IssuerError("Claim is not eligible for token replacement")
        current_token = app.derive_registration_token(row)
        app.matrix.revoke_unused_registration_token(current_token)
        replacement = app.store.reserve_token_replacement(row["receipt"])
        replacement_token = app.derive_registration_token(replacement)
        token, expires_at_ms = app.matrix.issue(replacement_token, replacement["operation_id"])
        app.store.complete_token_replacement(row["receipt"], token, expires_at_ms)
        print(json.dumps({
            "schema": "neal.token-replacement-result/v1",
            "operationId": row["operation_id"],
            "generation": replacement["token_generation"],
            "expiresAt": expires_at_ms,
        }, sort_keys=True))
        return 0
    if options.post_restore:
        marker = settings.database.parent / "restore-reconciliation-required.json"
        if not marker.is_file():
            raise IssuerError("No post-restore reconciliation marker is present")
        try:
            marker_value = json.loads(marker.read_text())
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise IssuerError("Post-restore reconciliation marker is invalid") from error
        expected_marker_fields = {
            "schema", "createdAt", "sourceCommit", "databaseSchemaVersion",
            "ledgerGeneration", "recoveryKeyFingerprint",
        }
        if (
            not isinstance(marker_value, dict)
            or set(marker_value) != expected_marker_fields
            or marker_value.get("schema") != "neal.restore-reconciliation-marker/v1"
        ):
            raise IssuerError("Post-restore reconciliation marker contract is unsupported")
        with store.connection() as database:
            schema_version = database.execute("PRAGMA user_version").fetchone()[0]
        if marker_value["databaseSchemaVersion"] is not None and marker_value["databaseSchemaVersion"] != schema_version:
            raise IssuerError("Restored database schema does not match its authenticated backup metadata")
        if marker_value["ledgerGeneration"] is not None and marker_value["ledgerGeneration"] != store.ledger_generation():
            raise IssuerError("Restored ledger generation does not match its authenticated backup metadata")
        if marker_value["recoveryKeyFingerprint"] is not None:
            public_key_path = os.environ.get("NEAL_ACCESS_BACKUP_RECOVERY_PUBLIC_KEY_FILE", "").strip()
            if not public_key_path:
                raise IssuerError("Backup recovery public key is required for post-restore reconciliation")
            fingerprint = backup_tool.recovery_key_fingerprint(
                backup_tool._load_public_key(Path(public_key_path))
            )
            if fingerprint != marker_value["recoveryKeyFingerprint"]:
                raise IssuerError("Backup recovery key fingerprint does not match the restored metadata")
        if app.startup_admin_scan_error:
            raise IssuerError("Reserved administrator scan requires operator action")
        for summary in app.store.operation_summaries():
            if summary["phase"] in {"MATRIX_TOKEN_ENSURING", "ADMIN_CLEANUP_PENDING"} or summary["attention_required"]:
                raise IssuerError("A claim requires reconciliation before readiness")
        app.solana.config()
        app.matrix.ready()
        marker.unlink()
        directory = os.open(marker.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        print(json.dumps({
            "schema": "neal.post-restore-reconciliation/v1",
            "status": "complete",
            "ledgerGeneration": app.store.ledger_generation(),
        }, sort_keys=True))
        return 0
    raise IssuerError("No reconciliation action selected")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IssuerError as error:
        raise SystemExit(f"reconciliation failed [{error.code}]: {error}")
