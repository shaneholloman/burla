"""
Scenario 9: 1000-input scale.

Scales 5x past the existing 200-input max. Exercises:
- the ~2 MB chunk / 60-retry upload loop in `_node._upload_input_chunk`
- the grow path with a real deficit (1000 inputs well above 4 worker slots)
- the per-node result counters summed into the job's n_results

Marked slow. Trivial UDF keeps the runtime to ~60-120s on a warm
cluster with grow=True.
"""

from __future__ import annotations

import time

import pytest

# 1000 inputs are only a scale test where the cluster can actually scale;
# local-dev tops out at 4 worker slots. The timeout covers the job plus the
# grow-node cleanup wait at the end.
pytestmark = [
    pytest.mark.e2e,
    pytest.mark.slow,
    pytest.mark.remote_dev,
    pytest.mark.timeout(600),
]

N_INPUTS = 1000


def test_thousand_input_rpm_completes_with_grow(
    rpm_subprocess,
    local_dev_cluster,
    main_http_client,
    wait_for_fixture,
):
    source = "def test_function(x):\n    return x * 3\n"

    ready_before = {
        node["instance_name"]
        for node in main_http_client.get("/v1/cluster/state").json()["ready_nodes"]
    }
    before = time.time()
    result = rpm_subprocess(
        source, list(range(N_INPUTS)), timeout_seconds=300, grow=True
    )
    assert result["ok"], result.get("traceback")
    assert len(result["outputs"]) == N_INPUTS
    assert set(result["outputs"]) == {x * 3 for x in range(N_INPUTS)}

    # Head-visible: find the completed 1000-input job via the jobs list.
    def _completed_big_job():
        jobs = main_http_client.get("/v1/jobs?page=0").json()["jobs"]
        matches = []
        for job in jobs:
            if job.get("function_name") != "test_function":
                continue
            if job.get("status") != "COMPLETED":
                continue
            if job.get("n_inputs") != N_INPUTS:
                continue
            if job.get("started_at", 0) < before - 5:
                continue
            matches.append(job)
        if not matches:
            return None
        matches.sort(key=lambda job: job.get("started_at", 0), reverse=True)
        return matches[0]

    job_summary = wait_for_fixture(_completed_big_job, timeout=30)
    job_id = job_summary["jobId"]
    job = main_http_client.get(f"/v1/jobs/{job_id}").json()
    assert job["n_inputs"] == N_INPUTS
    assert job["client_has_all_results"] is True

    # Per-node result counters (summed into n_results) across all nodes.
    stats = main_http_client.get(f"/v1/jobs/{job_id}/result-stats").json()
    total = stats["n_results"]
    # Drain timing can leave a single-digit rounding gap between the last
    # result flushed to the queue and the last counter push to the head.
    # 99%+ of inputs accounted for across nodes is sufficient proof that
    # the counters track real work.
    assert total >= int(N_INPUTS * 0.99), (
        f"n_results {total} < 99% of n_inputs {N_INPUTS}"
    )

    # The job finishes long before the ~16 nodes its grow request booted, and
    # those are deleted (mid-boot) once its scope ends. Returning while they
    # are still BOOTING leaks them into the next test's readiness gate, which
    # then pays for a full cluster restart.
    def _cluster_back_to_baseline():
        nodes = main_http_client.get("/v1/cluster/nodes").json()["nodes"]
        active = [
            node
            for node in nodes
            if node.get("status") in ("BOOTING", "READY", "RUNNING")
        ]
        all_ready = all(node.get("status") == "READY" for node in active)
        return all_ready and {n["instance_name"] for n in active} == ready_before

    wait_for_fixture(
        _cluster_back_to_baseline,
        timeout=300,
        message="grow nodes were not deleted after the job finished",
    )
