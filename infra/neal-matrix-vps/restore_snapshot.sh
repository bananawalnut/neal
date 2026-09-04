#!/usr/bin/env bash
set -euo pipefail

project_root="/srv/neal-matrix"
import_root="$project_root/import"
runtime_root="$project_root/runtime"
synapse_root="$runtime_root/synapse"
postgres_root="$runtime_root/postgres"
replace_existing=0

if [[ "${1:-}" == "--replace-existing" ]]; then
  replace_existing=1
  shift
fi
if (($#)); then
  printf 'Usage: %s [--replace-existing]\n' "$0" >&2
  exit 2
fi

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this script as root on the VPS.\n' >&2
  exit 1
fi

for required_path in \
  "$project_root/compose.yaml" \
  "$project_root/Caddyfile" \
  "$project_root/.neal-migration-target" \
  "$import_root/manifest.json" \
  "$import_root/SHA256SUMS" \
  "$import_root/synapse.dump" \
  "$import_root/secrets/registration-shared-secret" \
  "$import_root/secrets/macaroon-secret" \
  "$import_root/secrets/form-secret" \
  "$import_root/secrets/matrix.nealtheseal.org.signing.key"; do
  [[ -f "$required_path" ]] || { printf 'Required import file is missing: %s\n' "$required_path" >&2; exit 1; }
done

cd "$import_root"
sha256sum -c SHA256SUMS
python3 - <<'PY'
import json
from pathlib import Path

manifest = json.loads(Path("manifest.json").read_text())
assert manifest["format"] == 1
assert manifest["server_name"] == "matrix.nealtheseal.org"
assert manifest["synapse_version"] == "1.157.2"
assert manifest["postgres_major"] == 16
PY

install -d -m 700 "$runtime_root" "$postgres_root" "$synapse_root" "$synapse_root/media_store"
if [[ ! -s "$runtime_root/postgres-password" ]]; then
  openssl rand -hex 32 >"$runtime_root/postgres-password"
fi
chmod 600 "$runtime_root/postgres-password"
database_password="$(sed -n '1p' "$runtime_root/postgres-password")"

for secret_name in registration-shared-secret macaroon-secret form-secret matrix.nealtheseal.org.signing.key; do
  install -m 600 "$import_root/secrets/$secret_name" "$synapse_root/$secret_name"
done
if [[ -d "$import_root/media" ]]; then
  cp -a "$import_root/media/." "$synapse_root/media_store/"
fi

registration_shared_secret="$(sed -n '1p' "$synapse_root/registration-shared-secret")"
macaroon_secret="$(sed -n '1p' "$synapse_root/macaroon-secret")"
form_secret="$(sed -n '1p' "$synapse_root/form-secret")"

cat >"$synapse_root/homeserver.yaml" <<EOF
server_name: matrix.nealtheseal.org
public_baseurl: https://matrix.nealtheseal.org/
pid_file: /data/homeserver.pid
listeners:
  - port: 8008
    type: http
    tls: false
    bind_addresses: ['0.0.0.0']
    x_forwarded: true
    resources:
      - names: [client, federation]
        compress: true
database:
  name: psycopg2
  args:
    user: synapse_neal
    password: '$database_password'
    database: synapse_neal
    host: postgres
    port: 5432
    cp_min: 1
    cp_max: 5
log_config: /data/log.config
media_store_path: /data/media_store
signing_key_path: /data/matrix.nealtheseal.org.signing.key
registration_shared_secret: '$registration_shared_secret'
macaroon_secret_key: '$macaroon_secret'
form_secret: '$form_secret'
enable_registration: true
enable_registration_without_verification: true
registration_requires_token: true
allow_guest_access: false
allow_public_rooms_without_auth: false
allow_public_rooms_over_federation: false
require_auth_for_profile_requests: true
enable_metrics: false
url_preview_enabled: false
max_upload_size: 25M
remote_media_lifetime: 30d
trusted_key_servers: []
suppress_key_server_warning: true
report_stats: false
rc_registration:
  per_second: 0.01
  burst_count: 3
EOF

if [[ ! -f "$project_root/runtime/caddy.env" ]]; then
  install -m 600 /dev/null "$project_root/runtime/caddy.env"
fi

cat >"$synapse_root/log.config" <<'EOF'
version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
root:
  level: INFO
  handlers: [console]
disable_existing_loggers: false
EOF
chmod 600 "$synapse_root/homeserver.yaml" "$synapse_root/log.config"
chown -R 999:999 "$postgres_root"
chown -R 991:991 "$synapse_root"

cd "$project_root"
docker compose down
docker compose up -d postgres

for attempt in $(seq 1 36); do
  if docker compose exec -T postgres pg_isready -U synapse_neal -d synapse_neal >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" -eq 36 ]]; then
    printf 'PostgreSQL did not become ready.\n' >&2
    exit 1
  fi
  sleep 5
done

table_count="$(docker compose exec -T postgres psql -U synapse_neal -d synapse_neal -Atqc "SELECT COUNT(*) FROM pg_tables WHERE schemaname='public'")"
if [[ "$table_count" != "0" ]]; then
  if [[ "$replace_existing" -ne 1 ]]; then
    printf 'Refusing to overwrite a non-empty PostgreSQL database (%s public tables). Use --replace-existing only for the reviewed final cutover.\n' "$table_count" >&2
    exit 1
  fi
  docker compose exec -T postgres dropdb --if-exists -U synapse_neal synapse_neal
  docker compose exec -T postgres createdb -U synapse_neal -O synapse_neal --encoding=UTF8 --locale=C --template=template0 synapse_neal
fi

docker compose exec -T postgres pg_restore \
  -U synapse_neal \
  -d synapse_neal \
  --no-owner \
  --no-acl <"$import_root/synapse.dump"

docker compose up -d synapse
for attempt in $(seq 1 36); do
  if curl -fsS http://127.0.0.1:8008/_matrix/client/versions >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 36 ]]; then
    printf 'Synapse did not become ready.\n' >&2
    docker compose logs --tail=100 synapse >&2
    exit 1
  fi
  sleep 5
done

database_summary="$(docker compose exec -T postgres psql -U synapse_neal -d synapse_neal -Atqc 'SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM rooms;')"
printf 'Snapshot restored and Synapse is healthy on 127.0.0.1:8008.\n'
printf 'Restored user/room counts:\n%s\n' "$database_summary"
printf 'Start Caddy only after DNS is ready.\n'
