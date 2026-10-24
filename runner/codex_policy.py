"""Fail closed on known API billing routes; never inspect or copy auth.json."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

from receiver_core import ReceiverError

PLAN_OVERRIDES = ["-c", 'model_provider="openai"', "-c", 'forced_login_method="chatgpt"']


def plan_environment(environment: dict | None = None) -> dict:
    """Retain local login/model context, remove API-key/base/WIF auth overrides."""
    source = os.environ if environment is None else environment
    excluded = {"CODEX_API_KEY", "CODEX_BASE_URL", "CODEX_AUTH_TOKEN", "CODEX_BEARER_TOKEN",
                "CHATGPT_ACCESS_TOKEN", "CHATGPT_BASE_URL", "CODEX_MODEL_PROVIDER", "CODEX_PROVIDER"}
    return {key: value for key, value in source.items()
            if not key.upper().startswith(("OPENAI_", "AZURE_OPENAI_")) and key.upper() not in excluded}


def _validate_values(value: dict) -> None:
    for key, item in value.items():
        if key == "model_provider" and item != "openai":
            raise ReceiverError("Custom Codex model provider is configured; this receiver requires the built-in OpenAI ChatGPT login.")
        if key in {"openai_base_url", "chatgpt_base_url"} and item:
            raise ReceiverError("Codex API base override is configured; remove it from the receiver user's configuration first.")
        if key == "model_providers" and item:
            raise ReceiverError("Custom Codex provider definitions are configured; use a ChatGPT-only Codex configuration for this receiver.")
        if key == "forced_login_method" and item != "chatgpt":
            raise ReceiverError("Codex configuration requires API authentication; ChatGPT login is required.")
        if isinstance(item, dict):
            _validate_values(item)


def validate_plan_configuration(project: Path, environment: dict | None = None) -> None:
    """Inspect known local configuration layers without disclosing their contents.

    The CLI doctor check below separately verifies the effective provider, including
    managed policy. Unknown future auth/config formats are refused, not guessed.
    """
    env = os.environ if environment is None else environment
    codex_home = Path(env.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
    paths = [codex_home / "config.toml", codex_home / "managed_config.toml", codex_home / "requirements.toml"]
    paths.extend(parent / ".codex/config.toml" for parent in [project.resolve(), *project.resolve().parents])
    if os.name == "nt":
        system = Path(env.get("PROGRAMDATA", "C:/ProgramData")) / "OpenAI/Codex"
    else:
        system = Path("/etc/codex")
    paths.extend(system / name for name in ("config.toml", "managed_config.toml", "requirements.toml"))
    visited = set()
    while paths:
        path = paths.pop()
        if path in visited or not path.exists():
            continue
        visited.add(path)
        try:
            if not path.is_file() or path.stat().st_size > 1048576:
                raise ValueError("invalid configuration file")
            with path.open("rb") as source:
                config = tomllib.load(source)
        except (OSError, ValueError) as caught:
            raise ReceiverError("Unable to verify Codex provider configuration; review it locally before using this receiver.") from caught
        _validate_values(config)
        profile = config.get("profile")
        if profile is not None:
            if not isinstance(profile, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", profile):
                raise ReceiverError("Unable to verify the selected Codex profile.")
            profile_path = codex_home / f"{profile}.config.toml"
            if not profile_path.is_file():
                raise ReceiverError("The selected Codex profile file is unavailable for verification.")
            paths.append(profile_path)


def ensure_plan_login(binary: Path, project: Path, *, environment: dict | None = None) -> None:
    """Check stored login and CLI's effective provider; never make an inference request."""
    validate_plan_configuration(project, environment)
    env = plan_environment(environment)
    options = {"cwd": str(project), "env": env, "capture_output": True, "timeout": 25,
               "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
    try:
        login = subprocess.run([str(binary), "login", "status"], **options)
        status = (login.stdout + login.stderr).decode("utf-8", errors="replace")
        if login.returncode or not re.search(r"(?im)^Logged in using ChatGPT\b", status):
            raise ReceiverError("A verified ChatGPT login is required. API-key, workload-identity, and unknown login modes are refused.")
        report = subprocess.run([str(binary), "doctor", "--json", *PLAN_OVERRIDES], **options)
        if report.returncode or len(report.stdout) > 262144:
            raise ReceiverError("Codex could not verify its effective ChatGPT configuration.")
        checks = json.loads(report.stdout).get("checks", {})
        config = checks.get("config.load", {})
        auth = checks.get("auth.credentials", {})
        details = auth.get("details", {})
        if (config.get("status") != "ok" or config.get("details", {}).get("model provider") != "openai"
                or auth.get("status") != "ok" or details.get("stored auth mode") != "chatgpt"
                or details.get("stored API key") != "false" or details.get("stored ChatGPT tokens") != "true"):
            raise ReceiverError("Effective Codex provider/auth could not be verified as ChatGPT-only; execution refused.")
    except (OSError, subprocess.SubprocessError, ValueError, AttributeError, TypeError) as caught:
        raise ReceiverError("Codex CLI login/provider verification failed. Use a supported CLI and review its local configuration.") from caught
