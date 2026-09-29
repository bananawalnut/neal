#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this script as root on the new VPS.\n' >&2
  exit 1
fi

if [[ ! -r /etc/os-release ]] || ! grep -q '^ID=ubuntu$' /etc/os-release; then
  printf 'This bootstrap is intentionally limited to Ubuntu.\n' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker.io \
  docker-compose-v2 \
  fail2ban \
  openssl \
  python3 \
  python3-venv \
  unattended-upgrades \
  ufw

systemctl enable --now docker fail2ban

install -d -m 700 /srv/neal-matrix /srv/neal-matrix/import /srv/neal-matrix/runtime
install -d -m 700 /srv/neal-matrix/runtime/postgres /srv/neal-matrix/runtime/synapse
touch /srv/neal-matrix/.neal-migration-target
chmod 600 /srv/neal-matrix/.neal-migration-target

cat >/etc/ssh/sshd_config.d/99-neal-matrix-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
EOF
sshd -t
systemctl reload ssh

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

printf 'Ubuntu host prepared. SSH keys remain required; public ports are limited to SSH, HTTP, and HTTPS.\n'
