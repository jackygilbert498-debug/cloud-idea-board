"""Per-user logon installation, without administrator access or embedded secrets."""
from __future__ import annotations

import csv
import hashlib
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

from receiver_core import PrivateStore, ReceiverError


def installation_id(directory: Path) -> str:
    return hashlib.sha256(str(directory.resolve()).encode()).hexdigest()[:12]


def launch_agent_bytes(directory: Path, python: str, script: str) -> bytes:
    label = f"com.cloud-idea-board.receiver.{installation_id(directory)}"
    return plistlib.dumps({"Label": label, "ProgramArguments": [python, script, "run", "--config", str(directory)],
                          "RunAtLoad": True, "KeepAlive": {"SuccessfulExit": False}, "ThrottleInterval": 30,
                          "ProcessType": "Background", "WorkingDirectory": str(Path(script).parent),
                          "StandardOutPath": str(directory / "launchd.log"), "StandardErrorPath": str(directory / "launchd.log")})


def windows_task_xml(directory: Path, python: str, script: str, user: str) -> bytes:
    namespace = "http://schemas.microsoft.com/windows/2004/02/mit/task"
    ET.register_namespace("", namespace)

    def element(parent, tag, value=None, **attributes):
        node = ET.SubElement(parent, f"{{{namespace}}}{tag}", attributes)
        node.text = value
        return node

    root = ET.Element(f"{{{namespace}}}Task", {"version": "1.2"})
    triggers = element(root, "Triggers")
    trigger = element(triggers, "LogonTrigger")
    element(trigger, "Enabled", "true")
    element(trigger, "UserId", user)
    principal = element(element(root, "Principals"), "Principal", id="CurrentUser")
    element(principal, "UserId", user)
    element(principal, "LogonType", "InteractiveToken")
    element(principal, "RunLevel", "LeastPrivilege")
    settings = element(root, "Settings")
    for key, value in {"MultipleInstancesPolicy": "IgnoreNew", "DisallowStartIfOnBatteries": "false",
                       "StopIfGoingOnBatteries": "false", "StartWhenAvailable": "true", "Enabled": "true",
                       "Hidden": "true", "ExecutionTimeLimit": "PT0S"}.items():
        element(settings, key, value)
    restart = element(settings, "RestartOnFailure")
    element(restart, "Interval", "PT1M")
    element(restart, "Count", "3")
    action = element(element(root, "Actions", Context="CurrentUser"), "Exec")
    element(action, "Command", python)
    element(action, "Arguments", subprocess.list2cmdline([script, "run", "--config", str(directory)]))
    element(action, "WorkingDirectory", str(Path(script).parent))
    return ET.tostring(root, encoding="utf-16", xml_declaration=True)


def _run(arguments: list[str], *, check=True):
    return subprocess.run(arguments, capture_output=True, check=check, timeout=30,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _mac_target(store: PrivateStore):
    if store.directory.stat().st_uid != os.getuid():
        raise ReceiverError("Only the owner of a paired configuration can install this receiver.")
    directory = Path.home() / "Library/LaunchAgents"
    directory.mkdir(parents=True, exist_ok=True)
    label = f"com.cloud-idea-board.receiver.{installation_id(store.directory)}"
    return directory / f"{label}.plist", f"gui/{os.getuid()}/{label}"


def install(store: PrivateStore) -> None:
    config = store.read("config.json")
    if not config or not config.get("deviceId") or not config.get("token"):
        raise ReceiverError("Pair this user's device before installing a logon receiver.")
    python = str(Path(sys.executable).resolve())
    script = str(Path(__file__).with_name("receiver.py").resolve())
    if os.name == "nt":
        pythonw = Path(python).with_name("pythonw.exe")
        if not pythonw.is_file():
            raise ReceiverError("pythonw.exe is required for a hidden Windows logon task.")
        identity = _run(["whoami", "/user", "/fo", "csv", "/nh"])
        user = next(csv.reader(identity.stdout.decode(errors="replace").splitlines()))[1].strip()
        data = windows_task_xml(store.directory, str(pythonw), script, user)
        descriptor, temporary = tempfile.mkstemp(suffix=".xml", dir=store.directory)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
            _run(["schtasks.exe", "/Create", "/TN", f"CloudIdeaBoard-{installation_id(store.directory)}", "/XML", temporary, "/F"])
        finally:
            Path(temporary).unlink(missing_ok=True)
        print("Current-user hidden logon task installed. It starts at next login; run manually to start now.")
    elif sys.platform == "darwin":
        target, service = _mac_target(store)
        if target.is_symlink():
            raise ReceiverError("LaunchAgent target must not be a symbolic link.")
        target.write_bytes(launch_agent_bytes(store.directory, python, script))
        target.chmod(0o600)
        _run(["launchctl", "bootout", service], check=False)
        _run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(target)])
        print("Current-user LaunchAgent installed and started.")
    else:
        raise ReceiverError("Logon installation supports Windows and macOS only.")


def uninstall(store: PrivateStore) -> None:
    if os.name == "nt":
        name = f"CloudIdeaBoard-{installation_id(store.directory)}"
        existing = _run(["schtasks.exe", "/Query", "/TN", name], check=False)
        if existing.returncode == 0:
            _run(["schtasks.exe", "/End", "/TN", name], check=False)
            _run(["schtasks.exe", "/Delete", "/TN", name, "/F"])
    elif sys.platform == "darwin":
        target, service = _mac_target(store)
        _run(["launchctl", "bootout", service], check=False)
        if target.is_symlink():
            raise ReceiverError("Refusing to remove a symbolic link LaunchAgent target.")
        target.unlink(missing_ok=True)
    else:
        raise ReceiverError("Logon installation supports Windows and macOS only.")
    print("This user's receiver logon registration removed. Private configuration and run history were preserved.")
