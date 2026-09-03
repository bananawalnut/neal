#!/usr/bin/env bash
set -euo pipefail

source_root="${NEAL_MATRIX_SOURCE_ROOT:-${HOME}/Library/Application Support/Neal/Matrix}"
pg_bin="${NEAL_MATRIX_PG_BIN:-/opt/homebrew/opt/postgresql@16/bin}"
output_path=""
recipient_file="${NEAL_MATRIX_AGE_RECIPIENT_FILE:-$source_root/secrets/migration-age-recipient}"
freeze_local=0
snapshot_tmp=""
freeze_succeeded=0

usage() {
  printf 'Usage: %s --output /absolute/path/snapshot.age [--recipient-file /path/to/age-or-ssh-public-key] [--freeze]\n' "$0"
}

while (($#)); do
  case "$1" in
    --output)
      output_path="${2:-}"
      shift 2
      ;;
    --recipient-file)
      recipient_file="${2:-}"
      shift 2
      ;;
    --freeze)
      freeze_local=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$output_path" || "$output_path" != /* || "$output_path" != *.age ]]; then
  printf 'An absolute --output path ending in .age is required.\n' >&2
  exit 2
fi

for required in age python3 tar; do
  command -v "$required" >/dev/null || { printf 'Missing required command: %s\n' "$required" >&2; exit 1; }
done
for required_path in \
  "$pg_bin/pg_dump" \
  "$pg_bin/pg_isready" \
  "$source_root/secrets/postgres-password" \
  "$source_root/secrets/registration-shared-secret" \
  "$source_root/secrets/macaroon-secret" \
  "$source_root/secrets/form-secret" \
  "$source_root/secrets/matrix.nealtheseal.org.signing.key"; do
  [[ -f "$required_path" ]] || { printf 'Required path is missing: %s\n' "$required_path" >&2; exit 1; }
done
[[ -f "$recipient_file" ]] || { printf 'Recipient file is missing: %s\n' "$recipient_file" >&2; exit 1; }

snapshot_tmp="$(mktemp -d "${TMPDIR:-/tmp}/neal-matrix-snapshot.XXXXXX")"
cleanup() {
  if [[ -n "$snapshot_tmp" && -d "$snapshot_tmp" && "$snapshot_tmp" == *neal-matrix-snapshot.* ]]; then
    rm -rf -- "$snapshot_tmp"
  fi
  if [[ "$freeze_local" -eq 1 && "$freeze_succeeded" -eq 0 ]]; then
    "$(dirname "$0")/resume_local_services.sh" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$freeze_local" -eq 1 ]]; then
  launchctl bootout "gui/${UID}/org.nealtheseal.matrix.gateway" >/dev/null 2>&1 || true
  launchctl bootout "gui/${UID}/org.nealtheseal.matrix.synapse" >/dev/null 2>&1 || true
fi

"$pg_bin/pg_isready" -h 127.0.0.1 -p 55433 -t 5 >/dev/null
mkdir -p "$snapshot_tmp/media" "$snapshot_tmp/secrets"

PGPASSWORD="$(sed -n '1p' "$source_root/secrets/postgres-password")" \
  "$pg_bin/pg_dump" \
    -h 127.0.0.1 \
    -p 55433 \
    -U synapse_neal \
    -d synapse_neal \
    --format=custom \
    --no-owner \
    --no-acl \
    --file="$snapshot_tmp/synapse.dump"

if [[ -d "$source_root/state/media" ]]; then
  cp -a "$source_root/state/media/." "$snapshot_tmp/media/"
fi
for secret_name in \
  registration-shared-secret \
  macaroon-secret \
  form-secret \
  matrix.nealtheseal.org.signing.key; do
  cp "$source_root/secrets/$secret_name" "$snapshot_tmp/secrets/$secret_name"
  chmod 600 "$snapshot_tmp/secrets/$secret_name"
done

cat >"$snapshot_tmp/manifest.json" <<EOF
{
  "format": 1,
  "server_name": "matrix.nealtheseal.org",
  "synapse_version": "1.157.2",
  "postgres_major": 16,
  "database": "synapse_neal",
  "media_path": "media",
  "frozen": $([[ "$freeze_local" -eq 1 ]] && printf true || printf false)
}
EOF

(
  cd "$snapshot_tmp"
  python3 - <<'PY'
import hashlib
from pathlib import Path

with Path("SHA256SUMS").open("w", encoding="utf-8") as output:
    for path in sorted(path for path in Path(".").rglob("*") if path.is_file() and path.name != "SHA256SUMS"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        output.write(f"{digest}  {path.as_posix()}\n")
PY
  tar -cf - .
) | age -R "$recipient_file" -o "$output_path"
chmod 600 "$output_path"

if [[ "$freeze_local" -eq 1 ]]; then
  freeze_succeeded=1
  printf 'Encrypted final snapshot created; local Synapse and gateway remain frozen: %s\n' "$output_path"
else
  printf 'Encrypted rehearsal snapshot created while the local server remained live: %s\n' "$output_path"
fi
