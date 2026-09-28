#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_root="${HOME}/.local/lib/neal"
launch_agents="${HOME}/Library/LaunchAgents"
log_root="${HOME}/Library/Logs/Neal"
label="org.nealtheseal.hermes-health"
plist="${launch_agents}/${label}.plist"
python_bin="$(command -v python3)"

[[ -x "$python_bin" ]] || { printf 'python3 is required.\n' >&2; exit 1; }
[[ -f "${HOME}/.hermes/profiles/neal/.env" ]] || { printf 'The NEAL Hermes profile is not installed.\n' >&2; exit 1; }

install -d -m 700 "$install_root" "$log_root"
install -d -m 755 "$launch_agents"
install -m 700 "$script_root/publish_health.py" "$install_root/publish_hermes_health.py"

python3 - "$plist" "$python_bin" "$install_root/publish_hermes_health.py" "$log_root" <<'PY'
import html
import sys
from pathlib import Path

plist, python_bin, script, log_root = sys.argv[1:]
values = {"python": python_bin, "script": script, "log": log_root}
escaped = {key: html.escape(value) for key, value in values.items()}
Path(plist).write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.nealtheseal.hermes-health</string>
  <key>ProgramArguments</key>
  <array><string>{escaped["python"]}</string><string>{escaped["script"]}</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>{escaped["log"]}/hermes-health.log</string>
  <key>StandardErrorPath</key><string>{escaped["log"]}/hermes-health-error.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
''')
PY
chmod 600 "$plist"

launchctl bootout "gui/${UID}" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/${UID}" "$plist"
launchctl kickstart -k "gui/${UID}/${label}"
printf 'Installed %s.\n' "$label"
