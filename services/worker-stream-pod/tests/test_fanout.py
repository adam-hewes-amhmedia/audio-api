import asyncio

from worker_stream_pod.cue_emitter import Cue
from worker_stream_pod.audio_source import Gap
from worker_stream_pod.fanout import CueFanout, first_frame_hook


class FakeBroadcaster:
    def __init__(self):
        self.sent = []

    async def broadcast(self, payload):
        self.sent.append(payload)


class FakeVtt:
    def __init__(self):
        self.added = []

    def add(self, cue):
        self.added.append(cue)


async def _aiter(items):
    for it in items:
        yield it


def test_interim_is_ws_only_and_finalised_takes_full_path():
    bc = FakeBroadcaster()
    vtt = FakeVtt()
    published, persisted = [], []

    async def publish_cue(c):
        published.append(c)

    async def persist_cue(c):
        persisted.append(c)

    fo = CueFanout(stream_id="s1", broadcaster=bc, publish_cue=publish_cue, persist_cue=persist_cue, vtt=vtt)
    cues = [
        (Cue(cue_id=0, start_ms=0, end_ms=100, text="interim-text"), False),
        (Cue(cue_id=0, start_ms=0, end_ms=200, text="final-text"), True),
    ]
    count = asyncio.run(fo.run(_aiter(cues)))

    assert count == 1
    assert [p["event"] for p in bc.sent] == ["cue.interim", "cue.finalised"]
    assert all(p["stream_id"] == "s1" for p in bc.sent)
    # interim never reaches NATS / DB / VTT
    assert len(published) == 1 and published[0].text == "final-text"
    assert len(persisted) == 1 and persisted[0].text == "final-text"
    assert len(vtt.added) == 1 and vtt.added[0].text == "final-text"


def test_finalised_payload_shape():
    bc = FakeBroadcaster()

    async def noop(_c):
        pass

    fo = CueFanout(stream_id="s9", broadcaster=bc, publish_cue=noop, persist_cue=noop, vtt=None)
    cue = Cue(cue_id=7, start_ms=1000, end_ms=2000, text="hi", source_text="salut", confidence=0.8)
    asyncio.run(fo.run(_aiter([(cue, True)])))
    p = bc.sent[0]
    assert p == {
        "event": "cue.finalised", "stream_id": "s9", "cue_id": 7,
        "start_ms": 1000, "end_ms": 2000, "text": "hi",
        "source_text": "salut", "confidence": 0.8,
    }


def test_first_frame_hook_fires_once_before_first_frame():
    calls = []

    async def on_first():
        calls.append("started")

    async def run():
        out = []
        async for f in first_frame_hook(_aiter([b"a", b"b", b"c"]), on_first):
            out.append(f)
        return out

    out = asyncio.run(run())
    assert out == [b"a", b"b", b"c"]
    assert calls == ["started"]


def test_first_frame_hook_passes_gaps_through_without_counting_them():
    calls = []

    async def on_first():
        calls.append("started")

    async def run():
        out = []
        # A Gap is a hole where audio should have been, so it must not flip the
        # stream to active on its own.
        async for f in first_frame_hook(_aiter([Gap(500), b"a", Gap(200), b"b"]), on_first):
            out.append(f)
        return out

    out = asyncio.run(run())
    assert out == [Gap(500), b"a", Gap(200), b"b"]   # passed through unchanged
    assert calls == ["started"]


def test_first_frame_hook_no_fire_on_empty():
    calls = []

    async def on_first():
        calls.append("x")

    async def run():
        return [f async for f in first_frame_hook(_aiter([]), on_first)]

    assert asyncio.run(run()) == []
    assert calls == []


class FakeCaptionTs:
    def __init__(self):
        self.added = []

    def add(self, cue):
        self.added.append(cue)


def test_finalised_cues_reach_caption_ts_sink():
    bc = FakeBroadcaster()
    cap = FakeCaptionTs()

    async def publish_cue(c):
        pass

    async def persist_cue(c):
        pass

    fo = CueFanout(stream_id="s1", broadcaster=bc, publish_cue=publish_cue,
                   persist_cue=persist_cue, vtt=None, caption_ts=cap)

    async def run():
        cues = [
            (Cue(cue_id=1, start_ms=0, end_ms=1000, text="hi"), True),
            (Cue(cue_id=2, start_ms=1000, end_ms=2000, text="interim"), False),
        ]
        return await fo.run(_aiter(cues))

    n = asyncio.run(run())
    assert n == 1
    assert [c.cue_id for c in cap.added] == [1]   # only the finalised cue
