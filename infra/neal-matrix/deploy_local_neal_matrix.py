#!/usr/bin/env python3
"""Provision and supervise the NEAL Synapse homeserver on this Mac.

NEAL has its own database cluster, media, secrets, logs, ports, and launchd
labels. The installation reuses only Zenith's pinned Synapse Python runtime.
No secret value is printed or stored in the repository.
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import os
import plistlib
import secrets
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml


SERVER_NAME = "matrix.nealtheseal.org"
PUBLIC_BASEURL = "https://matrix-home.tailadbebb.ts.net:10000/"
BASE = Path.home() / "Library/Application Support/Neal/Matrix"
LOG_ROOT = Path.home() / "Library/Logs/Neal/Matrix"
CONFIG_DIR = BASE / "config"
SECRET_DIR = BASE / "secrets"
BIN_DIR = BASE / "bin"
RUNTIME_DIR = BASE / "runtime"
STATE_ROOT = BASE / "state"
PG_DATA = STATE_ROOT / "postgres"
PG_SOCKET = STATE_ROOT / "run/postgresql"
PG_LOGS = STATE_ROOT / "logs"
MEDIA = STATE_ROOT / "media"
BACKUPS = STATE_ROOT / "backups"

ZENITH_VENV = Path.home() / "Library/Application Support/Zenith/Matrix/runtime/venv"
PYTHON = ZENITH_VENV / "bin/python"
SYNAPSE = ZENITH_VENV / "bin/synapse_homeserver"
REGISTER_USER = ZENITH_VENV / "bin/register_new_matrix_user"

PG_PREFIX = Path("/opt/homebrew/opt/postgresql@16")
PG_BIN = PG_PREFIX / "bin"
PG_PORT = 55433
SYNAPSE_PORT = 8010
GATEWAY_PORT = 8011
DB_ROLE = "synapse_neal"
DB_NAME = "synapse_neal"

CONFIG = CONFIG_DIR / "homeserver.yaml"
LOG_CONFIG = CONFIG_DIR / "log.config"
DEPLOYMENT = CONFIG_DIR / "deployment.json"
DB_SECRET = SECRET_DIR / "postgres-password"
CONTROLLER = BIN_DIR / "deploy_local_neal_matrix.py"

PG_LABEL = "org.nealtheseal.matrix.postgres"
SYNAPSE_LABEL = "org.nealtheseal.matrix.synapse"
GATEWAY_LABEL = "org.nealtheseal.matrix.gateway"
LAUNCH_AGENTS = Path.home() / "Library/LaunchAgents"


class DeploymentError(RuntimeError):
    pass


def run(
    args: list[str | Path],
    *,
    input_text: str | None = None,
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(value) for value in args],
        input=input_text,
        text=True,
        capture_output=capture,
        check=check,
    )


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content)
    temporary.chmod(mode)
    temporary.replace(path)


def require_file(path: Path) -> None:
    if not path.exists():
        raise DeploymentError(f"Required path is missing: {path}")


def secret_file(path: Path, byte_count: int = 32) -> str:
    if path.exists():
        return path.read_text().strip()
    value = secrets.token_hex(byte_count)
    atomic_write(path, value + "\n")
    return value


def prepare_directories() -> None:
    for path in (
        CONFIG_DIR,
        SECRET_DIR,
        BIN_DIR,
        RUNTIME_DIR,
        LOG_ROOT,
        STATE_ROOT,
        PG_SOCKET,
        PG_LOGS,
        MEDIA,
        BACKUPS,
        LAUNCH_AGENTS,
    ):
        path.mkdir(parents=True, exist_ok=True)
    SECRET_DIR.chmod(0o700)
    PG_SOCKET.chmod(0o700)


def postgres_arguments() -> list[str]:
    return [
        str(PG_BIN / "postgres"),
        "-D",
        str(PG_DATA),
        "-p",
        str(PG_PORT),
        "-k",
        str(PG_SOCKET),
        "-c",
        "listen_addresses=127.0.0.1",
        "-c",
        "unix_socket_permissions=0700",
        "-c",
        "max_connections=50",
    ]


def postgres_ready() -> bool:
    result = run(
        [PG_BIN / "pg_isready", "-h", PG_SOCKET, "-p", str(PG_PORT), "-t", "3"],
        capture=True,
        check=False,
    )
    return result.returncode == 0


def initialize_postgres() -> None:
    if not (PG_DATA / "PG_VERSION").exists():
        run(
            [
                PG_BIN / "initdb",
                "-D",
                PG_DATA,
                "--encoding=UTF8",
                "--locale=C",
                "--auth-local=trust",
                "--auth-host=scram-sha-256",
            ]
        )
        atomic_write(
            PG_DATA / "pg_hba.conf",
            "local all all trust\n"
            "host all all 127.0.0.1/32 scram-sha-256\n"
            "host all all ::1/128 reject\n",
        )

    password = secret_file(DB_SECRET)
    started_here = not postgres_ready()
    if started_here:
        options = " ".join(shlex.quote(value) for value in postgres_arguments()[3:])
        run(
            [
                PG_BIN / "pg_ctl",
                "-D",
                PG_DATA,
                "-l",
                PG_LOGS / "postgres-bootstrap.log",
                "-o",
                options,
                "-w",
                "start",
            ]
        )
    try:
        psql = [
            PG_BIN / "psql",
            "-h",
            PG_SOCKET,
            "-p",
            str(PG_PORT),
            "-d",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
        ]
        role_exists = run(
            [*psql, "-Atqc", f"SELECT 1 FROM pg_roles WHERE rolname='{DB_ROLE}'"],
            capture=True,
        ).stdout.strip()
        if role_exists != "1":
            run(psql, input_text=f"CREATE ROLE {DB_ROLE} LOGIN PASSWORD '{password}';\n")
        else:
            run(psql, input_text=f"ALTER ROLE {DB_ROLE} PASSWORD '{password}';\n")
        database_exists = run(
            [*psql, "-Atqc", f"SELECT 1 FROM pg_database WHERE datname='{DB_NAME}'"],
            capture=True,
        ).stdout.strip()
        if database_exists != "1":
            run(
                [
                    PG_BIN / "createdb",
                    "-h",
                    PG_SOCKET,
                    "-p",
                    str(PG_PORT),
                    "-O",
                    DB_ROLE,
                    "--encoding=UTF8",
                    "--locale=C",
                    "--template=template0",
                    DB_NAME,
                ]
            )
    finally:
        if started_here:
            run([PG_BIN / "pg_ctl", "-D", PG_DATA, "-m", "fast", "-w", "stop"], check=False)


def write_config() -> None:
    atomic_write(
        LOG_CONFIG,
        "version: 1\n"
        "formatters:\n"
        "  precise:\n"
        "    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(message)s'\n"
        "handlers:\n"
        "  file:\n"
        "    class: logging.handlers.TimedRotatingFileHandler\n"
        f"    filename: '{PG_LOGS / 'synapse.log'}'\n"
        "    formatter: precise\n"
        "    when: midnight\n"
        "    backupCount: 14\n"
        "  console:\n"
        "    class: logging.StreamHandler\n"
        "    formatter: precise\n"
        "root:\n"
        "  level: INFO\n"
        "  handlers: [file, console]\n"
        "disable_existing_loggers: false\n",
    )
    config = {
        "server_name": SERVER_NAME,
        "pid_file": str(RUNTIME_DIR / "homeserver.pid"),
        "public_baseurl": PUBLIC_BASEURL,
        "web_client_location": None,
        "listeners": [
            {
                "port": SYNAPSE_PORT,
                "type": "http",
                "tls": False,
                "bind_addresses": ["127.0.0.1", "::1"],
                "x_forwarded": True,
                "resources": [{"names": ["client", "federation"], "compress": True}],
            }
        ],
        "database": {
            "name": "psycopg2",
            "args": {
                "user": DB_ROLE,
                "password": secret_file(DB_SECRET),
                "database": DB_NAME,
                "host": "127.0.0.1",
                "port": PG_PORT,
                "cp_min": 1,
                "cp_max": 5,
            },
        },
        "log_config": str(LOG_CONFIG),
        "media_store_path": str(MEDIA),
        "signing_key_path": str(SECRET_DIR / "matrix.nealtheseal.org.signing.key"),
        "registration_shared_secret": secret_file(SECRET_DIR / "registration-shared-secret"),
        "macaroon_secret_key": secret_file(SECRET_DIR / "macaroon-secret"),
        "form_secret": secret_file(SECRET_DIR / "form-secret"),
        "enable_registration": False,
        "enable_registration_without_verification": False,
        "allow_public_rooms_without_auth": False,
        "allow_public_rooms_over_federation": False,
        "enable_metrics": False,
        "url_preview_enabled": False,
        "max_upload_size": "25M",
        "remote_media_lifetime": "30d",
        "app_service_config_files": [],
        "trusted_key_servers": [],
        "suppress_key_server_warning": True,
        "report_stats": False,
    }
    atomic_write(CONFIG, yaml.safe_dump(config, sort_keys=False))
    run([SYNAPSE, "--config-path", CONFIG, "--generate-missing-configs"])
    for path in CONFIG_DIR.iterdir():
        if path.is_file():
            path.chmod(0o600)
    for path in SECRET_DIR.iterdir():
        if path.is_file():
            path.chmod(0o600)


def launch_agent(label: str, arguments: list[str], log_name: str, throttle: int) -> bytes:
    payload = {
        "Label": label,
        "ProgramArguments": arguments,
        "RunAtLoad": True,
        "KeepAlive": {"PathState": {str(STATE_ROOT): True}},
        "ProcessType": "Background",
        "ThrottleInterval": throttle,
        "StandardOutPath": str(LOG_ROOT / log_name),
        "StandardErrorPath": str(LOG_ROOT / log_name),
        "WorkingDirectory": str(BASE),
        "EnvironmentVariables": {
            "PATH": f"{ZENITH_VENV / 'bin'}:{PG_BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONUNBUFFERED": "1",
            "LANG": "C",
            "LC_ALL": "C",
        },
    }
    return plistlib.dumps(payload, fmt=plistlib.FMT_XML, sort_keys=False)


def install_services() -> None:
    shutil.copy2(Path(__file__).resolve(), CONTROLLER)
    CONTROLLER.chmod(0o700)
    pg_plist = LAUNCH_AGENTS / f"{PG_LABEL}.plist"
    synapse_plist = LAUNCH_AGENTS / f"{SYNAPSE_LABEL}.plist"
    gateway_plist = LAUNCH_AGENTS / f"{GATEWAY_LABEL}.plist"
    pg_plist.write_bytes(
        launch_agent(PG_LABEL, [str(PYTHON), str(CONTROLLER), "run-postgres"], "postgres-launchd.log", 10)
    )
    synapse_plist.write_bytes(
        launch_agent(SYNAPSE_LABEL, [str(PYTHON), str(CONTROLLER), "run-synapse"], "synapse-launchd.log", 20)
    )
    gateway_plist.write_bytes(
        launch_agent(GATEWAY_LABEL, [str(PYTHON), str(CONTROLLER), "run-gateway"], "gateway-launchd.log", 10)
    )
    pg_plist.chmod(0o600)
    synapse_plist.chmod(0o600)
    gateway_plist.chmod(0o600)

    domain = f"gui/{os.getuid()}"
    for label, plist in (
        (PG_LABEL, pg_plist),
        (SYNAPSE_LABEL, synapse_plist),
        (GATEWAY_LABEL, gateway_plist),
    ):
        run(["launchctl", "bootout", f"{domain}/{label}"], check=False)
        run(["launchctl", "bootstrap", domain, plist])
        run(["launchctl", "kickstart", "-k", f"{domain}/{label}"])


def install_gateway_service() -> None:
    prepare_directories()
    shutil.copy2(Path(__file__).resolve(), CONTROLLER)
    CONTROLLER.chmod(0o700)
    gateway_plist = LAUNCH_AGENTS / f"{GATEWAY_LABEL}.plist"
    gateway_plist.write_bytes(
        launch_agent(GATEWAY_LABEL, [str(PYTHON), str(CONTROLLER), "run-gateway"], "gateway-launchd.log", 10)
    )
    gateway_plist.chmod(0o600)
    domain = f"gui/{os.getuid()}"
    run(["launchctl", "bootout", f"{domain}/{GATEWAY_LABEL}"], check=False)
    run(["launchctl", "bootstrap", domain, gateway_plist])
    run(["launchctl", "kickstart", "-k", f"{domain}/{GATEWAY_LABEL}"])
    wait_for_url(f"http://127.0.0.1:{GATEWAY_PORT}/_matrix/client/versions")
    print(f"NEAL public Matrix gateway is running on 127.0.0.1:{GATEWAY_PORT}")


def wait_for_url(url: str, timeout_seconds: int = 180) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                if 200 <= response.status < 300:
                    return
        except (OSError, urllib.error.URLError) as error:
            last_error = error
        time.sleep(2)
    raise DeploymentError(f"Timed out waiting for {url}: {last_error}")


def write_deployment_record() -> None:
    record = {
        "profile": "neal-native-macos",
        "server_name": SERVER_NAME,
        "public_baseurl": PUBLIC_BASEURL,
        "local_backend": f"http://127.0.0.1:{SYNAPSE_PORT}/",
        "filtered_public_gateway": f"http://127.0.0.1:{GATEWAY_PORT}/",
        "database": {"kind": "postgresql", "port": PG_PORT, "isolated_from_zenith": True},
        "storage": {
            "database_root": str(PG_DATA),
            "media_root": str(MEDIA),
            "backup_root": str(BACKUPS),
            "encryption": "inherits host disk encryption",
        },
        "registration": False,
        "production_ready": False,
        "live_beta": {
            "public_funnel": True,
            "well_known_discovery": True,
            "external_client_api": True,
            "public_admin_api_blocked": True,
            "canonical_room_created": True,
            "canonical_room_alias": "#neal-gc:matrix.nealtheseal.org",
            "canonical_room_id": "!kBjRkJEIsGBWCyrBQO:matrix.nealtheseal.org",
        },
        "remaining_gates": [
            "off-device encrypted backup",
            "verified durable production storage",
            "live knock, admit, and encrypted-message test from an unrelated homeserver",
            "backup moderator on an unrelated homeserver",
            "always-on host or accepted Mac availability dependency",
        ],
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    atomic_write(DEPLOYMENT, json.dumps(record, indent=2) + "\n")


def bootstrap() -> None:
    for path in (PYTHON, SYNAPSE, REGISTER_USER, PG_BIN / "initdb", PG_BIN / "postgres"):
        require_file(path)
    prepare_directories()
    initialize_postgres()
    write_config()
    install_services()
    wait_for_url(f"http://127.0.0.1:{SYNAPSE_PORT}/_matrix/client/versions")
    wait_for_url(f"http://127.0.0.1:{SYNAPSE_PORT}/_matrix/federation/v1/version")
    write_deployment_record()
    print(f"NEAL Synapse is running locally on 127.0.0.1:{SYNAPSE_PORT}")


def run_postgres() -> None:
    prepare_directories()
    os.execv(str(PG_BIN / "postgres"), postgres_arguments())


def run_synapse() -> None:
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline and not postgres_ready():
        time.sleep(2)
    if not postgres_ready():
        raise DeploymentError("NEAL PostgreSQL did not become ready")
    os.execv(str(SYNAPSE), [str(SYNAPSE), "--config-path", str(CONFIG)])


def run_gateway() -> None:
    from twisted.internet import reactor
    from twisted.web.proxy import ReverseProxyResource
    from twisted.web.resource import Resource
    from twisted.web.server import Site

    class BlockedResource(Resource):
        isLeaf = True

        def render(self, request):
            request.setResponseCode(404)
            request.setHeader(b"content-type", b"application/json")
            request.setHeader(b"cache-control", b"no-store")
            return b'{"errcode":"M_NOT_FOUND","error":"Not found"}'

    root = Resource()
    root.putChild(
        b"_matrix",
        ReverseProxyResource("127.0.0.1", SYNAPSE_PORT, b"/_matrix"),
    )
    synapse = Resource()
    synapse.putChild(
        b"client",
        ReverseProxyResource("127.0.0.1", SYNAPSE_PORT, b"/_synapse/client"),
    )
    synapse.putChild(b"admin", BlockedResource())
    root.putChild(b"_synapse", synapse)
    site = Site(root)
    reactor.listenTCP(GATEWAY_PORT, site, interface="127.0.0.1")
    reactor.run()


def status() -> None:
    client = f"http://127.0.0.1:{SYNAPSE_PORT}/_matrix/client/versions"
    federation = f"http://127.0.0.1:{SYNAPSE_PORT}/_matrix/federation/v1/version"
    print(f"server_name={SERVER_NAME}")
    print(f"postgres={'ready' if postgres_ready() else 'down'}")
    for label, url in (("client", client), ("federation", federation)):
        try:
            with urllib.request.urlopen(url, timeout=5) as response:
                print(f"{label}=http-{response.status}")
        except (OSError, urllib.error.URLError):
            print(f"{label}=down")


def register_user(username: str, admin: bool) -> None:
    command = [str(REGISTER_USER), "-c", str(CONFIG), "-u", username]
    if admin:
        command.append("-a")
    os.execv(command[0], command)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("bootstrap")
    subparsers.add_parser("run-postgres")
    subparsers.add_parser("run-synapse")
    subparsers.add_parser("run-gateway")
    subparsers.add_parser("install-gateway")
    subparsers.add_parser("record-current")
    subparsers.add_parser("status")
    register = subparsers.add_parser("register-user")
    register.add_argument("username")
    register.add_argument("--admin", action="store_true")
    args = parser.parse_args()

    if args.command == "bootstrap":
        bootstrap()
    elif args.command == "run-postgres":
        run_postgres()
    elif args.command == "run-synapse":
        run_synapse()
    elif args.command == "run-gateway":
        run_gateway()
    elif args.command == "install-gateway":
        install_gateway_service()
    elif args.command == "record-current":
        prepare_directories()
        write_deployment_record()
        print(f"Updated {DEPLOYMENT}")
    elif args.command == "status":
        status()
    elif args.command == "register-user":
        register_user(args.username, args.admin)


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
