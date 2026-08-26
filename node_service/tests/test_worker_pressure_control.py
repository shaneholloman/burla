import asyncio
import importlib
import os
import sys
import time
from pathlib import Path

import pytest

NODE_SERVICE_SRC = str(Path(__file__).parents[1] / "src")
NODE_ENV_DEFAULTS = {
    "PROJECT_ID": "test-project",
    "MAIN_SERVICE_URL": "http://localhost",
    "CLUSTER_ID_TOKEN": "test-token",
    "NUM_GPUS": "0",
    "INSTANCE_NAME": "test-node",
}
previous_node_env = {name: os.environ.get(name) for name in NODE_ENV_DEFAULTS}
sys.path.insert(0, NODE_SERVICE_SRC)
try:
    for name, value in NODE_ENV_DEFAULTS.items():
        os.environ.setdefault(name, value)
    sys.modules.pop("node_service", None)
    worker_client = importlib.import_module("node_service.worker_client")
finally:
    sys.path.remove(NODE_SERVICE_SRC)
    for name, previous_value in previous_node_env.items():
        if previous_value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous_value


class ExistingPressureFile:
    def exists(self):
        return True


class FixedStallTracker:
    def __init__(self, stall_fraction=0.0):
        self.stall_fraction = stall_fraction

    def max_stall_fraction(self, _workers):
        return self.stall_fraction


class NoIoPressure:
    def sample(self):
        return 0.0, 0.0


class FakeWorker:
    def __init__(
        self,
        index,
        *,
        cpu_percent=0.0,
        throttled=False,
        swap_parked=False,
    ):
        self.index = index
        self.retired = False
        self.throttled = throttled
        self.swap_parked = swap_parked
        self.is_idle = False
        self.current_input = (index, b"input")
        self._cpu_percent = cpu_percent

    def cpu_percent(self):
        return self._cpu_percent


@pytest.fixture
def dynamic_state():
    keys = (
        "workers",
        "dynamic_func_cpu",
        "dynamic_func_ram",
        "dynamic_retire_lock",
        "last_pressure_retirement_at",
        "current_job",
    )
    previous = {key: worker_client.SELF[key] for key in keys}
    worker_client.SELF.update(
        workers=[],
        dynamic_func_cpu=False,
        dynamic_func_ram=False,
        dynamic_retire_lock=asyncio.Lock(),
        last_pressure_retirement_at=0.0,
        current_job="test-job",
    )
    yield
    worker_client.SELF.update(previous)


@pytest.mark.asyncio
async def test_cpu_pressure_parks_at_most_one_worker_per_second(
    monkeypatch, dynamic_state
):
    workers = [
        FakeWorker(0, cpu_percent=30),
        FakeWorker(1, cpu_percent=10),
        FakeWorker(2, cpu_percent=20),
    ]
    sleep_intervals = []
    selected_workers = []
    worker_client.SELF["workers"] = workers
    worker_client.SELF["dynamic_func_cpu"] = True

    async def fake_sleep(interval):
        sleep_intervals.append(interval)

    async def capture_throttle(selected, reason):
        selected_workers.extend(worker for _, worker in selected)
        assert reason == "CPU pressure"
        worker_client.SELF["dynamic_func_cpu"] = False

    monkeypatch.setattr(worker_client, "CPU_PRESSURE_FILE", ExistingPressureFile())
    monkeypatch.setattr(
        worker_client, "WorkerStallTracker", lambda: FixedStallTracker(0.5)
    )
    monkeypatch.setattr(worker_client.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        worker_client, "throttle_workers_for_pressure", capture_throttle
    )

    await worker_client.cpu_pressure_monitor_loop()

    assert sleep_intervals == [1]
    assert selected_workers == [workers[1]]


@pytest.mark.asyncio
async def test_cpu_park_recovers_on_first_clear_one_second_tick(
    monkeypatch, dynamic_state
):
    workers = [
        FakeWorker(0, throttled=True),
        FakeWorker(1, throttled=True),
    ]
    sleep_intervals = []
    recovery_calls = []
    worker_client.SELF["workers"] = workers
    worker_client.SELF["dynamic_func_cpu"] = True
    worker_client.SELF["last_pressure_retirement_at"] = time.time()

    async def fake_sleep(interval):
        sleep_intervals.append(interval)

    async def capture_recovery(reason, via):
        recovery_calls.append((reason, via))
        worker_client.SELF["dynamic_func_cpu"] = False

    monkeypatch.setattr(worker_client, "CPU_PRESSURE_FILE", ExistingPressureFile())
    monkeypatch.setattr(worker_client, "WorkerStallTracker", FixedStallTracker)
    monkeypatch.setattr(worker_client, "AddGateSampler", NoIoPressure)
    monkeypatch.setattr(worker_client.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        worker_client, "_unthrottle_one_parked_worker", capture_recovery
    )

    await worker_client.dynamic_worker_readd_loop()

    assert sleep_intervals == [1]
    assert recovery_calls == [("pressure subsided", "recovery_loop")]


@pytest.mark.asyncio
async def test_memory_park_recovers_on_first_clear_one_second_tick(
    monkeypatch, dynamic_state
):
    worker_client.SELF["workers"] = [FakeWorker(0, throttled=True, swap_parked=True)]
    worker_client.SELF["dynamic_func_ram"] = True
    worker_client.SELF["last_pressure_retirement_at"] = time.time()
    sleep_intervals = []
    recovery_calls = []

    async def fake_sleep(interval):
        sleep_intervals.append(interval)

    async def capture_recovery(reason, via):
        recovery_calls.append((reason, via))
        worker_client.SELF["dynamic_func_ram"] = False

    monkeypatch.setattr(worker_client, "CPU_PRESSURE_FILE", ExistingPressureFile())
    monkeypatch.setattr(worker_client, "WorkerStallTracker", FixedStallTracker)
    monkeypatch.setattr(worker_client, "AddGateSampler", NoIoPressure)
    monkeypatch.setattr(worker_client.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(
        worker_client, "_unthrottle_one_parked_worker", capture_recovery
    )

    await worker_client.dynamic_worker_readd_loop()

    assert sleep_intervals == [1]
    assert recovery_calls == [("pressure subsided", "recovery_loop")]
