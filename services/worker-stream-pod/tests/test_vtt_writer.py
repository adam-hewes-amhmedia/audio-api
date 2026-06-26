from worker_stream_pod.cue_emitter import Cue
from worker_stream_pod.vtt_writer import RollingVttWriter, format_vtt_time


class FakeStore:
    def __init__(self):
        self.objects = {}      # key -> bytes
        self.put_calls = []    # ordered (key, content_type)

    def put(self, key, data, content_type="text/vtt"):
        self.objects[key] = data
        self.put_calls.append((key, content_type))


def _cue(cid, start_ms, end_ms, text):
    return Cue(cue_id=cid, start_ms=start_ms, end_ms=end_ms, text=text)


def test_format_vtt_time():
    assert format_vtt_time(0) == "00:00:00.000"
    assert format_vtt_time(1000) == "00:00:01.000"
    assert format_vtt_time(187120) == "00:03:07.120"


def test_rolls_segments_on_6s_boundary_and_writes_playlist():
    store = FakeStore()
    w = RollingVttWriter(put=store.put, stream_id="s_1", segment_ms=6000)
    w.add(_cue(0, 1000, 3000, "one"))      # segment 0 -> 000001.vtt
    w.add(_cue(1, 7000, 9000, "two"))      # segment 1 -> 000002.vtt
    w.add(_cue(2, 13000, 15000, "three"))  # segment 2 -> 000003.vtt
    w.close()

    seg_keys = [k for k in store.objects if "/segments/" in k]
    assert sorted(seg_keys) == [
        "streams/s_1/segments/000001.vtt",
        "streams/s_1/segments/000002.vtt",
        "streams/s_1/segments/000003.vtt",
    ]

    seg1 = store.objects["streams/s_1/segments/000001.vtt"].decode()
    assert seg1.startswith("WEBVTT")
    assert "00:00:01.000 --> 00:00:03.000" in seg1
    assert "one" in seg1

    playlist = store.objects["streams/s_1/playlist.vtt"].decode()
    assert "#EXT-X-TARGETDURATION:6" in playlist
    assert playlist.index("segments/000001.vtt") < playlist.index("segments/000002.vtt") < playlist.index("segments/000003.vtt")
    assert "#EXT-X-ENDLIST" in playlist


def test_multiple_cues_in_one_segment():
    store = FakeStore()
    w = RollingVttWriter(put=store.put, stream_id="s_2", segment_ms=6000)
    w.add(_cue(0, 500, 1500, "a"))
    w.add(_cue(1, 2000, 3000, "b"))
    w.close()
    segs = [k for k in store.objects if "/segments/" in k]
    assert segs == ["streams/s_2/segments/000001.vtt"]
    body = store.objects[segs[0]].decode()
    assert "a" in body and "b" in body
    assert body.count("-->") == 2


def test_content_type_is_vtt():
    store = FakeStore()
    w = RollingVttWriter(put=store.put, stream_id="s_3", segment_ms=6000)
    w.add(_cue(0, 0, 1000, "x"))
    w.close()
    types = {ct for _k, ct in store.put_calls}
    assert types == {"text/vtt"}


def test_close_without_cues_writes_empty_playlist():
    store = FakeStore()
    w = RollingVttWriter(put=store.put, stream_id="s_4", segment_ms=6000)
    w.close()
    assert "streams/s_4/playlist.vtt" in store.objects
    assert not [k for k in store.objects if "/segments/" in k]
