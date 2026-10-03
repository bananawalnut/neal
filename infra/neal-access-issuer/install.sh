#!/usr/bin/env bash
set -euo pipefail

start_service=0
enable_backup=0
install_restore_verifier=0
while (($#)); do
  case "$1" in
    --start) start_service=1 ;;
    --enable-backup) enable_backup=1 ;;
    --install-restore-verifier) install_restore_verifier=1 ;;
    *) printf 'Usage: %s [--start] [--enable-backup] [--install-restore-verifier]\n' "$0" >&2; exit 2 ;;
  esac
  shift
done
if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this installer as root on Ubuntu 24.04.\n' >&2
  exit 1
fi

source_root="$(cd "$(dirname "$0")" && pwd)"
install_root="/opt/neal-access-issuer"
release_root="$install_root/releases"
current_link="$install_root/current"
environment_file="/etc/neal-access-issuer.env"
matrix_secret="/srv/neal-matrix/runtime/synapse/registration-shared-secret"
issuer_keypair="/etc/neal-access-issuer-issuer-keypair.json"
rpc_set="/etc/neal-access-issuer-solana-rpc-set.json"
recovery_key="/etc/neal-access-issuer-recovery-key.bin"
broker_key="/etc/neal-admin-monitor-session-key.bin"
backup_target="/etc/neal-access-issuer-backup-s3.json"
recovery_public_key="/etc/neal-access-issuer-recovery-public.pem"
restore_target="/etc/neal-access-restore-s3.json"
recovery_private_key="/etc/neal-access-restore-private.pem"

if [[ "$install_restore_verifier" -eq 1 && ("$start_service" -eq 1 || "$enable_backup" -eq 1) ]]; then
  printf 'The off-host restore verifier cannot be installed with issuer or upload-service options.\n' >&2
  exit 2
fi

[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  printf 'Only Linux x86-64 is supported.\n' >&2
  exit 1
}
[[ -r /etc/os-release ]] || { printf '/etc/os-release is required.\n' >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] || {
  printf 'Only Ubuntu 24.04 is supported.\n' >&2
  exit 1
}
command -v python3 >/dev/null || { printf 'python3 is required.\n' >&2; exit 1; }
python3 -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' || {
  printf 'Python 3.12 is required by the offline wheelhouse.\n' >&2
  exit 1
}
python3 -m venv --help >/dev/null 2>&1 || { printf 'python3-venv is required.\n' >&2; exit 1; }

python3 "$source_root/build_bundle.py" verify --bundle "$source_root" >/dev/null
source_commit="$(tr -d '\r\n' < "$source_root/SOURCE_COMMIT")"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || { printf 'Invalid SOURCE_COMMIT.\n' >&2; exit 1; }
release_dir="$release_root/$source_commit"

install -d -m 0755 "$release_root"
if [[ ! -d "$release_dir" ]]; then
  staging="$(mktemp -d "$release_root/.${source_commit}.XXXXXX")"
  cleanup_staging() {
    if [[ -n "${staging:-}" && -d "$staging" ]]; then
      rm -rf -- "$staging"
    fi
  }
  trap cleanup_staging EXIT
  cp -a "$source_root/." "$staging/"
  python3 "$staging/build_bundle.py" verify --bundle "$staging" >/dev/null
  python3 -m venv "$staging/venv"
  "$staging/venv/bin/pip" install \
    --disable-pip-version-check \
    --no-index \
    --find-links "$staging/wheelhouse" \
    --only-binary=:all: \
    --require-hashes \
    --requirement "$staging/requirements-deploy.txt"
  "$staging/venv/bin/python" -m compileall -q "$staging"
  "$staging/venv/bin/python" -c 'import admin_broker, backup, issuer, s3_backup'
  mv "$staging" "$release_dir"
  staging=""
  trap - EXIT
else
  python3 "$release_dir/build_bundle.py" verify --bundle "$release_dir" >/dev/null
fi

temporary_link="$install_root/.current.$source_commit"
rm -f -- "$temporary_link"
ln -s "$release_dir" "$temporary_link"
mv -Tf "$temporary_link" "$current_link"

for unit in \
  neal-access-issuer.service \
  neal-admin-monitor.service \
  neal-access-issuer-backup.service \
  neal-access-issuer-backup.timer; do
  install -m 0644 "$release_dir/$unit" "/etc/systemd/system/$unit"
done
if [[ "$install_restore_verifier" -eq 1 ]]; then
  for unit in neal-access-restore-verify.service neal-access-restore-verify.timer; do
    install -m 0644 "$release_dir/$unit" "/etc/systemd/system/$unit"
  done
fi
if [[ "$install_restore_verifier" -ne 1 && ! -f "$environment_file" ]]; then
  install -m 0600 "$release_dir/access-issuer.env.example" "$environment_file"
  printf 'Created %s. Replace every REPLACE_WITH value before starting.\n' "$environment_file"
fi
systemctl daemon-reload

if [[ "$install_restore_verifier" -eq 1 ]]; then
  [[ -s "$restore_target" && -s "$recovery_private_key" ]] || {
    printf 'Off-host restore target and recovery private key must be provisioned before enabling verification.\n' >&2
    exit 1
  }
  chmod 0600 "$restore_target" "$recovery_private_key"
  systemctl start neal-access-restore-verify.service
  systemctl enable --now neal-access-restore-verify.timer
  printf 'Installed off-host restore verifier release %s. No issuer service was started.\n' "$source_commit"
  exit 0
fi

if [[ "$start_service" -eq 1 ]]; then
  if grep -q 'REPLACE_WITH' "$environment_file"; then
    printf 'Refusing to start with placeholder values in %s.\n' "$environment_file" >&2
    exit 1
  fi
  chmod 0600 "$environment_file"
  [[ -s "$matrix_secret" ]] || { printf 'Matrix registration secret is missing.\n' >&2; exit 1; }
  [[ -s "$issuer_keypair" ]] || { printf 'Issuer authority keypair is missing.\n' >&2; exit 1; }
  [[ -s "$rpc_set" ]] || { printf 'Solana RPC-set credential is missing.\n' >&2; exit 1; }
  [[ -f "$recovery_key" && "$(wc -c < "$recovery_key")" -eq 32 ]] || { printf 'Issuance recovery key must contain exactly 32 bytes.\n' >&2; exit 1; }
  if [[ ! -e "$broker_key" ]]; then
    "$release_dir/venv/bin/python" "$release_dir/admin_broker.py" generate-key --output "$broker_key"
  fi
  [[ -f "$broker_key" && "$(wc -c < "$broker_key")" -eq 32 ]] || { printf 'Admin broker key must contain exactly 32 bytes.\n' >&2; exit 1; }
  chmod 0600 "$matrix_secret" "$issuer_keypair" "$rpc_set" "$recovery_key" "$broker_key"
  cd /srv/neal-matrix
  docker compose config --quiet
  docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl enable neal-access-issuer.service neal-admin-monitor.service
  systemctl restart neal-access-issuer.service
  systemctl restart neal-admin-monitor.service
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --unix-socket /run/neal-access-issuer/issuer.sock http://localhost/readyz >/dev/null; then
      break
    fi
    if [[ "$attempt" -eq 20 ]]; then
      systemctl status --no-pager neal-access-issuer.service >&2 || true
      journalctl --no-pager -u neal-access-issuer.service -n 100 >&2 || true
      printf 'New release failed readiness. Do not start an old binary against this ledger; diagnose and roll forward.\n' >&2
      exit 1
    fi
    sleep 2
  done
  docker compose up -d --force-recreate caddy
fi

if [[ "$enable_backup" -eq 1 ]]; then
  [[ -s "$backup_target" && -s "$recovery_public_key" ]] || {
    printf 'Backup target and recovery public key must be provisioned before enabling the timer.\n' >&2
    exit 1
  }
  chmod 0600 "$backup_target"
  chmod 0644 "$recovery_public_key"
  systemctl start neal-access-issuer-backup.service
  systemctl enable --now neal-access-issuer-backup.timer
fi

printf 'Installed verified release %s at %s.\n' "$source_commit" "$release_dir"
if [[ "$start_service" -ne 1 ]]; then
  printf 'The release is staged but not started. Configure %s, then rerun with --start.\n' "$environment_file"
fi
