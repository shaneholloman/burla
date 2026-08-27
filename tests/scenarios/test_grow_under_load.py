"""
Scenario 3: cluster grows under load.

Submits a job larger than the current cluster capacity with `grow=True`,
verifies the job completes using expanded capacity, then verifies the added
nodes are deleted while the pre-existing nodes remain ready.
"""

from __future__ import annotations

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
