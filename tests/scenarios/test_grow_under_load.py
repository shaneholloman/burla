"""
Scenario 3: cluster grows under load.

Submits a job larger than the current cluster capacity with `grow=True`,
verifies the job completes using expanded capacity, then verifies the added
nodes are deleted while the pre-existing nodes remain ready.
"""

from __future__ import annotations

import threading
import time

import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.slow, pytest.mark.timeout(360)]


def test_grow_under_load(
    rpm_subprocess,
    local_dev_cluster,
    main_http_client,
    wait_for_fixture,
):
    before = main_http_client.get("/v1/cluster/state").json()
    ready_before = {node["instance_name"] for node in before["ready_nodes"]}
    deleted_before = {
        node["id"]
        for node in main_http_client.get(
            "/v1/cluster/deleted_recent_paginated",
            params={"offset": 0, "limit": 10000},
        ).json()["nodes"]
    }

    source = (
        "import time\n"
        "def test_function(x):\n"
        "    time.sleep(0.5)\n"
        "    return x * 2\n"
    )
    result = rpm_subprocess(
        source, list(range(200)), timeout_seconds=300, grow=True
    )
    assert result["ok"], result.get("traceback")
    assert len(result["outputs"]) == 200
    assert set(result["outputs"]) == {x * 2 for x in range(200)}

    def deleted_grow_nodes():
        deleted_after = {
            node["id"]
            for node in main_http_client.get(
                "/v1/cluster/deleted_recent_paginated",
                params={"offset": 0, "limit": 10000},
            ).json()["nodes"]
        }
        return deleted_after - deleted_before

    deleted_grow_node_ids = wait_for_fixture(
        deleted_grow_nodes,
        timeout=60,
        message="grow-created nodes were not deleted after the job",
    )
    assert deleted_grow_node_ids.isdisjoint(ready_before)

    wait_for_fixture(
        lambda: ready_before
        <= {
            node["instance_name"]
            for node in main_http_client.get("/v1/cluster/state").json()["ready_nodes"]
        },
        timeout=30,
        message="pre-existing nodes did not return to READY",
    )


@pytest.mark.remote_dev
@pytest.mark.timeout(900)
def test_grow_node_can_finish_before_skewed_job(
    rpm_subprocess,
    local_dev_cluster,
    main_http_client,
    wait_for_fixture,
):
    before = main_http_client.get("/v1/cluster/state").json()
    warm_parallelism = main_http_client.get("/v1/management/cluster").json()[
        "vcpu_count"
    ]
    requested_parallelism = warm_parallelism + 2
    deleted_before = {
        node["id"]
        for node in main_http_client.get(
            "/v1/cluster/deleted_recent_paginated",
            params={"offset": 0, "limit": 10000},
        ).json()["nodes"]
    }

    source = (
        "import time\n"
        "def test_function(x):\n"
        "    time.sleep(480 if x == 0 else 0.1)\n"
        "    return x\n"
    )
    result_box = {}

    def run_job():
        result_box["result"] = rpm_subprocess(
            source,
            list(range(requested_parallelism)),
            timeout_seconds=840,
            grow=True,
            max_parallelism=requested_parallelism,
            func_cpu=1,
            func_ram=1,
        )

    started_after = time.time()
    job_thread = threading.Thread(target=run_job, daemon=True)
    job_thread.start()

    def running_job_id():
        jobs = main_http_client.get("/v1/jobs?page=0").json()["jobs"]
        for summary in jobs:
            if summary.get("function_name") != "test_function":
                continue
            if summary.get("started_at", 0) < started_after:
                continue
            job_id = summary["jobId"]
            job = main_http_client.get(f"/v1/jobs/{job_id}").json()
            if job.get("status") == "RUNNING" and job.get("all_inputs_uploaded"):
                return job_id
        return None

    job_id = wait_for_fixture(
        running_job_id,
        timeout=300,
        message="skewed job never reached RUNNING with all inputs uploaded",
    )

    def scoped_node_deleted_while_job_running():
        job = main_http_client.get(f"/v1/jobs/{job_id}").json()
        if job.get("status") != "RUNNING":
            return None
        deleted_after = {
            node["id"]
            for node in main_http_client.get(
                "/v1/cluster/deleted_recent_paginated",
                params={"offset": 0, "limit": 10000},
            ).json()["nodes"]
        }
        for node_id in deleted_after - deleted_before:
            response = main_http_client.get(
                f"/v1/cluster/nodes/{node_id}",
                params={"include_deleted": True},
            )
            if response.status_code != 200:
                continue
            node = response.json()
            reason = node.get("terminal_reason") or {}
            if (
                node.get("job_scope_id") == job_id
                and reason.get("code") == "job_scope_finished"
            ):
                return node
        return None

    deleted_node = wait_for_fixture(
        scoped_node_deleted_while_job_running,
        timeout=720,
        message="no grow node was deleted while the skewed job remained RUNNING",
    )
    assert deleted_node["status"] == "DELETED"

    job_thread.join(timeout=840)
    assert not job_thread.is_alive(), "client hung after the grow node was deleted"
    result = result_box["result"]
    assert result["ok"], result.get("traceback")
    assert sorted(result["outputs"]) == list(range(requested_parallelism))
