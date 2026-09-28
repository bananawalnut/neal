#!/usr/bin/env python3
"""Safely switch NEAL Synapse between invite-only and CAPTCHA registration."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request


BEGIN = "# BEGIN NEAL REGISTRATION POLICY"
END = "# END NEAL REGISTRATION POLICY"
LEGACY_BLOCK = """enable_registration: true
enable_registration_without_verification: true
registration_requires_token: true"""


def render_policy(mode: str) -> str:
    if mode not in {"captcha", "invite-only"}:
        raise ValueError(f"Unsupported registration mode: {mode}")
    captcha = mode == "captcha"
    lines = [
        BEGIN,
        "enable_registration: true",
        "enable_registration_without_verification: false",
        f"registration_requires_token: {'false' if captcha else 'true'}",
        f"enable_registration_captcha: {'true' if captcha else 'false'}",
    ]
    if captcha:
        lines.extend(
            [
                "recaptcha_public_key_path: /data/recaptcha-public-key",
                "recaptcha_private_key_path: /data/recaptcha-private-key",
            ]
        )
    lines.extend(
        [
            "password_config:",
            "  enabled: true",
            "  localdb_enabled: true",
            "  policy:",
            "    enabled: true",
            "    minimum_length: 12",
            END,
        ]
    )
    return "\n".join(lines)


def replace_policy(config: str, mode: str) -> str:
    replacement = render_policy(mode)
    if BEGIN in config or END in config:
        if config.count(BEGIN) != 1 or config.count(END) != 1:
            raise ValueError("Registration policy markers are missing or duplicated.")
        start = config.index(BEGIN)
        finish = config.index(END, start) + len(END)
        return config[:start] + replacement + config[finish:]

    conflicting = (
        "enable_registration_captcha:",
        "recaptcha_public_key:",
        "recaptcha_public_key_path:",
        "recaptcha_private_key:",
        "recaptcha_private_key_path:",
        "password_config:",
    )
    if any(line.startswith(conflicting) for line in config.splitlines()):
        raise ValueError("Refusing to overwrite an unmanaged registration or password policy.")
    if config.count(LEGACY_BLOCK) != 1:
        raise ValueError("The expected legacy registration block was not found exactly once.")
    return config.replace(LEGACY_BLOCK, replacement, 1)


def read_key(path: Path) -> bytes:
    value = path.read_bytes().strip()
    if not value or b"\n" in value or b"\r" in value:
        raise ValueError(f"{path} must contain one non-empty key on one line.")
    return value + b"\n"


def atomic_write(path: Path, data: bytes, mode: int, uid: int, gid: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def snapshot(path: Path) -> tuple[bytes | None, int, int, int]:
    if not path.exists():
        return None, 0o600, 991, 991
    stat = path.stat()
    return path.read_bytes(), stat.st_mode & 0o777, stat.st_uid, stat.st_gid


def restore(path: Path, prior: tuple[bytes | None, int, int, int]) -> None:
    data, mode, uid, gid = prior
    if data is None:
        path.unlink(missing_ok=True)
    else:
        atomic_write(path, data, mode, uid, gid)


def run_compose(project_root: Path, *arguments: str) -> None:
    subprocess.run(["docker", "compose", *arguments], cwd=project_root, check=True)


def validate_and_restart(project_root: Path) -> None:
    run_compose(
        project_root,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "python",
        "synapse",
        "-m",
        "synapse.config",
        "-c",
        "/data/homeserver.yaml",
    )
    run_compose(project_root, "up", "-d", "synapse")
    for _ in range(36):
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8008/_matrix/client/versions", timeout=5
            ) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(5)
    raise RuntimeError("Synapse did not become ready after the registration change.")


def configure(args: argparse.Namespace) -> None:
    if os.geteuid() != 0:
        raise PermissionError("Run this command as root on the Matrix VPS.")

    project_root = Path(args.project_root).resolve()
    synapse_root = project_root / "runtime" / "synapse"
    config_path = synapse_root / "homeserver.yaml"
    public_path = synapse_root / "recaptcha-public-key"
    private_path = synapse_root / "recaptcha-private-key"
    if not config_path.is_file():
        raise FileNotFoundError(f"Synapse config is missing: {config_path}")

    new_config = replace_policy(config_path.read_text(), args.mode).encode()
    new_public = new_private = None
    if args.mode == "captcha":
        if not args.public_key_file or not args.private_key_file:
            raise ValueError("CAPTCHA mode requires --public-key-file and --private-key-file.")
        new_public = read_key(Path(args.public_key_file))
        new_private = read_key(Path(args.private_key_file))

    paths = (config_path, public_path, private_path)
    prior = {path: snapshot(path) for path in paths}
    backup = config_path.with_name(f"homeserver.yaml.pre-registration-{int(time.time())}")
    shutil.copy2(config_path, backup)
    try:
        config_stat = config_path.stat()
        atomic_write(
            config_path,
            new_config,
            config_stat.st_mode & 0o777,
            config_stat.st_uid,
            config_stat.st_gid,
        )
        if new_public is not None and new_private is not None:
            atomic_write(public_path, new_public, 0o600, 991, 991)
            atomic_write(private_path, new_private, 0o600, 991, 991)
        validate_and_restart(project_root)
    except Exception:
        for path in paths:
            restore(path, prior[path])
        try:
            run_compose(project_root, "up", "-d", "synapse")
        except Exception as rollback_error:
            print(f"Rollback restart also failed: {rollback_error}", file=sys.stderr)
        raise

    print(f"Synapse registration mode is now {args.mode}.")
    print(f"Previous config: {backup}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)
    render = subparsers.add_parser("render", help="Render the managed YAML policy block.")
    render.add_argument("mode", choices=("captcha", "invite-only"))

    apply = subparsers.add_parser("apply", help="Apply, validate, and restart Synapse.")
    apply.add_argument("mode", choices=("captcha", "invite-only"))
    apply.add_argument("--public-key-file")
    apply.add_argument("--private-key-file")
    apply.add_argument("--project-root", default="/srv/neal-matrix")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "render":
            print(render_policy(args.mode))
        else:
            configure(args)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Registration change failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
