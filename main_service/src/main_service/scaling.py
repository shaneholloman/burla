"""
Machine planning shared by job-start growth (`_grow_if_needed`) and mid-job
replacement boots (`POST /v1/jobs/{id}/replacement_nodes`).

The head holds no scaling policy: nodes decide when more machines are needed
and how many slots they are owed; these helpers only translate "N more slots"
into concrete machines to boot.
"""

import math
from typing import Optional
from uuid import uuid4

from main_service import CLOUD_PROVIDER, IN_LOCAL_DEV_MODE
from main_service.providers.catalog import (
    gpu_machine_type,
    is_packable_cpu_machine,
    machine_spec,
    machine_type_cpu_count,
    pack_cpu_machines,
    parallelism_capacity,
)


def required_cpus_per_call(func_cpu: int | str, func_ram: int | str) -> int:
    func_cpu_for_scheduling = 1 if func_cpu == "dynamic" else int(func_cpu)
    func_ram_for_scheduling = 4 if func_ram == "dynamic" else int(func_ram)
    required_cpus_for_ram = (func_ram_for_scheduling + 3) // 4
    return max(func_cpu_for_scheduling, required_cpus_for_ram)


def plan_grow_nodes(
    missing_slots: int,
    func_cpu: int | str,
    func_ram: int | str,
    func_gpu: Optional[str],
    config: dict,
    max_additional_cpus: Optional[int] = None,
    max_additional_gpus: Optional[int] = None,
    slots_per_node: Optional[int] = None,
    machine_type: Optional[str] = None,
) -> list[dict]:
    """Plan machines covering `missing_slots` more parallelism.

    Returns one `{"instance_name", "machine_type", "target_parallelism"}` per
    node to boot; empty when nothing can be booted. `max_additional_cpus`
    (None = uncapped) bounds CPU jobs; `max_additional_gpus` bounds GPU jobs.
    `slots_per_node` with `machine_type` plans by measured capacity instead:
    a node that shed to N workers under memory pressure knows N is what one
    such machine sustains, so replacements are that machine type with N slots
    each rather than a full CPU count of workers that would shed again.
    """
    gpu_mt = gpu_machine_type(func_gpu, CLOUD_PROVIDER)

    if slots_per_node:
        n_nodes = math.ceil(missing_slots / slots_per_node)
        if max_additional_cpus is not None:
            n_nodes = min(
                n_nodes, max(0, max_additional_cpus) // machine_type_cpu_count(machine_type)
            )
        planned = []
        remaining_parallelism = missing_slots
        for nodes_left in range(n_nodes, 0, -1):
            # Spread evenly: 49 slots at 15 per node is 13/12/12/12, not
            # 15/15/15/4 (observed: the 4-slot node idled at ~10% RAM).
            node_parallelism = math.ceil(remaining_parallelism / nodes_left)
            planned.append(
                {
                    "instance_name": f"burla-node-{uuid4().hex[:8]}",
                    "machine_type": machine_type,
                    "target_parallelism": node_parallelism,
                }
            )
            remaining_parallelism -= node_parallelism
        return planned

    if gpu_mt:
        # One function call per GPU, so slots-per-node equals gpus-per-node
        # and the per-model GPU budget bounds node count directly.
        gpu_slots_per_node = parallelism_capacity(gpu_mt, func_cpu, func_ram)
        n_nodes = math.ceil(missing_slots / gpu_slots_per_node)
        if max_additional_gpus is not None:
            n_nodes = min(n_nodes, max(0, max_additional_gpus) // gpu_slots_per_node)
        if n_nodes <= 0:
            return []
        node_machine_types = [gpu_mt] * n_nodes
        parallelism_to_add = min(missing_slots, n_nodes * gpu_slots_per_node)
    else:
        cpus_per_call = required_cpus_per_call(func_cpu, func_ram)
        num_cpus_to_add = missing_slots * cpus_per_call
        if max_additional_cpus is not None:
            num_cpus_to_add = min(num_cpus_to_add, max(0, max_additional_cpus))
        parallelism_to_add = num_cpus_to_add // cpus_per_call
        if parallelism_to_add <= 0:
            return []

        node_spec = config["Nodes"][0]
        configured_machine_type = node_spec["machine_type"]

        # For CPU clusters, ignore the configured size and pack the required
        # CPUs into as many of the family's largest size as fit, with the
        # remainder covered by the smallest size that fits. GPU clusters keep
        # using the configured machine type so GPU jobs still land on GPU
        # hardware. Local dev stays homogeneous because node containers
        # hard-code 2 workers regardless of the advertised machine_type
        # (see INSTANCE_N_CPUS).
        pack_by_size = not IN_LOCAL_DEV_MODE and is_packable_cpu_machine(
            configured_machine_type
        )

        if pack_by_size:
            node_machine_types = pack_cpu_machines(num_cpus_to_add, CLOUD_PROVIDER)
        else:
            cpu_per_node = machine_type_cpu_count(configured_machine_type)
            n_nodes_to_add = math.ceil(num_cpus_to_add / cpu_per_node)
            node_machine_types = [configured_machine_type] * n_nodes_to_add

    # A machine_type whose capacity is 0 for this func_cpu/func_ram would boot
    # a node that can't run a single call, and the client would then send
    # parallelism=0 to it, producing a misleading 409 from the node.
    node_machine_types = [
        mt
        for mt in node_machine_types
        if parallelism_capacity(mt, func_cpu, func_ram) > 0
    ]
    if not node_machine_types:
        return []

    planned = []
    remaining_parallelism = parallelism_to_add
    for machine_type in node_machine_types:
        node_parallelism = min(
            remaining_parallelism,
            parallelism_capacity(machine_type, func_cpu, func_ram),
        )
        planned.append(
            {
                "instance_name": f"burla-node-{uuid4().hex[:8]}",
                "machine_type": machine_type,
                "target_parallelism": node_parallelism,
            }
        )
        remaining_parallelism -= node_parallelism
    return planned


def planned_cpu_count(planned: list[dict]) -> int:
    return sum(machine_type_cpu_count(p["machine_type"]) for p in planned)


def planned_gpu_count(planned: list[dict]) -> int:
    return sum(machine_spec(p["machine_type"])["gpus"] for p in planned)
