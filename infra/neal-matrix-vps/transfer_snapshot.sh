#!/usr/bin/env bash
set -euo pipefail

if (($# < 2 || $# > 3)); then
  printf 'Usage: %s root@VPS_IP /absolute/path/snapshot.age [/path/to/age-identity]\n' "$0" >&2
  exit 2
fi

remote_target="$1"
snapshot_path="$2"
identity_file="${3:-${HOME}/Library/Application Support/Neal/Matrix/secrets/migration-age-identity}"
script_root="$(cd "$(dirname "$0")" && pwd)"
known_hosts_file="${NEAL_MATRIX_SSH_KNOWN_HOSTS:-}"
ssh_identity_file="${NEAL_MATRIX_SSH_IDENTITY_FILE:-}"
ssh_options=()

[[ "$remote_target" == root@* ]] || { printf 'The target must be an explicit root@host value.\n' >&2; exit 2; }
[[ "$snapshot_path" == /* && -f "$snapshot_path" ]] || { printf 'Snapshot must be an existing absolute path.\n' >&2; exit 2; }
[[ -f "$identity_file" ]] || { printf 'Age identity is missing: %s\n' "$identity_file" >&2; exit 2; }
if [[ -n "$known_hosts_file" ]]; then
  [[ -f "$known_hosts_file" ]] || { printf 'Known-hosts file is missing: %s\n' "$known_hosts_file" >&2; exit 2; }
  ssh_options+=(
    -o StrictHostKeyChecking=yes
    -o "UserKnownHostsFile=$known_hosts_file"
  )
fi
if [[ -n "$ssh_identity_file" ]]; then
  [[ -f "$ssh_identity_file" ]] || { printf 'SSH identity is missing: %s\n' "$ssh_identity_file" >&2; exit 2; }
  ssh_options+=(
    -o IdentitiesOnly=yes
    -i "$ssh_identity_file"
  )
fi

ssh "${ssh_options[@]}" "$remote_target" 'install -d -m 700 /srv/neal-matrix /srv/neal-matrix/import'
ssh "${ssh_options[@]}" "$remote_target" 'install -d -m 700 /srv/neal-matrix/access-issuer'
scp \
  "${ssh_options[@]}" \
  "$script_root/compose.yaml" \
  "$script_root/Caddyfile" \
  "$script_root/prepare_ubuntu_host.sh" \
  "$script_root/restore_snapshot.sh" \
  "$script_root/create_registration_token.py" \
  "$script_root/verify_public.sh" \
  "$remote_target:/srv/neal-matrix/"
scp \
  "${ssh_options[@]}" \
  "$script_root/../neal-access-issuer/issuer.py" \
  "$script_root/../neal-access-issuer/requirements.txt" \
  "$script_root/../neal-access-issuer/access-issuer.env.example" \
  "$script_root/../neal-access-issuer/neal-access-issuer.service" \
  "$script_root/../neal-access-issuer/install.sh" \
  "$remote_target:/srv/neal-matrix/access-issuer/"
ssh "${ssh_options[@]}" "$remote_target" 'chmod 700 /srv/neal-matrix/access-issuer/install.sh'

age --decrypt --identity "$identity_file" "$snapshot_path" | \
  ssh "${ssh_options[@]}" "$remote_target" 'install -d -m 700 /srv/neal-matrix/import && tar -xf - -C /srv/neal-matrix/import'

printf 'Migration files transferred through SSH. The decrypted import is root-only on the VPS.\n'
