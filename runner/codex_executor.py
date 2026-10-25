"""Own one Codex subprocess; upload only its final agent message, never tool streams."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time

from receiver_core import ReceiverError, public_text
from codex_policy import PLAN_OVERRIDES, plan_environment


def build_command(binary: Path, project: Path) -> list[str]:
    return [str(binary.resolve()), "exec", "--json", "--sandbox", "workspace-write",
            "-c", 'approval_policy="never"', *PLAN_OVERRIDES, "--cd", str(project.resolve()), "-"]


def task_prompt(task: dict) -> str:
    return ("Execute this task in the configured project. Preserve existing drafts and unrelated uncommitted work. "
            "Do not merge the main branch or deploy automatically. Report changes and verification.\n\n"
            f"Title: {task['title']}\n\nTask:\n{task['prompt']}\n\nAcceptance:\n{task.get('acceptance', '')}\n")


class EventCollector:
    def __init__(self):
        self.session_id = None
        self.result = ""
        self.failed = False

    def accept(self, line: str) -> None:
        try:
            event = json.loads(line)
        except (ValueError, UnicodeError):
            return
        if not isinstance(event, dict):
            return
        if event.get("type") == "thread.started":
            value = event.get("thread_id")
            if isinstance(value, str) and len(value) <= 200:
                self.session_id = value
        if event.get("type") in ("error", "turn.failed"):
            self.failed = True
        item = event.get("item")
        if event.get("type") == "item.completed" and isinstance(item, dict) and item.get("type") == "agent_message":
            self.result = public_text(item.get("text", ""), 20000)


class WindowsJob:
    """KILL_ON_JOB_CLOSE contains only this receiver's Codex process tree."""
    def __init__(self, process):
        self.handle = None
        if os.name != "nt":
            return
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                          "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.CreateJobObjectW(None, None)
        limits = ExtendedLimits()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            if handle:
                kernel.CloseHandle(handle)
            raise ReceiverError("Unable to create a contained Windows process job.")
        if not kernel.AssignProcessToJobObject(handle, wintypes.HANDLE(int(process._handle))):
            kernel.CloseHandle(handle)
            raise ReceiverError("Unable to contain Codex process tree; execution stopped.")
        self.kernel, self.handle = kernel, handle

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def _resume_windows_process(pid: int) -> None:
    """Resume the initial suspended thread only after job assignment and durable PID storage."""
    if os.name != "nt":
        return
    from ctypes import wintypes

    class ThreadEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                    ("th32ThreadID", wintypes.DWORD), ("th32OwnerProcessID", wintypes.DWORD),
                    ("tpBasePri", wintypes.LONG), ("tpDeltaPri", wintypes.LONG), ("dwFlags", wintypes.DWORD)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
    kernel.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenThread.restype = wintypes.HANDLE
    kernel.ResumeThread.argtypes = [wintypes.HANDLE]
    kernel.ResumeThread.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(0x00000004, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ReceiverError("Unable to inspect suspended Codex process.")
    entry = ThreadEntry()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        available = kernel.Thread32First(snapshot, ctypes.byref(entry))
        while available:
            if entry.th32OwnerProcessID == pid:
                thread = kernel.OpenThread(0x0002, False, entry.th32ThreadID)
                if not thread:
                    raise ReceiverError("Unable to open suspended Codex thread.")
                try:
                    if kernel.ResumeThread(thread) == 0xFFFFFFFF:
                        raise ReceiverError("Unable to resume contained Codex process.")
                finally:
                    kernel.CloseHandle(thread)
                return
            available = kernel.Thread32Next(snapshot, ctypes.byref(entry))
        raise ReceiverError("Suspended Codex thread was not found.")
    finally:
        kernel.CloseHandle(snapshot)


def _stop(process, job: WindowsJob | None) -> None:
    if job and os.name == "nt":
        job.close()
    elif os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    else:
        process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
    finally:
        if os.name != "nt":
            # The leader may exit on TERM while one of its children ignores TERM.
            # Always finish the owned group, even if the leader has already exited.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    process.wait(timeout=3)


def execute_task(task: dict, project: Path, binary: Path, check_control, *, timeout: float = 7200,
                 on_started=None, secrets: tuple | list = ()) -> dict:
    """check_control returns cancellation/lease-loss status; all starts have fixed argv and stdin."""
    collector = EventCollector()
    process = None
    job = None
    readers = []
    status, error = "failed", "Codex did not complete successfully."
    started = time.monotonic()
    initial_control = check_control()
    if initial_control:
        return {"status": initial_control, "result": "", "error": "Execution refused because task authorization or lease was lost.", "sessionId": None}
    try:
        kwargs = {"cwd": str(project), "stdin": subprocess.PIPE, "stdout": subprocess.PIPE,
                  "stderr": subprocess.PIPE, "shell": False, "close_fds": True, "env": plan_environment()}
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000004
        else:
            kwargs["start_new_session"] = True
        process = subprocess.Popen(build_command(binary, project), **kwargs)
        job = WindowsJob(process)
        if on_started:
            on_started(process.pid)
        control_before_resume = check_control()
        if control_before_resume:
            _stop(process, job)
            return {"status": control_before_resume, "result": "", "error": "Execution stopped before sending the task prompt.", "sessionId": None}
        _resume_windows_process(process.pid)

        def drain(pipe, collect):
            # Even hostile or very verbose tool output cannot grow memory without bounds.
            try:
                while True:
                    raw = pipe.readline(1048577)
                    if not raw:
                        return
                    if collect and len(raw) <= 1048576 and raw.endswith(b"\n"):
                        collector.accept(raw.decode("utf-8", errors="replace"))
            except (OSError, ValueError):
                return

        for pipe, collect in ((process.stdout, True), (process.stderr, False)):
            reader = threading.Thread(target=drain, args=(pipe, collect), daemon=True)
            reader.start()
            readers.append(reader)
        def feed_prompt():
            # A CLI stalled before reading stdin must not stall lease supervision.
            try:
                process.stdin.write(task_prompt(task).encode("utf-8"))
                process.stdin.close()
            except (OSError, ValueError):
                return

        writer = threading.Thread(target=feed_prompt, daemon=True)
        writer.start()
        readers.append(writer)
        while True:
            control = check_control()
            if control:
                status = control
                error = "Task cancellation requested." if status == "cancelled" else "Execution stopped because device authorization or lease was lost."
                _stop(process, job)
                break
            if time.monotonic() - started >= timeout:
                status, error = "needs_attention", "Local execution timeout; inspect changes before submitting another task."
                _stop(process, job)
                break
            if process.poll() is not None:
                _stop(process, job)
                for reader in readers:
                    reader.join(timeout=2)
                if process.returncode == 0 and not collector.failed and collector.result:
                    status, error = "succeeded", ""
                else:
                    status, error = "failed", f"Codex exited with code {process.returncode}; inspect the local session."
                break
            time.sleep(0.1)
    except (OSError, ReceiverError, subprocess.SubprocessError):
        status, error = "needs_attention", "Unable to start or safely monitor Codex; inspect local setup and changes."
    except BaseException:
        if process and process.poll() is None:
            _stop(process, job)
        raise
    finally:
        if process and process.poll() is None:
            _stop(process, job)
        if job:
            job.close()
        for reader in readers:
            reader.join(timeout=2)
        if process:
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe and not pipe.closed:
                    pipe.close()
    return {"status": status, "result": public_text(collector.result, 20000, secrets),
            "error": public_text(error, 2000, secrets), "sessionId": collector.session_id}
