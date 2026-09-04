"""
Outcome-based mint control: job-wide worker growth must pay for itself in
measured job goodput (results/sec) before more is allowed.

Every machine-local gate (CPU stall, IO stall, memory PSI, RSS, utilization)
stays on the nodes; this controller answers the one question no node can:
"does the *job* gain anything from more workers anywhere?" Recorded runs
prove a node-local answer is wrong: work stealing makes a minting node's own
goodput rise while fleet goodput stays flat (pd12m, 2026-08-31), and
server-side rate limiting degrades every node at once while every local gate
reads green (smithsonian, 2026-08-30). Only the head sees job-wide results
and worker counts, so growth policy lives here, funded in small "epochs":

- Nodes ask for slots (POST /v1/jobs/{id}/mint); grants come out of the
  current epoch's allowance. The first grant opens the epoch and snapshots
  job goodput G and worker count W.
- After the epoch's workers have had time to boot and the goodput EWMA to
  catch up, the epoch is judged: marginal gain dG vs the bar
  KAPPA * (G/W) * dW ("a new worker must earn at least KAPPA of an average
  worker"). Verified epochs grow the next allowance geometrically, so a
  genuinely scalable job ramps exponentially; a shortfall must be
  statistically significant (>= FREEZE_Z sigma below the bar) before growth
  freezes, so a randomly slow batch can't freeze a healthy job (odds < 5%).
- Frozen jobs re-probe with a small allowance on a doubling interval, so a
  workload phase change (a slow wave of tasks) costs at most a few minutes
  of frozen-but-adequate parallelism, never a permanent stop.
- An epoch that made goodput significantly *worse* (>= ROLLBACK_Z sigma
  drop) is taken back: its grants are shed from exactly the nodes that
  received them (served via the state-push response).

A job whose tasks are too long (or too stuck) to produce completions inside
an epoch can never verify one: verification requires the gain to clear the
noise floor strictly, and failed probes are reclaimed, so blind growth is
bounded at one in-flight epoch above the last verified worker count. No
evidence, no growth: that property is what lets the old arbitrary
MINT_TARGET_MAX_PER_CORE ceiling be deleted outright.

Controller state is in-memory only and event-loop-confined (ticks and
endpoint calls all run on the head's loop, so no locking). After a head
restart the controller re-baselines from the job's current worker count:
already-verified growth is simply grandfathered in.
"""

import asyncio
import math
from collections import deque
from time import time

from main_service import history

G_EWMA_TAU_SEC = 30.0
# Goodput noise is estimated from block-average rates (the recorded runs put
# the 15s-block CV at 0.2-3.1%); the EWMA of a stationary process carries
# variance ~ sigma_block^2 * BLOCK_SEC / (2 * tau), and dG compares two EWMA
# snapshots, hence the sqrt(2 * BLOCK/(2*tau)) = ~0.71 factor below.
BLOCK_SEC = 15.0
SIGMA_BLOCKS = 8
BASELINE_NOISE_BLOCKS = 4
SIGMA_DG_FACTOR = math.sqrt(2 * BLOCK_SEC / (2 * G_EWMA_TAU_SEC))

# A new worker must earn at least this fraction of an average worker's
# goodput. 0.3 froze the recorded smithsonian run at ~4k workers (its true
# goodput peak) and pd12m at its initial allocation, while nexrad's healthy
# +0.1..0.28/worker epochs verify comfortably.
KAPPA = 0.3
FREEZE_Z = 1.65  # one-sided 5%: freeze only when the shortfall is real
ROLLBACK_Z = 3.0

# Epoch shape: grants are only handed out for the first GRANT_WINDOW seconds
# (so the growth being judged is a step, not a ramp), the verdict waits for
# boot lag + one EWMA time constant, and an ambiguous verdict keeps watching
# (twice) before giving up rather than deciding on noise.
EPOCH_GRANT_WINDOW_SEC = 30.0
EPOCH_VERDICT_AGE_SEC = 75.0
EPOCH_EXTENSION_SEC = 45.0
EPOCH_MAX_EXTENSIONS = 2
EPOCH_NO_GROWTH_DEADLINE_SEC = 150.0
# Below this measured growth an epoch proves nothing: the expected goodput
# delta would drown in block noise.
EPOCH_MIN_GROWTH_FRACTION = 0.02
EPOCH_MIN_GROWTH_SLOTS = 4

# Every node may contribute only one locally-sized batch per epoch, so a 10%
# fleet allowance creates a useful experiment on an idle fleet without
# letting any node reuse a stale headroom measurement before the verdict.
ALLOWANCE_BASE_FRACTION = 0.10
ALLOWANCE_MIN_SLOTS = 4
ALLOWANCE_MAX_FRACTION = 0.5  # one epoch may never grow the job by more
VERIFIED_MULTIPLIER = 2.0
# A marginal this close to a full average worker means linear scaling: take
# much bigger steps (Jake's "absurd numbers of workers to max out CPU" case).
VERIFIED_STRONG_FRACTION = 0.8
VERIFIED_STRONG_MULTIPLIER = 4.0

PROBE_INTERVAL_SEC = 90.0
PROBE_INTERVAL_MAX_SEC = 600.0
PROBE_FRACTION = 0.02

TICK_INTERVAL_SEC = 1.0
STATE_LOG_INTERVAL_SEC = 30.0


def _debug(job_id: str, event: str, **fields):
    entry = {"job_id": job_id, "event": event, "fields": fields}
    return asyncio.to_thread(history.add_debug_logs, "head", [entry])


class _JobController:
    def __init__(self, job_id: str, worker_count: int):
        self.job_id = job_id
        self.frozen = False
        self.probing = False
        self.probe_at = None
        self.probe_interval = PROBE_INTERVAL_SEC
        self.allowance = self._base_allowance(worker_count)
        self.epoch = None  # dict: opened_at, W_base, G_base, extensions, next_verdict_at
        self.epoch_grants = {}  # instance_name -> slots granted this epoch
        self.pending_sheds = {}  # instance_name -> slots to take back
        self.G = 0.0
        self.W = worker_count
        self._last_total = None
        self._last_tick_at = None
        self._blocks = deque(maxlen=SIGMA_BLOCKS)
        self._block_started_at = None
        self._block_start_total = None
        self._block_fully_busy = False
        self._last_state_logged_at = 0.0

    @staticmethod
    def _base_allowance(worker_count: int) -> int:
        return max(ALLOWANCE_MIN_SLOTS, round(ALLOWANCE_BASE_FRACTION * worker_count))

    @staticmethod
    def _sigma_dg(blocks):
        if len(blocks) < 4:
            return None
        mean = sum(blocks) / len(blocks)
        variance = sum((b - mean) ** 2 for b in blocks) / (len(blocks) - 1)
        return math.sqrt(variance) * SIGMA_DG_FACTOR

    def grant(self, instance_name: str, slots_requested: int) -> int:
        now = time()
        if self.frozen or self.allowance <= 0:
            return 0
        # The first half of the block window lets pipeline fill and the
        # goodput EWMA warm; only the latest half represents the baseline
        # immediately before the experiment.
        if len(self._blocks) < SIGMA_BLOCKS:
            return 0
        if self.epoch and now - self.epoch["opened_at"] > EPOCH_GRANT_WINDOW_SEC:
            return 0  # epoch is filling out / being judged; ask again after
        if self.epoch and instance_name in self.epoch_grants:
            return 0
        if self.epoch is None:
            # Allowance is per-epoch: refresh it from the live worker count
            # at open (verified epochs may carry a larger multiplied value,
            # probes keep their deliberately small one). Without this, a
            # value sized during boot ramp starves minting forever
            # (observed: a 2,048-worker fleet granting from an allowance
            # computed at W=64, dead after one 4-slot epoch).
            if not self.probing:
                self.allowance = max(self.allowance, self._base_allowance(self.W))
            self.epoch = {
                "opened_at": now,
                "W_base": self.W,
                "G_base": self.G,
                # Noise under the no-change hypothesis is the *stable
                # baseline's* noise: measured across the epoch it would
                # include the very regime change being judged, inflating
                # sigma exactly when goodput moves most (observed: a -5.9/s
                # collapse read as inside 3 sigma and dodged rollback).
                "sigma": self._sigma_dg(
                    list(self._blocks)[-BASELINE_NOISE_BLOCKS:]
                ),
                "extensions": 0,
                "next_verdict_at": now + EPOCH_VERDICT_AGE_SEC,
            }
            self.epoch_grants = {}
        granted = min(slots_requested, self.allowance)
        self.allowance -= granted
        self.epoch_grants[instance_name] = (
            self.epoch_grants.get(instance_name, 0) + granted
        )
        return granted

    def take_shed(self, instance_name: str) -> int:
        return self.pending_sheds.pop(instance_name, 0)

    def tick(self, total_results: int, worker_count: int, busy_count: int) -> list:
        """Feed fresh job aggregates; returns debug-event awaitables."""
        now = time()
        self.W = worker_count
        self.busy = busy_count
        if self._last_total is None:
            self._last_total = total_results
            self._last_tick_at = now
            self._block_started_at = now
            self._block_start_total = total_results
            self._block_fully_busy = False
            return []
        dt = now - self._last_tick_at
        if dt > 0:
            rate = (total_results - self._last_total) / dt
            weight = 1 - math.exp(-dt / G_EWMA_TAU_SEC)
            self.G += (rate - self.G) * weight
        self._last_total = total_results
        self._last_tick_at = now
        # Noise blocks only count at full busy: pipeline-fill ramp (workers
        # idle while the first inputs spread out) swings the rate for reasons
        # that are not goodput noise, and a ramp-inflated sigma read a -2.8/s
        # collapse as "within noise" (observed). Same anchor as the node
        # damper's fully-busy green-streak rule.
        self._block_fully_busy = self._block_fully_busy and (
            worker_count > 0 and busy_count >= 0.9 * worker_count
        )
        if now - self._block_started_at >= BLOCK_SEC:
            block_rate = (total_results - self._block_start_total) / (
                now - self._block_started_at
            )
            if self._block_fully_busy:
                self._blocks.append(block_rate)
            self._block_started_at = now
            self._block_start_total = total_results
            self._block_fully_busy = True

        events = []
        # Continuous controller ledger, same idea as the nodes' slot_state:
        # post-mortems read a timeseries instead of replaying transitions.
        if now - self._last_state_logged_at > STATE_LOG_INTERVAL_SEC:
            self._last_state_logged_at = now
            events.append(
                _debug(
                    self.job_id, "mint_state",
                    W=self.W, busy=self.busy, G=round(self.G, 2),
                    n_blocks=len(self._blocks), allowance=self.allowance,
                    frozen=self.frozen, epoch_open=self.epoch is not None,
                )
            )
        verdict_event = self._advance(now)
        if verdict_event is not None:
            events.append(verdict_event)
        return events

    def _advance(self, now: float):
        if self.frozen and self.probe_at is not None and now >= self.probe_at:
            self.frozen = False
            self.probing = True
            self.probe_at = None
            self.allowance = max(
                ALLOWANCE_MIN_SLOTS, round(PROBE_FRACTION * self.W)
            )
            return _debug(
                self.job_id, "mint_probe_opened",
                allowance=self.allowance, W=self.W, G=round(self.G, 2),
            )

        if self.epoch is None:
            return None
        return self._judge_epoch(now)

    def _judge_epoch(self, now: float):
        epoch = self.epoch
        age = now - epoch["opened_at"]
        if now < epoch["next_verdict_at"]:
            return None
        dW = self.W - epoch["W_base"]
        min_growth = max(
            EPOCH_MIN_GROWTH_SLOTS, EPOCH_MIN_GROWTH_FRACTION * epoch["W_base"]
        )
        if dW < min_growth:
            if age < EPOCH_NO_GROWTH_DEADLINE_SEC:
                return None
            # An under-sized step proves nothing, so reclaim its entire
            # target increase, including grants whose workers have not
            # finished booting. Keeping it would let repeated inconclusive
            # epochs ratchet concurrency upward without evidence.
            for instance_name, slots in self.epoch_grants.items():
                self.pending_sheds[instance_name] = (
                    self.pending_sheds.get(instance_name, 0) + slots
                )
            shed = sum(self.epoch_grants.values())
            if self.probing:
                self.probe_interval = min(
                    self.probe_interval * 2, PROBE_INTERVAL_MAX_SEC
                )
            self.frozen = True
            self.probing = False
            self.allowance = 0
            self.probe_at = now + self.probe_interval
            self.epoch = None
            self.epoch_grants = {}
            return _debug(
                self.job_id, "mint_epoch_no_evidence",
                dW=dW, shed=shed, probe_in_sec=round(self.probe_interval),
                W=self.W, G=round(self.G, 2),
            )

        dG = self.G - epoch["G_base"]
        average_per_worker = self.G / self.W if self.W else 0.0
        bar = KAPPA * average_per_worker * dW
        sigma = epoch["sigma"]
        fields = dict(
            dW=dW, dG=round(dG, 3), bar=round(bar, 3),
            sigma=round(sigma, 3) if sigma is not None else None,
            W=self.W, busy=self.busy, n_blocks=len(self._blocks),
            G=round(self.G, 2), probing=self.probing,
        )

        # Verification must clear the noise floor *strictly*: a job with busy
        # workers and zero completions has bar = 0 and sigma = 0, and
        # `0 >= 0` would verify blind growth forever, the exact stuck-tail
        # shape (pd12m) this controller exists to stop.
        if dG >= bar and dG > FREEZE_Z * sigma:
            strong = dG >= VERIFIED_STRONG_FRACTION * average_per_worker * dW
            multiplier = VERIFIED_STRONG_MULTIPLIER if strong else VERIFIED_MULTIPLIER
            granted = sum(self.epoch_grants.values())
            self.allowance = min(
                max(self._base_allowance(self.W), round(granted * multiplier)),
                round(ALLOWANCE_MAX_FRACTION * self.W),
            )
            self.epoch = None
            self.epoch_grants = {}
            self.probing = False
            self.probe_interval = PROBE_INTERVAL_SEC
            return _debug(
                self.job_id, "mint_epoch_verified",
                strong=strong, next_allowance=self.allowance, **fields,
            )

        ambiguous = dG >= bar - FREEZE_Z * sigma  # grant() guarantees sigma
        if ambiguous and epoch["extensions"] < EPOCH_MAX_EXTENSIONS:
            epoch["extensions"] += 1
            epoch["next_verdict_at"] = now + EPOCH_EXTENSION_SEC
            return _debug(self.job_id, "mint_epoch_extended", **fields)
        # An epoch that ran out of extensions still ambiguous freezes like a
        # measured shortfall (kept as a distinct event for forensics): growth
        # on no evidence is the exact failure mode this controller exists to
        # stop (observed: sigma-less "inconclusive" epochs kept re-granting
        # and walked a collapsing job from 8 to 12 workers).

        rollback = dG < -ROLLBACK_Z * sigma
        # A step that failed the marginal-gain bar still provides usable
        # overlap unless it measurably reduced goodput. Keep that final step
        # while freezing growth; only harmful steps and failed probes return
        # to the previous capacity.
        if rollback or self.probing:
            for instance_name, slots in self.epoch_grants.items():
                self.pending_sheds[instance_name] = (
                    self.pending_sheds.get(instance_name, 0) + slots
                )
            fields["shed"] = sum(self.epoch_grants.values())
        if self.probing:
            self.probe_interval = min(
                self.probe_interval * 2, PROBE_INTERVAL_MAX_SEC
            )
        self.frozen = True
        self.probing = False
        self.allowance = 0
        self.probe_at = time() + self.probe_interval
        self.epoch = None
        self.epoch_grants = {}
        if rollback:
            event = "mint_epoch_rolled_back"
        elif ambiguous:
            event = "mint_epoch_inconclusive"
        else:
            event = "mint_epoch_frozen"
        return _debug(
            self.job_id, event, probe_in_sec=round(self.probe_interval), **fields
        )


_controllers: dict[str, _JobController] = {}


def grant(job_id: str, instance_name: str, slots_requested: int) -> int:
    controller = _controllers.get(job_id)
    if controller is None:
        return 0
    return controller.grant(instance_name, slots_requested)


def take_shed(job_id: str, instance_name: str) -> int:
    controller = _controllers.get(job_id)
    if controller is None:
        return 0
    return controller.take_shed(instance_name)


async def controller_loop():
    # Lazy import: cluster_state imports main_service, mid-initialization
    # when this module is first imported.
    from main_service import cluster_state

    while True:
        await asyncio.sleep(TICK_INTERVAL_SEC)
        live = cluster_state.job_mint_inputs()
        live_ids = set()
        events = []
        for job_id, total_results, worker_count, busy_count in live:
            live_ids.add(job_id)
            controller = _controllers.get(job_id)
            if controller is None:
                if worker_count <= 0:
                    continue
                controller = _JobController(job_id, worker_count)
                _controllers[job_id] = controller
                events.append(
                    _debug(
                        job_id, "mint_controller_started",
                        W=worker_count, allowance=controller.allowance,
                    )
                )
                continue
            events.extend(controller.tick(total_results, worker_count, busy_count))
        for job_id in list(_controllers):
            if job_id not in live_ids:
                del _controllers[job_id]
        for event in events:
            await event
