#!/usr/bin/env python3
"""List or reconcile fail-closed temporary Synapse administrator cleanup records."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from issuer import IssuerError, MatrixIssuer, Settings, Store


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment-file", default="/etc/neal-access-issuer.env")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--list", action="store_true", help="list unresolved cleanup records")
    action.add_argument("--user-id", help="reconcile one exact temporary administrator")
    options = parser.parse_args()

    environment_file = Path(options.environment_file)
    if environment_file.is_file():
        for number, raw_line in enumerate(environment_file.read_text().splitlines(), start=1):
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            name, separator, value = line.partition("=")
            if separator != "=" or not name.startswith("NEAL_ACCESS_") or not name.replace("_", "").isalnum():
                raise IssuerError(f"Invalid environment entry on line {number}")
            os.environ.setdefault(name, value)

    settings = Settings.from_environment()
    store = Store(settings.database)
    if options.list:
        print(json.dumps({"pending": store.pending_admin_cleanups()}, indent=2))
        return 0

    MatrixIssuer(settings, store).reconcile_admin_cleanup(options.user_id)
    print(json.dumps({"reconciled": options.user_id, "pendingCount": store.unresolved_admin_cleanups()}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except IssuerError as error:
        raise SystemExit(f"reconciliation failed: {error}")
