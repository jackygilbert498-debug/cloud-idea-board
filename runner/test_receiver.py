"""Behavior checks for the standard-library receiver (no account or real tasks)."""
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import xml.etree.ElementTree as ET
import plistlib
import zipfile
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import receiver
    import receiver_core as core
    import codex_executor as executor
except ImportError:
    receiver = core = executor = None


class ReceiverContractTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(core, "receiver implementation is missing")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / "project"
        self.project.mkdir()
        self.config_dir = self.base / "private"

    def test_network_cannot_choose_a_path(self):
        projects = core.parse_projects([f"site={self.project}"])
        self.assertEqual(core.project_directory(projects, "site"), self.project.resolve())
        for bad in ("../project", str(self.project), "missing", "site/../../x"):
            with self.subTest(bad=bad), self.assertRaises(core.ReceiverError):
                core.project_directory(projects, bad)

    def test_project_and_secret_directory_validation(self):
        for bad in ("x=relative", f"../x={self.project}", f"x={self.base / 'absent'}"):
            with self.subTest(bad=bad), self.assertRaises(core.ReceiverError):
                core.parse_projects([bad])
        projects = core.parse_projects([f"site={self.project}"])
        with self.assertRaises(core.ReceiverError):
            core.validate_config_directory(self.project / ".private", projects)

    def test_private_store_refuses_other_files_or_symbolic_link_directory(self):
        directory = self.base / "unrelated"
        directory.mkdir()
        (directory / "user-document.txt").write_text("preserve", encoding="utf-8")
        with self.assertRaises(core.ReceiverError):
            core.PrivateStore(directory)
        link = self.base / "link"
        try:
            link.symlink_to(directory, target_is_directory=True)
        except OSError:
            return  # Windows without symlink privilege still exercises the unrelated-file guard.
        with self.assertRaises(core.ReceiverError):
            core.PrivateStore(link)

    def test_secret_store_roundtrip_and_os_lock(self):
        store = core.PrivateStore(self.config_dir)
        store.write("config.json", {"token": "private-device-secret"})
        self.assertEqual(store.read("config.json")["token"], "private-device-secret")
        with core.InstanceLock(store):
            with self.assertRaises(core.ReceiverError):
                with core.InstanceLock(store):
                    self.fail("duplicate instance acquired lock")
        with core.InstanceLock(store):
            pass
        if os.name != "nt":
            self.assertEqual((self.config_dir / "config.json").stat().st_mode & 0o777, 0o600)

    def test_https_required_and_local_http_is_explicit(self):
        for bad in ("http://example.com", "https://u:p@example.com", "https://example.com?x=1", "file:///tmp/x"):
            with self.subTest(bad=bad), self.assertRaises(core.ReceiverError):
                receiver.ApiClient(bad)
        with self.assertRaises(core.ReceiverError):
            receiver.ApiClient("http://127.0.0.1:8080")
        self.assertEqual(receiver.ApiClient("http://127.0.0.1:8080", allow_local_http=True).url,
                         "http://127.0.0.1:8080/api/codex-runner")

    def test_prompt_stdin_fixed_sandbox_no_shell_and_final_only(self):
        task = {"id": "task1", "title": "hello", "prompt": "$(touch hacked); &", "acceptance": "ok"}
        command = executor.build_command(Path(sys.executable), self.project)
        self.assertEqual(command[0], str(Path(sys.executable).resolve()))
        self.assertIn("workspace-write", command)
        self.assertIn('approval_policy="never"', command)
        self.assertNotIn(task["prompt"], command)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", command)
        stream = executor.EventCollector()
        stream.accept(json.dumps({"type": "thread.started", "thread_id": "session1"}))
        stream.accept(json.dumps({"type": "item.completed", "item": {"type": "command_execution", "aggregated_output": "RAW TOOL SECRET"}}))
        stream.accept(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "finished"}}))
        self.assertEqual(stream.session_id, "session1")
        self.assertEqual(stream.result, "finished")
        self.assertIn(task["prompt"], executor.task_prompt(task))

    def test_execution_uses_stdin_and_can_stop_its_process(self):
        task = {"id": "task1", "title": "hello", "prompt": "a; $(bad)", "acceptance": "ok"}
        code = 'import sys,json; data=sys.stdin.read(); print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":data}}))'
        with patch.object(executor, "build_command", return_value=[sys.executable, "-c", code]):
            result = executor.execute_task(task, self.project, Path(sys.executable), lambda: None, timeout=3)
        self.assertEqual(result["status"], "succeeded")
        self.assertIn(task["prompt"], result["result"])
        with patch.object(executor, "build_command", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]):
            start = time.monotonic()
            result = executor.execute_task(task, self.project, Path(sys.executable), lambda: "cancelled", timeout=3)
        self.assertEqual(result["status"], "cancelled")
        self.assertLess(time.monotonic() - start, 5)

    @unittest.skipUnless(os.name == "nt", "Windows suspended process/job containment")
    def test_windows_process_is_suspended_until_contained(self):
        task = {"id": "task1", "title": "hello", "prompt": "p", "acceptance": ""}
        code = 'import json; print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"done"}}))'
        actual_popen = subprocess.Popen
        captured = []

        def spawn(*args, **kwargs):
            captured.append(kwargs)
            return actual_popen(*args, **kwargs)

        with patch.object(executor, "build_command", return_value=[sys.executable, "-c", code]), patch.object(executor.subprocess, "Popen", side_effect=spawn):
            result = executor.execute_task(task, self.project, Path(sys.executable), lambda: None, timeout=3)
        self.assertEqual(result["status"], "succeeded")
        self.assertTrue(captured[0]["creationflags"] & 0x00000004, "process ran before Job containment")

    def test_execution_timeout_and_lease_loss_are_not_success(self):
        task = {"id": "t", "title": "t", "prompt": "p", "acceptance": ""}
        for callback, timeout, status in ((lambda: None, 0.1, "needs_attention"),
                                          (lambda: "needs_attention", 3, "needs_attention")):
            with self.subTest(status=status), patch.object(executor, "build_command", return_value=[sys.executable, "-c", "import time; time.sleep(30)"]):
                result = executor.execute_task(task, self.project, Path(sys.executable), callback, timeout=timeout)
                self.assertEqual(result["status"], status)

    def test_large_stdin_cannot_block_cancellation_or_timeout(self):
        task = {"id": "t", "title": "t", "prompt": "🦉" * 20000, "acceptance": ""}
        with patch.object(executor, "build_command", return_value=[sys.executable, "-c", "import time; time.sleep(2)"]):
            start = time.monotonic()
            result = executor.execute_task(task, self.project, Path(sys.executable), lambda: None, timeout=0.1)
        self.assertEqual(result["status"], "needs_attention")
        self.assertLess(time.monotonic() - start, 1.5)

    def test_expired_lease_does_not_start_process(self):
        task = {"id": "t", "title": "t", "prompt": "p", "acceptance": ""}
        with patch.object(executor.subprocess, "Popen", side_effect=AssertionError("expired lease spawned Codex")):
            result = executor.execute_task(task, self.project, Path(sys.executable), lambda: "needs_attention", timeout=3)
        self.assertEqual(result["status"], "needs_attention")

    def test_results_capped_and_secrets_redacted(self):
        text = core.public_text("Bearer DEVICESECRET\napi_key=sk-abc123SECRET\n" + "x" * 25000, 20000, ["DEVICESECRET"])
        self.assertNotIn("DEVICESECRET", text)
        self.assertNotIn("sk-abc123SECRET", text)
        self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 20000)

    def test_json_credential_fields_are_removed_from_final_result_channel(self):
        values = {"access_token": "example-access-value", "refresh_token": "example-refresh-value", "id_token": "example-id-value"}
        for content in (json.dumps(values), "'access-token': 'example-access-value', 'refresh_token' = 'example-refresh-value', 'id-token': 'example-id-value'"):
            safe = core.public_text(content, 20000)
            for value in values.values():
                self.assertNotIn(value, safe)
        task = {"id": "t", "title": "t", "prompt": "p", "acceptance": ""}
        code = 'import json; print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":json.dumps({"refresh_token":"example-refresh-value"})}}))'
        with patch.object(executor, "build_command", return_value=[sys.executable, "-c", code]):
            result = executor.execute_task(task, self.project, Path(sys.executable), lambda: None, timeout=3)
        self.assertNotIn("example-refresh-value", result["result"])

    def test_malformed_quoted_credentials_have_bounded_redaction_time(self):
        value = 'access_token: "' + "\\" * 80
        code = "import sys; sys.path.insert(0, " + repr(str(Path(__file__).resolve().parent)) + "); from receiver_core import public_text; public_text(" + repr(value) + ", 20000); print('bounded')"
        try:
            result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=2)
        except subprocess.TimeoutExpired:
            self.fail("malformed credential text blocked redaction and lease supervision")
        self.assertEqual(result.returncode, 0)
        self.assertIn("bounded", result.stdout)

    def test_unterminated_or_truncated_quoted_credentials_are_redacted(self):
        for value in ('{"refresh_token":"example-refresh-value', '"access_token": "example-access-value',
                      "'id_token': 'example-id-value", '{"access_token":"example-access-value\\',
                      '"refresh_token":"example-refresh-value\nnext line'):
            with self.subTest(value=value):
                safe = core.public_text(value, 20000)
                for secret in ("example-refresh-value", "example-access-value", "example-id-value"):
                    self.assertNotIn(secret, safe)
        safe = core.public_text('{"refresh_token":"example-refresh-value"}', 16)
        self.assertNotIn("example", safe)

    def test_posix_group_is_killed_even_after_leader_exits(self):
        process = SimpleNamespace(pid=1234567, wait=lambda timeout: 0)
        with patch.object(executor.os, "name", "posix"), patch.object(executor.os, "killpg", create=True) as kill, patch.object(executor.signal, "SIGKILL", 9, create=True):
            executor._stop(process, None)
        self.assertEqual([call.args for call in kill.call_args_list], [(1234567, executor.signal.SIGTERM), (1234567, 9)])


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(receiver, "receiver implementation is missing")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / "project"
        self.project.mkdir()
        self.requests = []
        self.responses = {}
        self.slow_actions = set()
        self.redirect_actions = set()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                owner.requests.append((self.path, self.headers.get("Authorization"), body))
                status, response = owner.responses.get(body["action"], (200, {"ok": True}))
                data = json.dumps(response).encode()
                self.send_response(status)
                if body["action"] in owner.redirect_actions:
                    self.send_header("Location", "/leak")
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if body["action"] in owner.slow_actions:
                    for byte in data:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(0.03)
                else:
                    self.wfile.write(data)

            def log_message(self, *_):
                pass

            def do_GET(self):
                owner.requests.append((self.path, self.headers.get("Authorization"), {}))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.api = receiver.ApiClient(f"http://127.0.0.1:{self.server.server_port}", "secret", allow_local_http=True)
        self.store = core.PrivateStore(self.base / "private")
        self.config = {"deviceId": "device1", "token": "secret", "projects": {"site": str(self.project)}, "codex": sys.executable}
        # The protocol fixture uses Python as its child binary, so account checks
        # are covered independently at the actual CLI boundary in PlanPolicyTests.
        self.policy_patch = patch.object(receiver, "ensure_plan_login", return_value=None)
        self.policy_patch.start()
        self.addCleanup(self.policy_patch.stop)

    def test_pair_and_bearer_http_protocol(self):
        self.responses["pair"] = (200, {"deviceId": "d", "token": "private"})
        result = self.api.call("pair", {"code": "123456", "name": "My Mac", "platform": "macos", "projects": [{"id": "site", "label": "site"}]}, authenticated=False)
        self.assertEqual(result["deviceId"], "d")
        self.assertIsNone(self.requests[-1][1])
        self.api.call("heartbeat", {"projects": [{"id": "site", "label": "site"}]})
        self.assertEqual(self.requests[-1][1], "Bearer secret")
        self.assertEqual(self.requests[-1][0], "/api/codex-runner")

    def test_api_reports_revocation_without_echoing_bearer(self):
        self.responses["claim"] = (403, {"error": {"code": "device_revoked", "message": "secret"}})
        with self.assertRaises(receiver.ApiError) as caught:
            self.api.call("claim")
        self.assertEqual(caught.exception.status, 403)
        self.assertNotIn("secret", str(caught.exception))

    def test_slow_http_has_overall_deadline_and_no_overlapping_retries(self):
        self.slow_actions.add("heartbeat")
        start = time.monotonic()
        with self.assertRaises(receiver.ApiError):
            self.api.call("heartbeat", timeout=0.05)
        self.assertLess(time.monotonic() - start, 0.2)
        with self.assertRaises(receiver.ApiError):
            self.api.call("claim", timeout=0.05)
        self.assertEqual(len(self.requests), 1)

    def test_http_redirect_never_forwards_device_bearer(self):
        self.redirect_actions.add("claim")
        self.responses["claim"] = (302, {})
        with self.assertRaises(receiver.ApiError):
            self.api.call("claim")
        self.assertEqual(len(self.requests), 1)

    def test_real_http_to_subprocess_to_completion_workflow(self):
        self.responses["claim"] = (200, {"task": {"id": "t", "title": "safe task", "prompt": "hello", "acceptance": "verify", "projectId": "site", "runToken": "run"}, "leaseSeconds": 90})
        self.responses["progress"] = (200, {"cancelRequested": False, "leaseSeconds": 90})
        code = 'import json,sys; sys.stdin.read(); print(json.dumps({"type":"thread.started","thread_id":"session-real"})); print(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"verified output"}}))'
        service = receiver.ReceiverService(self.config, self.store, self.api)
        with patch.object(executor, "build_command", return_value=[sys.executable, "-c", code]):
            self.assertTrue(service.run_once())
        actions = [item[2]["action"] for item in self.requests]
        self.assertEqual(actions, ["heartbeat", "claim", "progress", "complete"])
        complete = self.requests[-1][2]
        self.assertEqual((complete["status"], complete["result"], complete["sessionId"]), ("succeeded", "verified output", "session-real"))
        self.assertNotIn(str(self.project), json.dumps(self.requests))
        self.assertIsNone(self.store.read("active-run.json"))

    def test_restart_reports_interrupted_without_starting_codex(self):
        self.store.write("active-run.json", {"taskId": "old", "runToken": "old-token", "phase": "running", "platform": "windows"})
        service = receiver.ReceiverService(self.config, self.store, self.api)
        with patch.object(receiver, "execute_task", side_effect=AssertionError("must not re-execute")):
            self.assertTrue(service.recover())
        complete = self.requests[-1][2]
        self.assertEqual(complete["action"], "complete")
        self.assertEqual(complete["taskId"], "old")
        self.assertEqual(complete["status"], "needs_attention")
        self.assertIsNone(self.store.read("active-run.json"))

    def test_mac_orphan_record_blocks_new_claims_until_explicit_local_review(self):
        self.store.write("active-run.json", {"taskId": "old", "runToken": "old-token", "phase": "running", "pid": 9999999, "platform": "macos"})
        service = receiver.ReceiverService(self.config, self.store, self.api)
        with patch.object(receiver, "execute_task", side_effect=AssertionError("orphan must block execution")):
            self.assertFalse(service.run_once())
            self.assertFalse(service.run_once())
        self.assertEqual([item[2]["action"] for item in self.requests], ["complete"])
        self.assertTrue(self.store.read("active-run.json")["orphanReviewRequired"])
        with self.assertRaises(core.ReceiverError):
            receiver.acknowledge_stopped(self.store, confirmed=False)
        receiver.acknowledge_stopped(self.store, confirmed=True)
        self.assertIsNone(self.store.read("active-run.json"))

    def test_unicode_input_limits_match_server_codepoints(self):
        receiver.validate_task({"id": "t", "runToken": "r", "projectId": "site", "title": "🦉" * 121,
                                "prompt": "🦉" * 10001, "acceptance": ""})

    def test_uncertain_completion_remains_durable_until_acknowledged(self):
        payload = {"taskId": "old", "runToken": "old-token", "status": "succeeded", "result": "done", "error": "", "sessionId": "s"}
        self.store.write("active-run.json", {"taskId": "old", "runToken": "old-token", "completion": payload})
        self.responses["complete"] = (503, {"error": {"code": "unavailable", "message": "retry"}})
        service = receiver.ReceiverService(self.config, self.store, self.api)
        self.assertFalse(service.recover())
        self.assertEqual(self.store.read("active-run.json")["completion"], payload)
        self.responses["complete"] = (200, {"ok": True})
        self.assertTrue(service.recover())
        self.assertEqual(self.requests[-1][2]["status"], "succeeded")

    def test_unknown_project_is_never_executed(self):
        self.responses["claim"] = (200, {"task": {"id": "t", "title": "x", "prompt": "x", "acceptance": "", "projectId": "../../bad", "runToken": "run"}, "leaseSeconds": 90})
        service = receiver.ReceiverService(self.config, self.store, self.api)
        with patch.object(receiver, "execute_task", side_effect=AssertionError("must not start")):
            self.assertTrue(service.run_once())
        self.assertEqual(self.requests[-1][2]["status"], "needs_attention")

    def test_cancel_and_lease_failure_stop_execution(self):
        self.responses["progress"] = (200, {"cancelRequested": True, "leaseSeconds": 90})
        service = receiver.ReceiverService(self.config, self.store, self.api)
        record = {"taskId": "t", "runToken": "r"}
        monitor = service.make_control(record, time.monotonic() + 90)
        self.assertEqual(monitor(), "cancelled")
        self.responses["progress"] = (409, {"error": {"code": "lease_lost", "message": "lost"}})
        self.assertEqual(service.make_control(record, time.monotonic() + 90)(), "needs_attention")
        before = len(self.requests)
        self.assertEqual(service.make_control(record, time.monotonic() - 1)(), "needs_attention")
        self.assertEqual(len(self.requests), before)


class InstallTests(unittest.TestCase):
    def test_platform_descriptors_preserve_paths_and_use_current_user(self):
        self.assertTrue(importlib.util.find_spec("receiver_install"), "user-level installer is missing")
        import receiver_install as install
        config = Path(tempfile.gettempdir()) / "测试 space" / "private"
        plist = plistlib.loads(install.launch_agent_bytes(config, "/usr/bin/python3", "/Users/me/Task Board/runner/receiver.py"))
        self.assertEqual(plist["ProgramArguments"], ["/usr/bin/python3", "/Users/me/Task Board/runner/receiver.py", "run", "--config", str(config)])
        self.assertTrue(plist["RunAtLoad"])
        self.assertFalse(plist["KeepAlive"]["SuccessfulExit"])
        xml = ET.fromstring(install.windows_task_xml(config, "C:\\Python\\pythonw.exe", "C:\\Task Board\\runner\\receiver.py", "S-1-5-21-123"))
        ns = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}
        self.assertEqual(xml.find("t:Principals/t:Principal/t:RunLevel", ns).text, "LeastPrivilege")
        self.assertEqual(xml.find("t:Principals/t:Principal/t:UserId", ns).text, "S-1-5-21-123")
        self.assertEqual(xml.find("t:Actions/t:Exec/t:Command", ns).text, "C:\\Python\\pythonw.exe")
        self.assertIn('"C:\\Task Board\\runner\\receiver.py"', xml.find("t:Actions/t:Exec/t:Arguments", ns).text)

    def test_install_refuses_unpaired_state(self):
        self.assertTrue(importlib.util.find_spec("receiver_install"), "user-level installer is missing")
        import receiver_install as install
        with tempfile.TemporaryDirectory() as temp:
            store = core.PrivateStore(Path(temp) / "private")
            with self.assertRaises(core.ReceiverError):
                install.install(store)

    def test_package_is_portable_explicit_allowlist_and_secret_free(self):
        script = Path(__file__).resolve().parent.parent / "scripts/package-receiver.mjs"
        if not script.is_file():
            self.skipTest("The portable runtime package excludes the Node source build script.")
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "receiver.zip"
            result = subprocess.run(["node", str(script), "--output", str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), {
                    "codex-receiver/README.md", "codex-receiver/runner/receiver.py",
                    "codex-receiver/runner/receiver_core.py", "codex-receiver/runner/codex_executor.py",
                    "codex-receiver/runner/codex_policy.py",
                    "codex-receiver/runner/receiver_install.py", "codex-receiver/runner/test_receiver.py"})
                self.assertIsNone(archive.testzip())

    def test_private_rotating_log_redacts_token(self):
        self.assertTrue(hasattr(receiver, "configure_logging"), "private rotating logging is missing")
        with tempfile.TemporaryDirectory() as temp:
            store = core.PrivateStore(Path(temp) / "private")
            receiver.configure_logging(store, ["device-token-secret"])
            receiver.LOG.warning("Network returned device-token-secret")
            for handler in list(receiver.LOG.handlers):
                handler.close()
                receiver.LOG.removeHandler(handler)
            log = (store.directory / "receiver.log").read_text(encoding="utf-8")
            self.assertNotIn("device-token-secret", log)
            self.assertIn("redacted", log)


class PlanPolicyTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(importlib.util.find_spec("codex_policy"), "ChatGPT-plan policy is missing")
        import codex_policy
        self.policy = codex_policy
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.project = self.base / "project"
        self.project.mkdir()
        self.codex_home = self.base / "codex-home"
        self.codex_home.mkdir()
        self.environment = {"CODEX_HOME": str(self.codex_home), "PATH": "local-path", "PROGRAMDATA": str(self.base / "programdata")}

    def test_api_environment_is_removed_and_chatgpt_provider_is_fixed(self):
        env = self.policy.plan_environment({**self.environment, "OPENAI_API_KEY": "example-key", "OPENAI_BASE_URL": "https://example.invalid", "OPENAI_IDENTITY_TOKEN_FILE": "example-token-file", "CODEX_API_KEY": "example-key"})
        self.assertEqual(env, self.environment)
        command = executor.build_command(Path(sys.executable), self.project)
        self.assertIn('model_provider="openai"', command)
        self.assertIn('forced_login_method="chatgpt"', command)

    def test_custom_provider_and_project_base_are_refused(self):
        for content, location in [('model_provider="custom"', self.codex_home / "config.toml"),
                                  ('openai_base_url="https://example.invalid"', self.project / ".codex/config.toml")]:
            location.parent.mkdir(exist_ok=True)
            location.write_text(content, encoding="utf-8")
            with self.assertRaises(core.ReceiverError):
                self.policy.validate_plan_configuration(self.project, self.environment)
            location.unlink()

    def test_api_login_and_effective_provider_are_refused(self):
        result = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"Logged in using an API key: example-key")
        with patch.object(self.policy.subprocess, "run", return_value=result), self.assertRaises(core.ReceiverError):
            self.policy.ensure_plan_login(Path(sys.executable), self.project, environment=self.environment)
        login = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"Logged in using ChatGPT")
        report = {"checks": {"config.load": {"status": "ok", "details": {"model provider": "custom"}},
                             "auth.credentials": {"status": "ok", "details": {"stored auth mode": "chatgpt", "stored API key": "false", "stored ChatGPT tokens": "true"}}}}
        doctor = subprocess.CompletedProcess([], 0, stdout=json.dumps(report).encode(), stderr=b"")
        with patch.object(self.policy.subprocess, "run", side_effect=[login, doctor]), self.assertRaises(core.ReceiverError):
            self.policy.ensure_plan_login(Path(sys.executable), self.project, environment=self.environment)


if __name__ == "__main__":
    unittest.main()
