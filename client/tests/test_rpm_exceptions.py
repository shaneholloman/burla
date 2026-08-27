"""End-to-end exception propagation and node-selection errors."""

import pytest


pytestmark = pytest.mark.e2e


def test_udf_error_re_raised_on_client(rpm_subprocess, local_dev_cluster):
    source = (
        "def test_function(x):\n"
        "    if x == 3:\n"
        "        raise ValueError('boom')\n"
        "    return x\n"
    )
    result = rpm_subprocess(source, list(range(10)), timeout_seconds=60)
    assert not result["ok"]
    assert result["exception_type"] == "ValueError"
    assert result["burla_input_index"] == 3


def test_udf_error_preserves_traceback(rpm_subprocess, local_dev_cluster):
    source = (
        "def inner(x):\n"
        "    try:\n"
        "        raise ValueError('root cause')\n"
        "    except ValueError as error:\n"
        "        raise RuntimeError('deep') from error\n"
        "def test_function(x):\n"
        "    return inner(x)\n"
    )
    result = rpm_subprocess(source, [1], timeout_seconds=60)
    assert not result["ok"]
    assert result["exception_type"] == "RuntimeError"
    assert "inner" in result["traceback"]
    assert "ValueError: root cause" in result["traceback"]
    assert "The above exception was the direct cause" in result["traceback"]


def test_udf_errors_returned_when_raise_errors_false(rpm_subprocess, local_dev_cluster):
    source = (
        "def test_function(x):\n"
        "    if x % 3 == 0:\n"
        "        raise ValueError(f'boom on {x}')\n"
        "    return x * 10\n"
    )
    result = rpm_subprocess(
        source, list(range(10)), timeout_seconds=60, raise_errors=False
    )
    assert result["ok"], result.get("traceback")
    outputs = result["outputs"]
    assert len(outputs) == 10
    errors = [o for o in outputs if isinstance(o, Exception)]
    assert all(isinstance(e, ValueError) for e in errors)
    assert sorted(e.burla_input_index for e in errors) == [0, 3, 6, 9]
    successes = sorted(o for o in outputs if not isinstance(o, Exception))
    assert successes == [10, 20, 40, 50, 70, 80]
    # Tracebacks are still printed even though nothing is raised.
    assert "ValueError: boom on 3" in result["stdout"]


def test_burla_exception_re_raised_on_client(rpm_subprocess, local_dev_cluster):
    source = (
        "from burla._node import AllNodesBusy\n"
        "def test_function(x):\n"
        "    raise AllNodesBusy()\n"
    )
    result = rpm_subprocess(source, [1], timeout_seconds=30)
    assert not result["ok"]
    assert result["exception_type"] == "AllNodesBusy"
    assert result["exception_message"] == "All nodes are busy, please try again later."


def test_udf_error_hides_burla_diagnostics(rpm_subprocess, local_dev_cluster):
    source = (
        "def test_function(x):\n"
        "    if x == 2:\n"
        "        raise ValueError('bad')\n"
        "    return x\n"
    )
    result = rpm_subprocess(source, list(range(5)), timeout_seconds=60)
    assert not result["ok"]
    assert "[burla]" not in result["traceback"]
    assert "Node diagnostics:" not in result["traceback"]
    assert "Job diagnostics:" not in result["traceback"]


def test_old_client_version_refused_with_upgrade_command(
    rpm_subprocess, local_dev_cluster
):
    # `from burla import __version__` is bound into _remote_parallel_map at
    # import time, so patching that binding sends exactly what an outdated
    # installed client would send.
    source = (
        "import burla._remote_parallel_map as rpm_module\n"
        "rpm_module.__version__ = '0.0.1'\n"
        "def test_function(x):\n"
        "    return x\n"
    )
    result = rpm_subprocess(source, [1], timeout_seconds=30)
    assert not result["ok"]
    assert result["exception_type"] == "VersionMismatch"
    assert "0.0.1" in result["exception_message"]
    assert "pip install burla==" in result["exception_message"]


def test_too_new_client_version_refused(rpm_subprocess, local_dev_cluster):
    source = (
        "import burla._remote_parallel_map as rpm_module\n"
        "rpm_module.__version__ = '999.99.99'\n"
        "def test_function(x):\n"
        "    return x\n"
    )
    result = rpm_subprocess(source, [1], timeout_seconds=30)
    assert not result["ok"]
    assert result["exception_type"] == "VersionMismatch"
    assert "999.99.99" in result["exception_message"]


@pytest.mark.slow
def test_NoNodes_raised_when_grow_false_and_no_compatible_node(
    rpm_subprocess, local_dev_cluster
):
    source = "def test_function(x):\n    return x\n"
    result = rpm_subprocess(
        source,
        [1],
        timeout_seconds=30,
        image="some/image-that-really-does-not-exist:tag",
        grow=False,
    )
    assert not result["ok"]
    assert result["exception_type"] in ("NoNodes", "NoCompatibleNodes")
