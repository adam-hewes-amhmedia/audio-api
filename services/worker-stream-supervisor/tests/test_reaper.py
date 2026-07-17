import asyncio
import json

from worker_stream_supervisor.reaper import (
    REAP_REASON,
    build_event,
    reap_action,
    reap_once,
    reap_orphans_once,
)


class FakeJS:
    def __init__(self):
        self.published = []

    async def publish(self, subject, data):
        self.published.append((subject, json.loads(data)))


def test_reap_action_maps_status_to_terminal_event():
    # Active/ending streams end via ingest_ended (-> ended).
    assert reap_action("active") == "ingest_ended"
    assert reap_action("ending") == "ingest_ended"
    # Pre-ingest streams have no ingest_ended transition; they fail.
    assert reap_action("provisioning") == "failed"
    assert reap_action("awaiting_ingest") == "failed"
    # Already-terminal (or unknown) statuses are skipped.
    assert reap_action("ended") is None
    assert reap_action("archived") is None
    assert reap_action("failed") is None


def test_build_event_ingest_ended_shape():
    subject, payload = build_event("ingest_ended", "s1", "p1", 42)
    assert subject.endswith(".ingest.ended")
    assert payload["stream_id"] == "s1"
    assert payload["pod_id"] == "p1"
    assert payload["cue_count"] == 42
    assert payload["reason"] == REAP_REASON
    assert "ended_at" in payload


def test_build_event_failed_shape():
    subject, payload = build_event("failed", "s2", "p2", 0)
    assert subject.endswith(".failed")
    assert payload["stream_id"] == "s2"
    assert "code" in payload
    assert "message" in payload


def test_reap_once_publishes_per_stale_stream_and_marks_pods_dead():
    js = FakeJS()
    dead = []

    stale = [
        {"stream_id": "s1", "pod_id": "p1", "stream_status": "active", "cue_count": 5},
        {"stream_id": "s2", "pod_id": "p2", "stream_status": "awaiting_ingest", "cue_count": 0},
        # Defensive: a row whose status is already terminal must be skipped.
        {"stream_id": "s3", "pod_id": "p3", "stream_status": "ended", "cue_count": 9},
    ]

    async def fetch_stale():
        return stale

    async def mark_pod_dead(pod_id):
        dead.append(pod_id)

    reaped = asyncio.run(reap_once(js, fetch_stale=fetch_stale, mark_pod_dead=mark_pod_dead))

    assert reaped == ["s1", "s2"]
    assert dead == ["p1", "p2"]
    subjects = [s for s, _ in js.published]
    assert subjects[0].endswith(".ingest.ended")
    assert subjects[1].endswith(".failed")
    assert js.published[0][1]["cue_count"] == 5


# reap_once only ever visits pods attached to a *live* stream, because that is
# the only thing it can drive to a terminal state. That left a gap: once a
# stream reached ended/archived/failed, its pod row was orphaned at whatever
# status it last held (usually 'ready', written by the pod's own heartbeat) and
# nothing ever looked at it again. Pods accumulated forever, and the ops console
# showed dozens of dead pods flagged stale, burying the one that mattered.


def test_reap_orphans_marks_pods_dead_without_publishing():
    js = FakeJS()
    dead = []

    async def fetch_orphans():
        return ["p1", "p2"]

    async def mark_pod_dead(pod_id):
        dead.append(pod_id)

    reaped = asyncio.run(reap_orphans_once(fetch_orphans=fetch_orphans, mark_pod_dead=mark_pod_dead))

    assert reaped == ["p1", "p2"]
    assert dead == ["p1", "p2"]
    # No event, deliberately: the stream is already terminal, so there is no
    # transition left to drive. Publishing here would re-fire ingest_ended or
    # failed at a stream that has finished, and the stream machine would either
    # reject it or, worse, move an archived stream backwards.
    assert js.published == []


def test_reap_orphans_no_orphans_is_a_no_op():
    dead = []

    async def fetch_orphans():
        return []

    async def mark_pod_dead(pod_id):
        dead.append(pod_id)

    assert asyncio.run(reap_orphans_once(fetch_orphans=fetch_orphans, mark_pod_dead=mark_pod_dead)) == []
    assert dead == []
