#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-https://matrix.nealtheseal.org}"
[[ "$base_url" == https://* ]] || { printf 'Expected an https:// base URL.\n' >&2; exit 2; }

curl -fsS "$base_url/_matrix/client/versions" >/dev/null
curl -fsS "$base_url/_matrix/federation/v1/version" >/dev/null

admin_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/_synapse/admin/v1/server_version")"
[[ "$admin_status" == "404" ]] || { printf 'Public admin API is not blocked (HTTP %s).\n' "$admin_status" >&2; exit 1; }

monitor_status="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Origin: https://nealtheseal.org' "$base_url/_neal/admin/users")"
[[ "$monitor_status" == "401" ]] || { printf 'Admin monitor did not require authentication (HTTP %s).\n' "$monitor_status" >&2; exit 1; }

monitor_origin="$(curl -sS -D - -o /dev/null -H 'Origin: https://nealtheseal.org' "$base_url/_neal/admin/users" | tr -d '\r' | awk 'tolower($1) == "access-control-allow-origin:" { print $2 }')"
[[ "$monitor_origin" == "https://nealtheseal.org" ]] || { printf 'Admin monitor returned an invalid CORS origin: %s\n' "$monitor_origin" >&2; exit 1; }

preflight_status="$(curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: https://nealtheseal.org' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' "$base_url/_neal/admin/users")"
[[ "$preflight_status" == "204" ]] || { printf 'Admin monitor preflight failed (HTTP %s).\n' "$preflight_status" >&2; exit 1; }

hidden_monitor_status="$(curl -sS -o /dev/null -w '%{http_code}' "$base_url/_neal/admin/users")"
[[ "$hidden_monitor_status" == "404" ]] || { printf 'Admin monitor is reachable without the approved origin (HTTP %s).\n' "$hidden_monitor_status" >&2; exit 1; }

write_status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Origin: https://nealtheseal.org' "$base_url/_neal/admin/users")"
[[ "$write_status" == "404" ]] || { printf 'Admin monitor accepted an unsupported method (HTTP %s).\n' "$write_status" >&2; exit 1; }

python3 - "$base_url" <<'PY'
import json
import sys
import urllib.request

base = sys.argv[1].rstrip("/")
with urllib.request.urlopen(base + "/.well-known/matrix/client", timeout=20) as response:
    client = json.load(response)
with urllib.request.urlopen(base + "/.well-known/matrix/server", timeout=20) as response:
    server = json.load(response)
with urllib.request.urlopen(base + "/_neal/gc/messages", timeout=20) as response:
    feed = json.load(response)
assert client["m.homeserver"]["base_url"] == "https://matrix.nealtheseal.org/"
assert server["m.server"] == "matrix.nealtheseal.org:443"
assert isinstance(feed.get("chunk"), list)
assert all(event.get("type") == "m.room.message" for event in feed["chunk"])
assert all(isinstance(event.get("content", {}).get("body"), str) for event in feed["chunk"])
print("Client, federation, discovery, public chat feed, admin-monitor boundary, and public-admin blocking checks passed.")
PY
