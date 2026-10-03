#!/usr/bin/env python3
"""Build or verify the self-contained NEAL access-issuer release bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
from pathlib import Path
from typing import Any


BUNDLE_SCHEMA = "neal.access-issuer-bundle/v1"
SBOM_SCHEMA = "CycloneDX"
RUNTIME_FILES = (
    "issuer.py",
    "admin_broker.py",
    "reconcile.py",
    "backup.py",
    "s3_backup.py",
    "build_bundle.py",
    "requirements-deploy.txt",
    "access-issuer.env.example",
    "install.sh",
    "neal-access-issuer.service",
    "neal-admin-monitor.service",
    "neal-access-issuer-backup.service",
    "neal-access-issuer-backup.timer",
    "neal-access-restore-verify.service",
    "neal-access-restore-verify.timer",
    "s3-upload-target.example.json",
    "s3-restore-target.example.json",
    "s3-append-only-policy.example.json",
    "s3-restore-policy.example.json",
    "solana-rpc-set.mainnet.example.json",
    "solana-rpc-set.devnet-quorum.example.json",
    "solana-rpc-set.devnet-preview.example.json",
    "README.md",
)


class BundleError(RuntimeError):
    pass


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii") + b"\n"


def git_commit(source: Path) -> str:
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=source, check=True, capture_output=True, text=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise BundleError("Unable to determine the source commit") from error
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise BundleError("Source commit is invalid")
    return commit


def require_clean(source: Path) -> None:
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as error:
        raise BundleError("Unable to inspect the source checkout") from error
    if status:
        raise BundleError("Release bundle source checkout is not clean")


def payload_files(root: Path) -> list[Path]:
    files = [root / name for name in RUNTIME_FILES]
    wheelhouse = root / "wheelhouse"
    if not wheelhouse.is_dir():
        raise BundleError("Offline wheelhouse is missing")
    files.extend(sorted(wheelhouse.glob("*.whl")))
    for path in files:
        if path.is_symlink() or not path.is_file():
            raise BundleError(f"Required bundle payload is missing or unsafe: {path.name}")
    return files


def file_record(path: Path, relative: Path) -> dict[str, Any]:
    return {
        "path": relative.as_posix(),
        "mode": format(stat.S_IMODE(path.stat().st_mode), "04o"),
        "bytes": path.stat().st_size,
        "sha256": digest(path),
    }


def component_from_requirement(line: str) -> dict[str, str] | None:
    match = re.match(r"^([A-Za-z0-9_.-]+)==([^ ]+)", line)
    if not match:
        return None
    return {"type": "library", "name": match.group(1), "version": match.group(2)}


def build(source: Path, output: Path, archive: Path | None, allow_dirty: bool) -> dict[str, Any]:
    source = source.resolve()
    repository = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], cwd=source, check=True, capture_output=True, text=True
    ).stdout.strip()
    commit = git_commit(Path(repository))
    if not allow_dirty:
        require_clean(Path(repository))
    if output.exists() or output.is_symlink():
        raise BundleError("Bundle output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{output.name}.", dir=output.parent) as temporary_name:
        staging = Path(temporary_name) / output.name
        staging.mkdir(mode=0o755)
        records: list[dict[str, Any]] = []
        for path in payload_files(source):
            relative = path.relative_to(source)
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, destination)
            mode = 0o755 if path.name.endswith(".py") or path.name == "install.sh" else 0o644
            os.chmod(destination, mode)
            records.append(file_record(destination, relative))
        (staging / "SOURCE_COMMIT").write_text(f"{commit}\n", encoding="ascii")
        os.chmod(staging / "SOURCE_COMMIT", 0o644)
        records.append(file_record(staging / "SOURCE_COMMIT", Path("SOURCE_COMMIT")))
        requirements = (source / "requirements-deploy.txt").read_text(encoding="utf-8").splitlines()
        components = [component for line in requirements if (component := component_from_requirement(line))]
        sbom = {
            "bomFormat": SBOM_SCHEMA,
            "specVersion": "1.6",
            "version": 1,
            "metadata": {"component": {"type": "application", "name": "neal-access-issuer", "version": commit}},
            "components": components,
        }
        (staging / "sbom.cdx.json").write_bytes(canonical_json(sbom))
        os.chmod(staging / "sbom.cdx.json", 0o644)
        records.append(file_record(staging / "sbom.cdx.json", Path("sbom.cdx.json")))
        manifest = {
            "schema": BUNDLE_SCHEMA,
            "sourceCommit": commit,
            "runtime": {"os": "ubuntu-24.04", "architecture": "x86_64", "python": "3.12"},
            "files": sorted(records, key=lambda value: value["path"]),
        }
        (staging / "bundle-manifest.json").write_bytes(canonical_json(manifest))
        os.chmod(staging / "bundle-manifest.json", 0o644)
        os.replace(staging, output)
    verify(output)
    if archive is not None:
        if archive.exists() or archive.is_symlink():
            raise BundleError("Bundle archive already exists")
        with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as tar:
            for path in sorted(output.rglob("*")):
                relative = Path(output.name) / path.relative_to(output)
                info = tar.gettarinfo(str(path), arcname=relative.as_posix())
                info.uid = info.gid = 0
                info.uname = info.gname = "root"
                info.mtime = 0
                if path.is_file():
                    with path.open("rb") as handle:
                        tar.addfile(info, handle)
                else:
                    tar.addfile(info)
    return manifest


def verify(bundle: Path) -> dict[str, Any]:
    manifest_path = bundle / "bundle-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="ascii"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BundleError("Bundle manifest is unavailable or invalid") from error
    if set(manifest) != {"schema", "sourceCommit", "runtime", "files"} or manifest["schema"] != BUNDLE_SCHEMA:
        raise BundleError("Bundle manifest contract is unsupported")
    if manifest["runtime"] != {"os": "ubuntu-24.04", "architecture": "x86_64", "python": "3.12"}:
        raise BundleError("Bundle runtime contract is unsupported")
    declared: set[str] = set()
    for record in manifest["files"]:
        if set(record) != {"path", "mode", "bytes", "sha256"}:
            raise BundleError("Bundle file record is invalid")
        relative = Path(record["path"])
        if relative.is_absolute() or ".." in relative.parts or relative.as_posix() in declared:
            raise BundleError("Bundle file path is unsafe or duplicated")
        declared.add(relative.as_posix())
        path = bundle / relative
        if path.is_symlink() or not path.is_file():
            raise BundleError(f"Bundle file is missing or unsafe: {relative}")
        if (
            stat.S_IMODE(path.stat().st_mode) != int(record["mode"], 8)
            or path.stat().st_size != record["bytes"]
            or digest(path) != record["sha256"]
        ):
            raise BundleError(f"Bundle file verification failed: {relative}")
    actual = {
        path.relative_to(bundle).as_posix()
        for path in bundle.rglob("*")
        if path.is_file() and path.name != "bundle-manifest.json"
    }
    if actual != declared:
        raise BundleError("Bundle contains an undeclared file or omits a declared file")
    source_commit = (bundle / "SOURCE_COMMIT").read_text(encoding="ascii").strip()
    if source_commit != manifest["sourceCommit"] or not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise BundleError("Bundle source commit does not match its manifest")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_command = commands.add_parser("build")
    build_command.add_argument("--source", type=Path, default=Path(__file__).resolve().parent)
    build_command.add_argument("--output", type=Path, required=True)
    build_command.add_argument("--archive", type=Path)
    build_command.add_argument("--allow-dirty", action="store_true", help="tests only; forbidden for release evidence")
    verify_command = commands.add_parser("verify")
    verify_command.add_argument("--bundle", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    options = parse_args()
    manifest = (
        build(options.source, options.output, options.archive, options.allow_dirty)
        if options.command == "build"
        else verify(options.bundle)
    )
    print(json.dumps({"schema": manifest["schema"], "sourceCommit": manifest["sourceCommit"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BundleError, OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=os.sys.stderr)
        raise SystemExit(1)
