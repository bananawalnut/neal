#!/usr/bin/env bash
set -euo pipefail

start_service=0
if [[ "${1:-}" == "--start" ]]; then
  start_service=1
  shift
fi
if (($#)); then
  printf 'Usage: %s [--start]\n' "$0" >&2
  exit 2
fi
if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this script as root on the NEAL Matrix VPS.\n' >&2
  exit 1
fi

source_root="$(cd "$(dirname "$0")" && pwd)"
install_root="/opt/neal-access-issuer"
environment_file="/etc/neal-access-issuer.env"
matrix_secret="/srv/neal-matrix/runtime/synapse/registration-shared-secret"
issuer_keypair="/etc/neal-access-issuer-issuer-keypair.json"

for required in issuer.py reconcile.py requirements-deploy.txt access-issuer.env.example neal-access-issuer.service; do
  [[ -f "$source_root/$required" ]] || { printf 'Missing deployment file: %s\n' "$source_root/$required" >&2; exit 1; }
done
command -v python3 >/dev/null || { printf 'python3 is required.\n' >&2; exit 1; }
python3 -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 13) else 1)' || {
  printf 'Python 3.13 is required by the hash-locked deployment wheel set.\n' >&2
  exit 1
}
python3 -m venv --help >/dev/null 2>&1 || { printf 'python3-venv is required.\n' >&2; exit 1; }
[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  printf 'The hash-locked deployment wheel set supports Linux x86_64 only.\n' >&2
  exit 1
}

install -d -m 0755 "$install_root"
install -m 0644 "$source_root/issuer.py" "$install_root/issuer.py"
install -m 0755 "$source_root/reconcile.py" "$install_root/reconcile.py"
install -m 0644 "$source_root/requirements-deploy.txt" "$install_root/requirements-deploy.txt"
install -m 0644 "$source_root/neal-access-issuer.service" /etc/systemd/system/neal-access-issuer.service
if [[ ! -f "$environment_file" ]]; then
  install -m 0600 "$source_root/access-issuer.env.example" "$environment_file"
  printf 'Created %s. Replace every REPLACE_WITH value before starting the service.\n' "$environment_file"
fi

if [[ ! -x "$install_root/venv/bin/python" ]]; then
  python3 -m venv "$install_root/venv"
fi
"$install_root/venv/bin/pip" install --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes --requirement "$install_root/requirements-deploy.txt"
systemctl daemon-reload

if [[ "$start_service" -ne 1 ]]; then
  printf 'Issuer installed but not started. Configure %s, then rerun with --start.\n' "$environment_file"
  exit 0
fi

if grep -q 'REPLACE_WITH' "$environment_file"; then
  printf 'Refusing to start with placeholder deployment values in %s.\n' "$environment_file" >&2
  exit 1
fi
chmod 0600 "$environment_file"
[[ -s "$matrix_secret" ]] || { printf 'Matrix registration secret is missing.\n' >&2; exit 1; }
[[ -s "$issuer_keypair" ]] || { printf 'Issuer authority keypair is missing at %s.\n' "$issuer_keypair" >&2; exit 1; }
chmod 0600 "$matrix_secret" "$issuer_keypair"

cd /srv/neal-matrix
docker compose config --quiet
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

systemctl enable --now neal-access-issuer.service
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error --unix-socket /run/neal-access-issuer/issuer.sock http://localhost/readyz >/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 20 ]]; then
    systemctl status --no-pager neal-access-issuer.service >&2 || true
    journalctl --no-pager -u neal-access-issuer.service -n 100 >&2 || true
    printf 'Issuer failed its internal readiness check.\n' >&2
    exit 1
  fi
  sleep 2
done

docker compose up -d --force-recreate caddy
printf 'Issuer is internally ready. Run verify_public.sh with --with-access-issuer before changing wallet-policy.json.\n'
