"""Keep the machine awake while a client-hosted head has live nodes.

Client-hosted heads run on the user's own laptop. If it sleeps mid-job the
relay tunnel drops and every node orphans itself (observed 2026-08-28: a 60
node job died this way). The hold exists only while nodes exist and never
applies to VM-hosted or local-dev heads (neither sets IN_CLIENT_HOSTED_MODE
except the client-hosted path). It prevents idle sleep only; a lid close on
battery still sleeps the machine. Opt out with DISABLE_BURLA_KEEP_AWAKE=True.
"""

import os
import platform
import subprocess
import threading

_SYSTEM = platform.system()

ENABLED = (
    os.environ.get("IN_CLIENT_HOSTED_MODE") == "True"
    and os.environ.get("DISABLE_BURLA_KEEP_AWAKE") != "True"
    and _SYSTEM in ("Darwin", "Windows")
)

_lock = threading.Lock()
_caffeinate: subprocess.Popen | None = None
_windows_stop: threading.Event | None = None


def _held() -> bool:
    if _SYSTEM == "Darwin":
        return _caffeinate is not None and _caffeinate.poll() is None
    return _windows_stop is not None


def _hold_windows(stop: threading.Event):
    import ctypes

    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001
    # Per-thread state: it clears automatically if this thread (or the head
    # process) dies, so a crashed head can never leak a wake lock.
    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    stop.wait()
    ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)


def set_active(has_live_nodes: bool):
    global _caffeinate, _windows_stop
    if not ENABLED:
        return
    with _lock:
        if has_live_nodes and not _held():
            if _SYSTEM == "Darwin":
                # -w ties caffeinate's lifetime to the head, so a killed head
                # can never leak a wake lock.
                _caffeinate = subprocess.Popen(
                    ["caffeinate", "-i", "-w", str(os.getpid())],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            else:
                _windows_stop = threading.Event()
                threading.Thread(
                    target=_hold_windows, args=(_windows_stop,), daemon=True
                ).start()
            print(
                "Cluster nodes are running: keeping this machine awake until they "
                "stop (set DISABLE_BURLA_KEEP_AWAKE=True to disable).",
                flush=True,
            )
        elif not has_live_nodes and _held():
            if _SYSTEM == "Darwin":
                _caffeinate.terminate()
                _caffeinate = None
            else:
                _windows_stop.set()
                _windows_stop = None
            print(
                "No cluster nodes remain: letting this machine sleep again.",
                flush=True,
            )
