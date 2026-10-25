#!/usr/bin/env python3
"""Cloud Idea Board receiver: outbound HTTPS only, Python 3.11+ standard library."""
from __future__ import annotations

import argparse
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import platform
import signal
import subprocess
import sys
import threading
import time
from urllib import error, parse, request

from codex_executor import execute_task
from codex_policy import ensure_plan_login
from receiver_core import (InstanceLock, PrivateStore, ReceiverError, default_config_directory,
                           parse_projects, project_directory, public_text, resolve_codex,
                           validate_config_directory)

LOG = logging.getLogger("cloud-idea-board.receiver")


def configure_logging(store: PrivateStore, secrets: tuple | list = ()) -> None:
    """A bounded private log works with Windows pythonw and launchd as well as a terminal."""
    class Redact(logging.Filter):
        def filter(self, record):
            record.msg = public_text(record.getMessage(), 2000, secrets)
            record.args = ()
            return True

    path = store.directory / "receiver.log"
    if path.is_symlink():
        raise ReceiverError("Private log must not be a symbolic link.")
    for handler in list(LOG.handlers):
        handler.close()
        LOG.removeHandler(handler)
    for log_filter in list(LOG.filters):
        LOG.removeFilter(log_filter)
    file_handler = RotatingFileHandler(path, maxBytes=262144, backupCount=3, encoding="utf-8")
    if os.name != "nt":
        path.chmod(0o600)
    file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.addHandler(file_handler)
    LOG.addFilter(Redact())
    LOG.setLevel(logging.INFO)
    LOG.propagate = False
    if sys.stderr is not None and sys.stderr.isatty():
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        LOG.addHandler(console)


class ApiError(ReceiverError):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code
        super().__init__(f"Runner API request failed (HTTP {status}, {public_text(code, 80)}).")


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ApiClient:
    def __init__(self, server: str, token: str | None = None, *, allow_local_http=False):
        parsed = parse.urlsplit(server)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (parsed.scheme != "https" and not (allow_local_http and parsed.scheme == "http" and local)
                or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/", "/api/codex-runner")):
            raise ReceiverError("Server must be an HTTPS origin. Local HTTP tests require --allow-local-http.")
        try:
            parsed.port
        except ValueError as caught:
            raise ReceiverError("Invalid server port.") from caught
        self.url = parse.urlunsplit((parsed.scheme, parsed.netloc, "/api/codex-runner", "", ""))
        self.token = token
        self.opener = request.build_opener(NoRedirect())
        self.pending_lock = threading.Lock()
        self.pending_request = None

    def call(self, action: str, payload: dict | None = None, *, authenticated=True, timeout=10) -> dict:
        """Bound the entire request, including a server that keeps streaming bytes.

        One daemon worker owns the request. An uncertain timeout never creates an
        overlapping request; the control loop stays free to enforce lease expiry.
        """
        completed = threading.Event()
        outcome = {}

        def perform():
            try:
                outcome["response"] = self._request(action, payload, authenticated=authenticated, timeout=timeout)
            except Exception as caught:
                outcome["error"] = caught
            finally:
                completed.set()

        with self.pending_lock:
            if self.pending_request and not self.pending_request.is_set():
                raise ApiError(0, "previous_request_pending")
            worker = threading.Thread(target=perform, daemon=True)
            self.pending_request = completed
            worker.start()
        if not completed.wait(max(0.001, timeout)):
            raise ApiError(0, "request_deadline_exceeded")
        if "error" in outcome:
            raise outcome["error"]
        return outcome["response"]

    def _request(self, action: str, payload: dict | None, *, authenticated: bool, timeout: float) -> dict:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if authenticated:
            if not self.token:
                raise ReceiverError("This device is not paired.")
            headers["Authorization"] = f"Bearer {self.token}"
        body = json.dumps({"action": action, **(payload or {})}, ensure_ascii=False).encode("utf-8")
        req = request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with self.opener.open(req, timeout=max(0.1, timeout)) as response:
                raw = response.read(262145)
                if len(raw) > 262144:
                    raise ApiError(502, "oversize_response")
                value = json.loads(raw)
                if not isinstance(value, dict) or "error" in value:
                    raise ApiError(502, "invalid_response")
                return value
        except error.HTTPError as caught:
            # Never trust a server error body to be free of tokens or task text.
            try:
                value = json.loads(caught.read(8192))
                code = value.get("error", {}).get("code", "request_failed")
                if not isinstance(code, str) or not code.replace("_", "").replace("-", "").isalnum():
                    code = "request_failed"
            except (ValueError, AttributeError):
                code = "request_failed"
            raise ApiError(caught.code, code) from None
        except (error.URLError, TimeoutError, OSError) as caught:
            raise ApiError(0, "network_unavailable") from caught
        except (ValueError, UnicodeError) as caught:
            raise ApiError(502, "invalid_response") from caught


def project_labels(config: dict) -> list[dict]:
    return [{"id": key, "label": key} for key in config["projects"]]


def validate_task(task: dict) -> None:
    for key, limit in (("id", 200), ("runToken", 500), ("projectId", 80),
                       ("title", 240), ("prompt", 20000), ("acceptance", 4000)):
        value = task.get(key)
        if not isinstance(value, str) or len(value) > limit or (key != "acceptance" and not value):
            raise ReceiverError("Claimed task has invalid fields; execution refused.")


class ReceiverService:
    def __init__(self, config: dict, store: PrivateStore, api: ApiClient, *, stop: threading.Event | None = None,
                 task_timeout=7200):
        self.config, self.store, self.api = config, store, api
        self.stop = stop or threading.Event()
        self.task_timeout = task_timeout

    def recover(self) -> bool:
        """Flush a durable completion or report interruption; never replay a claimed task."""
        record = self.store.read("active-run.json")
        if not record:
            return True
        if not all(isinstance(record.get(key), str) and record[key] for key in ("taskId", "runToken")):
            raise ReceiverError("Local active run identity is invalid; inspect its private record before proceeding.")
        if not record.get("completion") and (record.get("platform") == "macos" or
                (not record.get("platform") and sys.platform == "darwin")):
            # A hard-killed parent cannot prove its old POSIX process group is gone.
            # Do not kill a saved PID (it could have been reused), and never claim again
            # until a local operator has inspected the old session and confirmed stop.
            record["orphanReviewRequired"] = True
        if record.get("completionReported"):
            return False if record.get("orphanReviewRequired") else True
        payload = record.get("completion") or {"taskId": record["taskId"], "runToken": record["runToken"],
                   "status": "needs_attention", "result": "", "error": "Receiver restarted during execution; inspect local changes before another task.", "sessionId": None}
        record["completion"] = payload
        self.store.write("active-run.json", record)
        try:
            response = self.api.call("complete", payload)
            if response.get("ok") is not True:
                return False
        except ApiError as caught:
            if caught.status in {401, 403, 404, 409, 410}:
                # The server owns lease expiry / revocation state; it cannot accept this run anymore.
                LOG.warning("Old run no longer writable; task requires server-side review (%s).", caught.status)
            else:
                LOG.warning("Completion pending; retrying without executing another task.")
                return False
        if record.get("orphanReviewRequired"):
            record["completionReported"] = True
            self.store.write("active-run.json", record)
            LOG.error("Interrupted Mac execution requires local review; run recover --confirm-stopped after checking the old session. No new tasks will be claimed.")
            return False
        self.store.clear_active()
        return True

    def make_control(self, record: dict, deadline: float):
        next_progress = 0.0
        started = time.monotonic()

        def control():
            nonlocal deadline, next_progress
            now = time.monotonic()
            if self.stop.is_set() or now >= deadline:
                return "needs_attention"
            if now < next_progress:
                return None
            request_started = now
            try:
                response = self.api.call("progress", {"taskId": record["taskId"], "runToken": record["runToken"],
                                         "summary": f"Codex is executing on the paired device; elapsed {int(now - started)}s."},
                                         timeout=min(10, deadline - now))
                if response.get("cancelRequested") is True:
                    return "cancelled"
                lease = response.get("leaseSeconds")
                if not isinstance(lease, (int, float)) or isinstance(lease, bool) or lease <= 0 or lease > 90:
                    return "needs_attention"
                deadline = request_started + lease
                next_progress = time.monotonic() + 20
            except ApiError as caught:
                if caught.status in {401, 403, 404, 409, 410}:
                    return "needs_attention"
                next_progress = time.monotonic() + 3
            return "needs_attention" if time.monotonic() >= deadline else None
        return control

    def run_once(self) -> bool:
        if not self.recover() or self.stop.is_set():
            return False
        self.api.call("heartbeat", {"projects": project_labels(self.config)})
        claim_started = time.monotonic()
        response = self.api.call("claim")
        task = response.get("task")
        if task is None:
            return False
        if not isinstance(task, dict) or not isinstance(task.get("id"), str) or not isinstance(task.get("runToken"), str):
            raise ReceiverError("Claim response has no valid run identity; execution refused.")
        record = {"taskId": task["id"], "runToken": task["runToken"], "phase": "claimed", "claimedAt": time.time(),
                  "platform": "windows" if os.name == "nt" else "macos"}
        # This write precedes all process creation. A crash now is an interruption, never a retry.
        self.store.write("active-run.json", record)
        try:
            validate_task(task)
            project = project_directory(self.config["projects"], task["projectId"])
            ensure_plan_login(resolve_codex(self.config["codex"]), project)
            lease = response.get("leaseSeconds")
            if not isinstance(lease, (int, float)) or isinstance(lease, bool) or not 0 < lease <= 90:
                raise ReceiverError("Invalid task lease; execution refused.")

            def on_started(pid):
                record.update({"phase": "running", "pid": pid})
                self.store.write("active-run.json", record)

            result = execute_task(task, project, resolve_codex(self.config["codex"]),
                                  self.make_control(record, claim_started + lease), timeout=self.task_timeout,
                                  on_started=on_started, secrets=[self.config["token"], task["runToken"]])
        except ReceiverError as caught:
            result = {"status": "needs_attention", "result": "", "error": public_text(caught, 2000), "sessionId": None}
        record["completion"] = {"taskId": task["id"], "runToken": task["runToken"], **result}
        self.store.write("active-run.json", record)
        self.recover()
        LOG.info("Task %s finished locally: %s.", public_text(task["id"], 80), result["status"])
        return True

    def run(self, once=False):
        while not self.stop.is_set():
            try:
                self.run_once()
            except ApiError as caught:
                if caught.status in {401, 403, 410}:
                    raise ReceiverError("Device authorization rejected; pair again after reviewing device access.") from None
                LOG.warning("Runner API unavailable; waiting to retry.")
            if once:
                return
            self.stop.wait(20)


def load_configuration(store: PrivateStore) -> dict:
    config = store.read("config.json")
    if not config or not all(isinstance(config.get(key), str) and config[key] for key in ("server", "deviceId", "token", "codex")):
        raise ReceiverError("Pair this receiver first; configuration is missing or incomplete.")
    raw_projects = config.get("projects")
    if not isinstance(raw_projects, dict):
        raise ReceiverError("Local project mapping is invalid.")
    projects = parse_projects([f"{key}={value}" for key, value in raw_projects.items()])
    if projects != raw_projects:
        raise ReceiverError("Project paths changed; review and pair the receiver again.")
    validate_config_directory(store.directory, projects)
    resolve_codex(config["codex"])
    return config


def acknowledge_stopped(store: PrivateStore, *, confirmed: bool) -> None:
    """Explicit local recovery never stops or identifies a process from a bare saved PID."""
    if not confirmed:
        raise ReceiverError("Inspect and stop the previous Codex session, then pass --confirm-stopped.")
    with InstanceLock(store):
        record = store.read("active-run.json")
        if not record or not record.get("orphanReviewRequired"):
            raise ReceiverError("There is no Mac interruption awaiting local stop confirmation. Run the receiver once to report an interrupted record first.")
        if record.get("completionReported"):
            store.clear_active()
        else:
            record["orphanReviewRequired"] = False
            record["processStoppedConfirmed"] = True
            store.write("active-run.json", record)
    print("Local stop confirmation saved. Existing result reporting will finish before another task can be claimed.")


def pair_device(args, store: PrivateStore):
    if store.read("config.json"):
        raise ReceiverError("This configuration is already paired. Use a new --config directory for a new device.")
    projects = parse_projects(args.project)
    validate_config_directory(store.directory, projects)
    binary = resolve_codex(args.codex)
    if platform.system() not in {"Windows", "Darwin"}:
        raise ReceiverError("Pairing supports Windows and macOS devices.")
    if not args.name.strip() or len(args.name) > 120 or not args.code.strip() or len(args.code) > 200:
        raise ReceiverError("Invalid device name or pairing code.")
    api = ApiClient(args.server, allow_local_http=args.allow_local_http)
    config = {"server": args.server, "projects": projects, "codex": str(binary), "allowLocalHttp": args.allow_local_http}
    with InstanceLock(store):
        response = api.call("pair", {"code": args.code.strip(), "name": args.name.strip(),
                            "platform": "windows" if os.name == "nt" else "macos", "projects": project_labels(config)}, authenticated=False)
        if not all(isinstance(response.get(key), str) and response[key] for key in ("deviceId", "token")):
            raise ReceiverError("Server returned an invalid pairing response.")
        config.update({"deviceId": response["deviceId"], "token": response["token"]})
        store.write("config.json", config)
    print("Device paired. The bearer token is stored only in the private configuration directory.")


def doctor(config: dict, store: PrivateStore):
    binary = resolve_codex(config["codex"])
    for key in config["projects"]:
        ensure_plan_login(binary, project_directory(config["projects"], key))
    print(f"Codex CLI ChatGPT login and built-in provider: verified; projects: {', '.join(config['projects'])}; private state: {store.directory}")
    record = store.read("active-run.json")
    if record:
        if record.get("orphanReviewRequired"):
            print("Mac interruption requires local stop review. No new tasks can be claimed until recover --confirm-stopped.")
        else:
            print("An interrupted or unacknowledged run exists; run will report/retry its result before claiming work.")
    print("No real task, remote pairing, or background installation was performed by doctor.")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["pair", "run", "doctor", "install", "uninstall", "recover"])
    parser.add_argument("--config", type=Path, default=default_config_directory(), help="Private directory outside mapped projects")
    parser.add_argument("--server")
    parser.add_argument("--code")
    parser.add_argument("--name")
    parser.add_argument("--project", action="append", default=[], metavar="ID=ABS_PATH")
    parser.add_argument("--codex", help="Absolute native Codex executable; defaults to PATH lookup at pairing")
    parser.add_argument("--allow-local-http", action="store_true", help="Explicit loopback HTTP test server only")
    parser.add_argument("--once", action="store_true", help="Process at most one claimed task")
    parser.add_argument("--confirm-stopped", action="store_true", help="Local operator confirms the interrupted Mac session is stopped")
    parser.add_argument("--task-timeout", type=float, default=7200, help="Local per-task timeout in seconds (default 7200)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        if args.command == "pair" and args.project:
            validate_config_directory(args.config, parse_projects(args.project))
        store = PrivateStore(args.config)
        configure_logging(store)
        if args.command == "pair":
            if not all((args.server, args.code, args.name, args.project)):
                parser.error("pair requires --server --code --name and at least one --project")
            pair_device(args, store)
            return 0
        if args.command == "uninstall":
            from receiver_install import uninstall
            uninstall(store)
            return 0
        if args.command == "recover":
            acknowledge_stopped(store, confirmed=args.confirm_stopped)
            return 0
        config = load_configuration(store)
        configure_logging(store, [config["token"]])
        if args.command == "doctor":
            doctor(config, store)
        elif args.command == "install":
            doctor(config, store)
            from receiver_install import install
            install(store)
        else:
            if not 1 <= args.task_timeout <= 86400:
                raise ReceiverError("Task timeout must be between 1 and 86400 seconds.")
            stop = threading.Event()
            for sig in (signal.SIGINT, signal.SIGTERM):
                signal.signal(sig, lambda *_: stop.set())
            api = ApiClient(config["server"], config["token"], allow_local_http=config.get("allowLocalHttp") is True)
            with InstanceLock(store):
                ReceiverService(config, store, api, stop=stop, task_timeout=args.task_timeout).run(args.once)
        return 0
    except (ReceiverError, OSError, subprocess.SubprocessError) as caught:
        LOG.error("%s", public_text(caught, 500))
        return 1


if __name__ == "__main__":
    if sys.version_info < (3, 11):
        raise SystemExit("Python 3.11 or later is required.")
    raise SystemExit(main())
