"""Local trust boundary, private durable state, and process exclusion."""
from __future__ import annotations

import csv
import ctypes
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


class ReceiverError(Exception):
    """An actionable receiver error that is safe to show without credentials."""


def default_config_directory() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "CloudIdeaBoard"
    return Path.home() / ".config/cloud-idea-board"


def parse_projects(values: list[str]) -> dict[str, str]:
    """Only local operator-supplied absolute existing directories form the allowlist."""
    projects = {}
    for value in values:
        key, separator, raw_path = value.partition("=")
        if not separator or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", key):
            raise ReceiverError("Project must use ID=ABSOLUTE_DIRECTORY with a simple project ID.")
        path = Path(raw_path).expanduser()
        if not path.is_absolute() or not path.is_dir() or key in projects:
            raise ReceiverError("Project directories must be absolute, existing, and have unique IDs.")
        projects[key] = str(path.resolve(strict=True))
    if not projects:
        raise ReceiverError("Configure at least one local project.")
    return projects


def project_directory(projects: dict[str, str], project_id: str) -> Path:
    if not isinstance(project_id, str) or project_id not in projects:
        raise ReceiverError("Task project is not mapped on this device.")
    path = Path(projects[project_id])
    if not path.is_absolute() or not path.is_dir() or path.resolve(strict=True) != path:
        raise ReceiverError("Mapped project moved, disappeared, or became a symbolic link; review local configuration.")
    return path


def validate_config_directory(directory: Path, projects: dict[str, str]) -> None:
    """Never place the bearer token inside an executable project or shipped receiver."""
    resolved = directory.expanduser().resolve()
    roots = [Path(value).resolve() for value in projects.values()]
    roots.append(Path(__file__).resolve().parent.parent)
    if any(resolved == root or resolved.is_relative_to(root) for root in roots):
        raise ReceiverError("Receiver configuration must be outside project and receiver source directories.")


def resolve_codex(value: str | None = None) -> Path:
    found = value or shutil.which("codex.exe" if os.name == "nt" else "codex")
    if not found:
        raise ReceiverError("Codex CLI is missing; install it and log in before pairing.")
    path = Path(found).expanduser()
    if not path.is_absolute() or not path.is_file() or path.suffix.lower() in (".cmd", ".bat", ".ps1"):
        raise ReceiverError("Use the absolute native Codex executable path, not a shell wrapper.")
    return path.resolve(strict=True)


def _redact_credential_values(text: str) -> str:
    """Scan quoted values linearly, including escaped or missing closing quotes."""
    credential_key = r"(?:api[_-]?key|(?:access|refresh|id)[_-]?token|password|secret|authorization)"
    prefix = re.compile(rf"(?i)[\"']?{credential_key}[\"']?\s*[:=]\s*")
    parts = []
    cursor = 0
    while match := prefix.search(text, cursor):
        parts.append(text[cursor:match.end()])
        start = match.end()
        if start == len(text):
            cursor = start
            break
        end = start
        quote = text[start] if text[start] in "\"'" else ""
        if quote:
            end += 1
            while end < len(text) and text[end] not in "\r\n":
                if text[end] == "\\":
                    # Consume each escaped character once. An unmatched final
                    # backslash belongs to the secret too, so it is also removed.
                    end += 1
                    if end < len(text) and text[end] not in "\r\n":
                        end += 1
                elif text[end] == quote:
                    end += 1
                    break
                else:
                    end += 1
            parts.append(f"{quote}[redacted]{quote}")
        else:
            while end < len(text) and not text[end].isspace() and text[end] not in ",;}":
                end += 1
            parts.append("[redacted]")
        cursor = end
    parts.append(text[cursor:])
    return "".join(parts)


def public_text(value: object, limit: int, secrets: tuple | list = ()) -> str:
    """Bound API text in UTF-16 units and remove common credential formats."""
    text = str(value or "")
    for secret in secrets:
        if isinstance(secret, str) and secret:
            text = text.replace(secret, "[redacted]")
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", text)
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b", "[redacted]", text)
    text = _redact_credential_values(text)
    return text.encode("utf-16-le", errors="replace")[:limit * 2].decode("utf-16-le", errors="ignore")


@lru_cache(maxsize=1)
def _windows_sid() -> str:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    identity = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True,
                              text=True, check=True, creationflags=flags, timeout=10)
    sid = next(csv.reader(identity.stdout.splitlines()))[1].strip()
    if not re.fullmatch(r"S-1-[0-9-]+", sid):
        raise ReceiverError("Unable to establish current Windows user ACL.")
    return sid


def _windows_private_acl(path: Path) -> None:
    # Replace the complete DACL atomically, including any previous explicit ACEs.
    # icacls /grant:r alone would leave an existing explicit Everyone ACE behind.
    from ctypes import wintypes
    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                                                                         ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    descriptor = ctypes.c_void_p()
    inheritance = "OICI" if path.is_dir() else ""
    sddl = f"D:P(A;{inheritance};FA;;;{_windows_sid()})"
    if not advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
        raise ReceiverError("Unable to create private Windows security descriptor.")
    try:
        if not advapi.SetFileSecurityW(str(path), 0x80000004, descriptor):
            raise ReceiverError("Unable to establish a current-user-only Windows ACL.")
    finally:
        kernel.LocalFree(descriptor)


class PrivateStore:
    """Atomic, flushed state writes; the parent directory is private to this user."""
    def __init__(self, directory: Path):
        requested = directory.expanduser().absolute()
        if requested.is_symlink() or (hasattr(requested, "is_junction") and requested.is_junction()):
            raise ReceiverError("Configuration directory must not be a symbolic link.")
        self.directory = requested.resolve()
        if self.directory.exists():
            allowed = {"config.json", "active-run.json", "receiver.lock", "receiver.log", "receiver.log.1", "receiver.log.2", "receiver.log.3", "launchd.log"}
            if any(entry.name not in allowed and not entry.name.startswith(".pending-") for entry in self.directory.iterdir()):
                raise ReceiverError("Choose an empty private configuration directory; unrelated files were found.")
            if os.name != "nt" and self.directory.stat().st_uid != os.getuid():
                raise ReceiverError("Configuration directory must belong to the current user.")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name == "nt":
            try:
                _windows_private_acl(self.directory)
            except (OSError, subprocess.SubprocessError, IndexError) as error:
                raise ReceiverError("Unable to protect Windows configuration ACL; no token was stored.") from error
        else:
            self.directory.chmod(0o700)

    def _path(self, name: str) -> Path:
        if name not in {"config.json", "active-run.json", "receiver.lock"}:
            raise ReceiverError("Invalid private state filename.")
        path = self.directory / name
        if path.is_symlink():
            raise ReceiverError("Private state must not be a symbolic link.")
        if path.exists():
            if os.name == "nt":
                _windows_private_acl(path)
            else:
                path.chmod(0o600)
        return path

    def read(self, name: str) -> dict | None:
        path = self._path(name)
        if not path.exists():
            return None
        try:
            if path.stat().st_size > 262144:
                raise ValueError("oversize")
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError("object required")
            return value
        except (ValueError, OSError) as error:
            raise ReceiverError(f"Private {name} is unreadable; review it locally before continuing.") from error

    def write(self, name: str, value: dict) -> None:
        target = self._path(name)
        descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=self.directory)
        try:
            os.chmod(temporary, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(value, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            if os.name != "nt":
                directory_fd = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def clear_active(self) -> None:
        self._path("active-run.json").unlink(missing_ok=True)


class InstanceLock:
    """The OS releases this lock on exit, including abnormal process termination."""
    def __init__(self, store: PrivateStore):
        self.path = store._path("receiver.lock")
        self.handle = None

    def __enter__(self):
        self.handle = open(self.path, "a+b")
        try:
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt
                if self.path.stat().st_size == 0:
                    self.handle.write(b"0")
                    self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            self.handle.close()
            self.handle = None
            raise ReceiverError("Another receiver is already running for this configuration.") from error
        return self

    def __exit__(self, *_):
        if self.handle:
            if os.name == "nt":
                import msvcrt
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            self.handle.close()
