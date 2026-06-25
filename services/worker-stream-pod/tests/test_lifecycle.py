import asyncio
import json
from worker_stream_pod.lifecycle import StatusReporter


class FakeJS:
    def __init__(self):
        self.published = []

    async def publish(self, subject, data):
        # data is bytes (nats_client.encode produces bytes); decode for assert
        self.published.append((subject, json.loads(data)))


def test_status_reporter_emits_ingest_started_and_ended():
    js = FakeJS()
    r = StatusReporter(js=js, stream_id="s1", pod_id="p1")
    async def run():
        await r.mark_started()
        await r.mark_ended(reason="source_eof", cue_count=7)
    asyncio.run(run())
    subjects = [s for s, _ in js.published]
    assert subjects[0].endswith(".ingest.started")
    assert subjects[1].endswith(".ingest.ended")
    assert js.published[1][1]["cue_count"] == 7
    assert js.published[1][1]["reason"] == "source_eof"
