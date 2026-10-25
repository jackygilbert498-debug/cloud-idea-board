"""Export a committed project and scanned Git history to a verified, non-clobber TAR.

Uses only Python's standard library and Git. Credential checks recognize common
formats, not arbitrary secrets; ignored machine configuration is never exported.
Verification reads members without extracting or executing archived content.
"""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile


ROOT = "board-handoff/"
MANIFEST = ROOT + "manifest.json"
MAX_FILE = 50 * 1024 * 1024
MAX_TOTAL = 200 * 1024 * 1024
MAX_MEMBERS = 5000
PRIVATE_PARTS = {".git", ".netlify", "node_modules", "__pycache__"}
PRIVATE_NAMES = {"auth.json", "config.json", "credentials.json", "id_rsa", "id_ed25519"}
CREDENTIALS = re.compile(
    rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|"
    rb"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|sb_secret_[A-Za-z0-9_-]{20,}|"
    rb"nfp_[A-Za-z0-9_-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)"
)
JWT = re.compile(rb"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")


class HandoffError(ValueError):
    """An unsafe input or failed handoff integrity check; never include file contents."""


def safe_name(name):
    """Require portable relative names, including Windows extraction constraints."""
    parts = name.split("/")
    if (not name or len(name) > 512 or "\\" in name or
            any(part in ("", ".", "..") or part.endswith((".", " ")) or
                re.search(r'[<>:"|?*\x00-\x1f]', part) or
                re.fullmatch(r"(?i)(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part)
                for part in parts)):
        raise HandoffError(f"unsafe archive path: {name!r}")
    return name


def private_path(name):
    parts = [part.casefold() for part in PurePosixPath(name).parts]
    return any(part in PRIVATE_PARTS or part.startswith(".env") or
               part in PRIVATE_NAMES or part.endswith((".log", ".pem", ".key", ".pyc"))
               for part in parts)


def reserve_name(name, seen):
    """Files cannot also be directories, including on case-insensitive targets."""
    key = safe_name(name).casefold()
    if any(key == prior or key.startswith(prior + "/") or prior.startswith(key + "/")
           for prior in seen):
        raise HandoffError(f"unsafe duplicate or file/directory path collision: {name}")
    seen.add(key)


def scan_credentials(data, label):
    """Reject recognizable credentials, including non-public Supabase service JWTs."""
    if CREDENTIALS.search(data):
        raise HandoffError(f"credential pattern detected in {label}")
    for match in JWT.finditer(data):
        try:
            payload = match.group().split(b".")[1]
            decoded = json.loads(base64.urlsafe_b64decode(payload + b"=" * (-len(payload) % 4)))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(decoded, dict) and decoded.get("role") == "service_role":
            raise HandoffError(f"credential pattern detected in {label}")


def scan_file(data, label):
    scan_credentials(data, label)
    if data.startswith(b"PK\x03\x04"):
        # Explicit receiver ZIP extras are inspected too; no nested archives.
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            if len(members) > MAX_MEMBERS or sum(item.file_size for item in members) > MAX_TOTAL:
                raise HandoffError(f"unsafe ZIP size: {label}")
            for member in members:
                safe_name(member.filename)
                if member.file_size > MAX_FILE or private_path(member.filename):
                    raise HandoffError(f"unsafe ZIP member: {label}")
                content = archive.read(member)
                if content.startswith((b"PK\x03\x04", b"\x1f\x8b")):
                    raise HandoffError(f"unsafe nested archive: {label}")
                scan_credentials(content, label)


def git(repo, *args, data=None):
    result = subprocess.run(["git", "-c", "core.quotepath=false", *args], cwd=repo,
                            input=data, capture_output=True, timeout=120)
    if result.returncode:
        # Do not print arbitrary Git stderr, which may contain credential-bearing URLs.
        raise HandoffError(f"Git {args[0]} failed (exit {result.returncode})")
    return result.stdout


def scan_history(repo, commit):
    """Scan every reachable blob/commit before exporting a self-contained bundle."""
    commits = git(repo, "rev-list", commit).decode().splitlines()
    for revision in commits:
        for entry in git(repo, "ls-tree", "-r", "-z", revision).split(b"\0"):
            if not entry:
                continue
            metadata, path = entry.split(b"\t", 1)
            name = path.decode("utf-8")
            safe_name(name)
            if private_path(name) or not metadata.startswith((b"100644 blob ", b"100755 blob ")):
                raise HandoffError(f"unsafe or credential path in Git history: {name}")
    objects = [line.split(b" ", 1)[0] for line in
               git(repo, "rev-list", "--objects", commit).splitlines()]
    query = b"\n".join(objects) + b"\n"
    sizes = git(repo, "cat-file", "--batch-check", data=query).splitlines()
    if len(sizes) > MAX_MEMBERS or any(int(line.split()[2]) > MAX_FILE for line in sizes) or \
            sum(int(line.split()[2]) for line in sizes) > MAX_TOTAL:
        raise HandoffError("unsafe Git history size")
    stream = io.BytesIO(git(repo, "cat-file", "--batch", data=query))
    for _ in objects:
        header = stream.readline().split()
        data = stream.read(int(header[2]))
        stream.read(1)
        if header[1] in (b"blob", b"commit", b"tag"):
            scan_file(data, f"Git object {header[0].decode()}")


def read_tar(path):
    """Read only bounded regular files; reject links and case-colliding duplicates."""
    if Path(path).stat().st_size > MAX_TOTAL * 2:
        raise HandoffError("unsafe TAR size")
    files, seen, total = {}, set(), 0
    with tarfile.open(path, "r:") as archive:
        for member in archive:
            name = safe_name(member.name)
            if (not name.startswith(ROOT) or not member.isfile() or member.issparse() or
                    member.size < 0 or member.size > MAX_FILE):
                raise HandoffError(f"unsafe TAR member: {name}")
            reserve_name(name, seen)
            total += member.size
            if len(seen) > MAX_MEMBERS or total > MAX_TOTAL:
                raise HandoffError("unsafe TAR size or member count")
            data = archive.extractfile(member).read()
            if len(data) != member.size:
                raise HandoffError(f"size mismatch: {name}")
            files[name] = data
    return files


def verify(path):
    files = read_tar(path)
    try:
        manifest = json.loads(files.pop(MANIFEST))
        entries = manifest["files"]
        if manifest["format"] != 1 or not isinstance(entries, dict) or set(entries) != set(files):
            raise ValueError()
        for name, data in files.items():
            if entries[name] != {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}:
                raise ValueError()
    except (KeyError, TypeError, ValueError, UnicodeDecodeError) as error:
        raise HandoffError("manifest/content mismatch") from error
    return {"verified": True, "source_commit": manifest.get("source_commit"), "files": len(files)}


def create(repo, output, extras):
    repo, output = Path(repo).resolve(strict=True), Path(output).absolute()
    if output.suffix != ".tar" or not output.parent.is_dir():
        raise HandoffError("output must be a .tar in an existing directory")
    parent = output.parent.resolve(strict=True)
    output = parent / output.name
    checksum = output.with_name(output.name + ".sha256")
    if parent == repo or repo in parent.parents or output.exists() or checksum.exists():
        raise HandoffError("output must be outside source and must not already exist")
    branch = git(repo, "branch", "--show-current").decode().strip()
    commit = git(repo, "rev-parse", "HEAD").decode().strip()
    if git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise HandoffError("shallow repository: obtain complete authorized history before packaging")
    if not branch or git(repo, "diff", "--name-only", "HEAD", "--").strip():
        raise HandoffError("commit all tracked source changes before packaging")
    for raw in git(repo, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0"):
        if raw and not private_path(raw.decode("utf-8")):
            raise HandoffError("commit all untracked source changes before packaging")
    scan_history(repo, commit)
    files, modes, seen = {}, {}, set()

    def add(name, data, mode=0o644):
        reserve_name(name, seen)
        if (name == MANIFEST or
                len(data) > MAX_FILE or len(files) >= MAX_MEMBERS - 1 or
                sum(map(len, files.values())) + len(data) > MAX_TOTAL):
            raise HandoffError(f"unsafe, duplicate or oversized input: {name}")
        scan_file(data, name)
        files[name], modes[name] = data, mode

    # Read Git objects directly: git archive obeys export-ignore/export-subst and
    # global newline settings, which can omit or rewrite committed source bytes.
    entries = []
    for raw in git(repo, "ls-tree", "-r", "-z", commit).split(b"\0"):
        if raw:
            metadata, name = raw.split(b"\t", 1)
            mode, _, oid = metadata.split()
            entries.append((name.decode("utf-8"), mode, oid))
    query = b"\n".join(oid for _, _, oid in entries) + b"\n"
    snapshot = io.BytesIO(git(repo, "cat-file", "--batch", data=query))
    for name, mode, _ in entries:
        size = int(snapshot.readline().split()[2])
        add(ROOT + "source/" + name, snapshot.read(size), int(mode, 8) & 0o755)
        snapshot.read(1)
    for extra in extras:
        name, separator, source = extra.partition("=")
        safe_name(name)
        if (not separator or name.split("/")[0].casefold() in {"source", "repository.bundle", "manifest.json"}
                or private_path(name)):
            raise HandoffError(f"unsafe extra: {name}")
        source = Path(source)
        if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_FILE:
            raise HandoffError(f"unsafe extra file: {name}")
        add(ROOT + name, source.read_bytes())
    with tempfile.TemporaryDirectory(prefix="board-handoff-", dir=parent) as temporary:
        staging = Path(temporary)
        bundle = staging / "repository.bundle"
        git(repo, "bundle", "create", str(bundle), commit, f"refs/heads/{branch}")
        heads = git(repo, "bundle", "list-heads", str(bundle)).decode().splitlines()
        if not heads or any(line.split()[0] != commit for line in heads):
            raise HandoffError("source branch changed during packaging; retry after committing")
        # A valid pack/manifest is not proof that all commit parents are present.
        # Restore to an empty bare repository before publishing, without hooks,
        # checkout filters or reliance on the source object's local availability.
        empty_template = staging / "empty-template"
        empty_template.mkdir()
        restored = staging / "bundle-check.git"
        git(repo, "-c", f"core.hooksPath={empty_template}", "clone", "--bare", "--quiet",
            f"--template={empty_template}", str(bundle), str(restored))
        if git(restored, "rev-parse", f"refs/heads/{branch}").decode().strip() != commit:
            raise HandoffError("bundle restore commit mismatch")
        git(restored, "fsck", "--full", "--no-dangling")
        add(ROOT + "repository.bundle", bundle.read_bytes())
        manifest = {"format": 1, "source_commit": commit, "branch": branch,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "files": {name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                              for name, data in sorted(files.items())}}
        files[MANIFEST] = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        tar_path = staging / "delivery.tar"
        with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as archive:
            for name, data in sorted(files.items()):
                member = tarfile.TarInfo(name)
                member.size, member.mode = len(data), modes.get(name, 0o644)
                archive.addfile(member, io.BytesIO(data))
        verify(tar_path)
        with tar_path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        checksum_temp = staging / "checksum.txt"
        checksum_temp.write_text(f"{digest}  {output.name}\n", encoding="utf-8")
        # Same-filesystem hard links atomically publish without ever replacing a target.
        # On a checksum race remove only our own just-published archive link.
        os.link(tar_path, output)
        try:
            os.link(checksum_temp, checksum)
        except OSError:
            if output.exists() and os.path.samefile(tar_path, output):
                output.unlink()
            raise
    return {"archive": str(output), "sha256": digest, "source_commit": commit,
            "branch": branch, "files": len(files), "verified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    build = subcommands.add_parser("create")
    build.add_argument("--repo", required=True)
    build.add_argument("--output", required=True)
    build.add_argument("--extra", action="append", default=[])
    check = subcommands.add_parser("verify")
    check.add_argument("archive")
    args = parser.parse_args()
    try:
        report = create(args.repo, args.output, args.extra) if args.command == "create" else verify(args.archive)
    except (HandoffError, OSError, subprocess.SubprocessError, tarfile.TarError,
            zipfile.BadZipFile, UnicodeError) as error:
        print(f"handoff: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
