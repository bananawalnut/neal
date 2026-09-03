#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://matrix.nealtheseal.org}"
[[ "$base_url" == https://* ]] || { printf 'Expected an https:// base URL.\n' >&2; exit 2; }

curl -fsS "$base_url/_matrix/client/versions" >/dev/null
curl -fsS "$base_url/_matrix/federation/v1/version" >/dev/null

admin_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/_synapse/admin/v1/server_version")"
[[ "$admin_status" == "404" ]] || { printf 'Public admin API is not blocked (HTTP %s).\n' "$admin_status" >&2; exit 1; }

python3 - "$base_url" <<'PY'
import json
import sys
import urllib.request

base = sys.argv[1].rstrip("/")
with urllib.request.urlopen(base + "/.well-known/matrix/client", timeout=20) as response:
    client = json.load(response)
with urllib.request.urlopen(base + "/.well-known/matrix/server", timeout=20) as response:
    server = json.load(response)
assert client["m.homeserver"]["base_url"] == "https://matrix.nealtheseal.org/"
assert server["m.server"] == "matrix.nealtheseal.org:443"
print("Client, federation, discovery, and public-admin blocking checks passed.")
PY
