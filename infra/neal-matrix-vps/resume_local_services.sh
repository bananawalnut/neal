#!/usr/bin/env bash
set -euo pipefail

launch_agents="${HOME}/Library/LaunchAgents"
domain="gui/${UID}"

for label in org.nealtheseal.matrix.postgres org.nealtheseal.matrix.synapse org.nealtheseal.matrix.gateway; do
  plist="$launch_agents/$label.plist"
  [[ -f "$plist" ]] || { printf 'Missing launch agent: %s\n' "$plist" >&2; exit 1; }
  launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 || true
  launchctl kickstart -k "$domain/$label"
done

printf 'Local NEAL Matrix services resumed.\n'
