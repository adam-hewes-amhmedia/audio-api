"""Gated full-pipeline E2E for the stream pod.

Runs the real chain end-to-end against live Postgres + MinIO and a real model:
  source file -> ffmpeg decode -> Silero VAD -> faster-whisper translate
    -> finalised cues persisted to stream_cues
    -> rolling WebVTT written to object storage

Off by default. To run:
  RUN_STREAM_E2E=1 DATABASE_URL=... OBJECT_STORE_* ... \
    pytest tests/test_e2e_stream.py

The companion cues->EBU-TT-D archive step is covered by the worker-tt-archiver
Node tests. Point STREAM_E2E_SOURCE at any file/URL to use your own clip; the
default is the committed licence-clean SAPI English fixture (English through
task=translate is an English passthrough, enough to assert the pipeline).
"""
import asyncio
import os
import shutil

import pytest

RUN = os.environ.get("RUN_STREAM_E2E") == "1"
HAVE_DEPS = shutil.which("ffmpeg") is not None and bool(os.environ.get("DATABASE_URL"))
pytestmark = pytest.mark.skipif(
    not (RUN and HAVE_DEPS),
    reason="set RUN_STREAM_E2E=1 with ffmpeg + DATABASE_URL + OBJECT_STORE_* to run",
)

DEFAULT_SOURCE = os.path.join(os.path.dirname(__file__), "fixtures", "en_probe.mp4")
SOURCE = os.environ.get("STREAM_E2E_SOURCE", DEFAULT_SOURCE)
SID = "s_e2e_test"


def test_pipeline_source_to_cues_db_and_vtt():
    import psycopg
    from py_common import storage
    from py_common.storage import BUCKET
    from worker_stream_pod.audio_source import FfmpegSource
    from worker_stream_pod.cue_assembler import CueAssembler
    from worker_stream_pod.transcriber import FasterWhisperTranscriber
    from worker_stream_pod.vad_gate import VadGate, make_silero_is_speech
    from worker_stream_pod.vtt_writer import RollingVttWriter

    conn = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM streams WHERE id=%s", (SID,))
        cur.execute(
            "INSERT INTO streams (id,tenant_id,status,source_kind,source_url,target_lang) "
            "VALUES (%s,'t_e2e','active','mp4',%s,'en')",
            (SID, SOURCE),
        )

    s3 = storage.client()
    vtt = RollingVttWriter(
        put=lambda k, d, c: storage.upload_bytes(s3, k, d, c), stream_id=SID, segment_ms=6000
    )
    audio = FfmpegSource(source_kind="mp4", source_url=SOURCE, headers=None)
    gate = VadGate(max_cue_ms=8000, is_speech=make_silero_is_speech())
    tx = FasterWhisperTranscriber("small", device="cpu", compute_type="int8", source_hint=os.environ.get("STREAM_E2E_HINT"))
    asm = CueAssembler(gate=gate, transcriber=tx, interim_interval_ms=10_000_000, frame_ms=100, min_cue_ms=500)

    async def run():
        n = 0
        async for cue, is_final in asm.run(audio.frames()):
            if not is_final:
                continue
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO stream_cues (stream_id,cue_id,start_ms,end_ms,text,confidence) "
                    "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (SID, cue.cue_id, cue.start_ms, cue.end_ms, cue.text, cue.confidence),
                )
            vtt.add(cue)
            n += 1
        vtt.close()
        return n

    try:
        n = asyncio.run(run())

        assert audio.end_reason == "source_eof"
        assert n >= 1, "expected at least one finalised cue"

        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*), coalesce(string_agg(text, ' '), '') FROM stream_cues WHERE stream_id=%s",
                (SID,),
            )
            cnt, alltext = cur.fetchone()
        assert cnt == n
        if SOURCE == DEFAULT_SOURCE:
            assert any(tok in alltext.lower() for tok in ["terminal", "approach", "gap"]), alltext

        # rolling VTT landed in object storage
        s3.head_object(Bucket=BUCKET, Key=f"streams/{SID}/playlist.vtt")
    finally:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM streams WHERE id=%s", (SID,))
        conn.close()
