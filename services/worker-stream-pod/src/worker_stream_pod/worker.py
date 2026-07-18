import asyncio
import json
import os
import signal
import tempfile
import time

import psycopg

from py_common import logging_setup, nats_client, obs, storage, telemetry
from worker_stream_pod.audio_source import FfmpegSource, SourceError
from worker_stream_pod.cue_assembler import CueAssembler
from worker_stream_pod.cue_emitter import StubCueSource
from worker_stream_pod.fanout import CueFanout, first_frame_hook
from worker_stream_pod.heartbeat import heartbeat_loop, mark_exited
from worker_stream_pod.hls_server import serve_hls
from worker_stream_pod.lifecycle import StatusReporter
from worker_stream_pod.transcriber import FasterWhisperTranscriber
from worker_stream_pod.vad_gate import VadGate, make_silero_is_speech
from worker_stream_pod.video_preview import build_preview_argv, relay_url_for
from worker_stream_pod.vtt_writer import RollingVttWriter
from worker_stream_pod.ws_server import CueBroadcaster, serve_ws

log = logging_setup.setup("worker-stream-pod")
tracer = telemetry.setup("worker-stream-pod")


async def start_caption_egress(cfg):
    """Best-effort ffmpeg SRT listener fed our raw TS on stdin.

    Returns (proc, sink). On any failure returns (None, None); the caption
    output is optional and must never fail the stream.
    """
    if not cfg["CAPTION_TS"] or not cfg["SRT_PORT"]:
        return None, None
    url = f"srt://{cfg['SRT_HOST']}:{cfg['SRT_PORT']}?mode=listener"
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-loglevel", "error", "-f", "mpegts", "-i", "pipe:0",
            "-c", "copy", "-f", "mpegts", url,
            stdin=asyncio.subprocess.PIPE,
        )
    except Exception as e:
        log.warning("caption_egress_start_failed", err=str(e))
        return None, None

    async def sink(data: bytes) -> None:
        if proc.stdin is None or proc.stdin.is_closing():
            return
        try:
            proc.stdin.write(data)
            await proc.stdin.drain()
        except Exception as e:
            log.warning("caption_egress_write_failed", err=str(e))

    return proc, sink


async def start_video_preview(cfg):
    """Best-effort isolated HLS preview: a separate ffmpeg + a static HLS server.

    Returns (proc, server, hls_dir). On anything missing or any failure returns
    (None, None, None); the preview is optional and must never fail the stream.
    """
    if not cfg["HLS_PORT"]:
        return None, None, None
    try:
        hls_dir = tempfile.mkdtemp(prefix="hls_")
        relay = relay_url_for(cfg["HLS_PORT"])
        argv = build_preview_argv(
            source_kind=cfg["SOURCE_KIND"], source_url=cfg["SOURCE_URL"],
            headers=cfg["SOURCE_HEADERS"], relay_url=relay, hls_dir=hls_dir,
        )
        proc = await asyncio.create_subprocess_exec(*argv)
        server = await serve_hls(hls_dir, cfg["HLS_HOST"], cfg["HLS_PORT"])
        return proc, server, hls_dir
    except Exception as e:
        log.warning("video_preview_start_failed", err=str(e))
        return None, None, None


def _source_url() -> str:
    """The url ffmpeg opens.

    An srt listener has no client-supplied url: the supervisor allocates it a
    port and the pod turns that into the address it binds.
    """
    if os.environ.get("SOURCE_KIND") == "srt" and os.environ.get("SOURCE_MODE") == "listener":
        port = os.environ.get("POD_INGEST_PORT")
        if port:
            return f"srt://0.0.0.0:{port}"
    return os.environ.get("SOURCE_URL", "")


def _config() -> dict:
    return {
        "STREAM_ID":    os.environ["STREAM_ID"],
        "POD_ID":       os.environ["POD_ID"],
        "SOURCE_KIND":  os.environ["SOURCE_KIND"],
        "SOURCE_URL":   _source_url(),
        "SOURCE_MODE":  os.environ.get("SOURCE_MODE") or None,
        "SOURCE_PASSPHRASE": os.environ.get("SOURCE_PASSPHRASE") or None,
        "SOURCE_HEADERS": json.loads(os.environ.get("SOURCE_HEADERS_JSON", "{}")),
        "SOURCE_HINT":  os.environ.get("SOURCE_HINT") or None,
        "WS_HOST":      os.environ.get("POD_WS_HOST", "0.0.0.0"),
        "WS_PORT":      int(os.environ["POD_WS_PORT"]),
        "DATABASE_URL": os.environ["DATABASE_URL"],
        "MODEL_SIZE":   os.environ.get("POD_MODEL_SIZE", "medium"),
        "WHISPER_DEVICE": os.environ.get("WHISPER_DEVICE", "cpu"),
        "WHISPER_COMPUTE_TYPE": os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
        "INTERIM_INTERVAL_MS": int(os.environ.get("POD_INTERIM_INTERVAL_MS", "1000")),
        "MAX_CUE_MS":   int(os.environ.get("POD_MAX_CUE_MS", "8000")),
        "MIN_CUE_MS":   int(os.environ.get("POD_MIN_CUE_MS", "500")),
        "VTT_SEGMENT_S": int(os.environ.get("POD_VTT_SEGMENT_S", "6")),
        "IDLE_TIMEOUT_S": float(os.environ.get("POD_IDLE_TIMEOUT_S", "30")),
        # How long a source has to produce its first frame. Deliberately two
        # knobs: a pull source should already be answering, while a listener is
        # waiting for someone to point an encoder at it.
        "PROVISION_TTL_S": float(os.environ.get("POD_PROVISION_TTL_S", "15")),
        "INGEST_WAIT_S":   float(os.environ.get("POD_INGEST_WAIT_S", "300")),
        # How long a dropped srt source has to come back before the stream ends.
        # Encoders drop routinely, so this is the difference between a blip and a
        # dead broadcast. 0 disables reconnects.
        "RECONNECT_WINDOW_S": float(os.environ.get("POD_RECONNECT_WINDOW_S", "60")),
        "MAX_DURATION_S": (float(os.environ["POD_MAX_DURATION_S"]) if os.environ.get("POD_MAX_DURATION_S") else None),
        "HEARTBEAT_INTERVAL_S": float(os.environ.get("POD_HEARTBEAT_INTERVAL_S", "10")),
        "USE_STUB":     os.environ.get("POD_USE_STUB") == "1",
        "CUE_INTERVAL_MS": int(os.environ.get("POD_CUE_INTERVAL_MS", "5000")),
        "CAPTION_TS":   os.environ.get("POD_CAPTION_TS") == "1",
        "SRT_HOST":     os.environ.get("POD_SRT_HOST", "0.0.0.0"),
        "SRT_PORT":     (int(os.environ["POD_SRT_PORT"]) if os.environ.get("POD_SRT_PORT") else None),
        "CAPTION_FPS":         int(os.environ.get("POD_CAPTION_FPS", "25")),
        "CAPTION_LATENCY_MS":  int(os.environ.get("POD_CAPTION_LATENCY_MS", "1000")),
        "CAPTION_SERVICE":     int(os.environ.get("POD_CAPTION_SERVICE", "1")),
        "HLS_PORT":     (int(os.environ["POD_HLS_PORT"]) if os.environ.get("POD_HLS_PORT") else None),
        "HLS_HOST":     os.environ.get("POD_HLS_HOST", "0.0.0.0"),
    }


async def _publish_failed(js, stream_id, pod_id, code, message):
    await js.publish(nats_client.SUBJECTS["STREAM_FAILED"], nats_client.encode({
        "stream_id": stream_id, "pod_id": pod_id, "code": code, "message": message,
    }))


def _make_sinks(cfg, js, conn, session):
    async def publish_cue(cue):
        await js.publish(nats_client.SUBJECTS["STREAM_CUE_FINALISED"], nats_client.encode({
            "stream_id": cfg["STREAM_ID"], "cue_id": cue.cue_id,
            "start_ms": cue.start_ms, "end_ms": cue.end_ms,
            "text": cue.text, "confidence": cue.confidence,
        }))

    async def persist_cue(cue):
        try:
            async with conn.cursor() as cur:
                await cur.execute(
                    "INSERT INTO stream_cues (stream_id, cue_id, start_ms, end_ms, text, source_text, confidence) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (cfg["STREAM_ID"], cue.cue_id, cue.start_ms, cue.end_ms, cue.text, cue.source_text, cue.confidence),
                )
                await cur.execute("UPDATE streams SET cue_count = cue_count + 1 WHERE id=%s", (cfg["STREAM_ID"],))
            await conn.commit()
        except Exception as e:
            log.warning("cue_persist_failed", err=str(e))

        # Headline KPI: how far behind real time the finalised cue lands. Wall
        # time elapsed since the first decoded frame minus the cue's media end.
        started = session.get("started_wall")
        if started is not None:
            latency_ms = (time.time() - started) * 1000.0 - cue.end_ms
            obs.record_latency_span("stream.audio_to_cue", latency_ms, **{"stream.id": cfg["STREAM_ID"]})

    return publish_cue, persist_cue


async def _stub_cues(cfg):
    """POD_USE_STUB=1: emit placeholder finalised cues at a fixed interval."""
    async for cue in StubCueSource(interval_ms=cfg["CUE_INTERVAL_MS"]).cues():
        yield (cue, True)


async def main():
    cfg = _config()
    nc, js = await nats_client.connect()
    broadcaster = CueBroadcaster()
    ws_server = await serve_ws(broadcaster, cfg["WS_HOST"], cfg["WS_PORT"])
    reporter = StatusReporter(js=js, stream_id=cfg["STREAM_ID"], pod_id=cfg["POD_ID"])

    # Model-warm before `ready`: a load failure fails provisioning rather than
    # leaving a half-up pod.
    transcriber = None
    if not cfg["USE_STUB"]:
        try:
            transcriber = FasterWhisperTranscriber(
                cfg["MODEL_SIZE"], device=cfg["WHISPER_DEVICE"],
                compute_type=cfg["WHISPER_COMPUTE_TYPE"], source_hint=cfg["SOURCE_HINT"],
            )
        except Exception as e:
            log.error("model_load_failed", err=str(e))
            await _publish_failed(js, cfg["STREAM_ID"], cfg["POD_ID"], "STREAM_PROVISION_FAILED", str(e))
            ws_server.close(); await ws_server.wait_closed(); await nc.drain()
            return

    async with await psycopg.AsyncConnection.connect(cfg["DATABASE_URL"]) as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE stream_pods SET status='ready' WHERE pod_id=%s", (cfg["POD_ID"],))
        await conn.commit()
        log.info("pod_ready", stream_id=cfg["STREAM_ID"], pod_id=cfg["POD_ID"], ws_port=cfg["WS_PORT"])

        stop = asyncio.Event()
        deleted = {"v": False}
        audio = None
        cap_proc = cap_task = caption_mux = None
        prev_proc = prev_server = prev_dir = None

        def _on_sigterm(*_):
            deleted["v"] = True
            stop.set()
            if audio is not None:
                audio.terminate()

        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, _on_sigterm)
            except NotImplementedError:
                signal.signal(sig, _on_sigterm)  # Windows

        session = {"started_wall": None}

        async def _on_first_frame():
            session["started_wall"] = time.time()
            await reporter.mark_started()

        publish_cue, persist_cue = _make_sinks(cfg, js, conn, session)
        vtt = None
        cue_count = 0
        end_reason = "client_delete"

        hb_task = asyncio.create_task(
            heartbeat_loop(cfg["DATABASE_URL"], cfg["POD_ID"], cfg["HEARTBEAT_INTERVAL_S"], stop)
        )
        # One span per stream session; its presence/duration feeds the active-
        # stream count and lifetime on the Live Streams dashboard.
        session_span = tracer.start_span("stream.pod.session")
        session_span.set_attribute("stream.id", cfg["STREAM_ID"])

        try:
            if cfg["USE_STUB"]:
                await reporter.mark_started()
                fanout = CueFanout(stream_id=cfg["STREAM_ID"], broadcaster=broadcaster,
                                   publish_cue=publish_cue, persist_cue=persist_cue, vtt=None)
                cues = _stub_cues(cfg)
                run_task = asyncio.create_task(fanout.run(cues))
                done, _pending = await asyncio.wait({run_task, asyncio.create_task(stop.wait())},
                                                    return_when=asyncio.FIRST_COMPLETED)
                run_task.cancel()
                try:
                    cue_count = await run_task
                except asyncio.CancelledError:
                    pass
                end_reason = "client_delete"
            else:
                s3 = storage.client()
                vtt = RollingVttWriter(
                    put=lambda key, data, ct: storage.upload_bytes(s3, key, data, ct),
                    stream_id=cfg["STREAM_ID"], segment_ms=cfg["VTT_SEGMENT_S"] * 1000,
                )
                audio = FfmpegSource(
                    source_kind=cfg["SOURCE_KIND"], source_url=cfg["SOURCE_URL"],
                    source_mode=cfg["SOURCE_MODE"], passphrase=cfg["SOURCE_PASSPHRASE"],
                    headers=cfg["SOURCE_HEADERS"], idle_timeout_s=cfg["IDLE_TIMEOUT_S"],
                    provision_ttl_s=cfg["PROVISION_TTL_S"], ingest_wait_s=cfg["INGEST_WAIT_S"],
                    reconnect_window_s=cfg["RECONNECT_WINDOW_S"],
                    max_duration_s=cfg["MAX_DURATION_S"],
                    relay_url=(relay_url_for(cfg["HLS_PORT"]) if cfg["HLS_PORT"] else None),
                )
                gate = VadGate(max_cue_ms=cfg["MAX_CUE_MS"], is_speech=make_silero_is_speech())
                assembler = CueAssembler(gate=gate, transcriber=transcriber,
                                         interim_interval_ms=cfg["INTERIM_INTERVAL_MS"], frame_ms=100,
                                         min_cue_ms=cfg["MIN_CUE_MS"])

                cap_proc, cap_sink = await start_caption_egress(cfg)
                if cap_sink is not None:
                    from worker_stream_pod.caption_ts_muxer import build_muxer_from_env
                    caption_mux = build_muxer_from_env(cfg, cap_sink)
                    cap_task = asyncio.create_task(caption_mux.run(stop))
                prev_proc, prev_server, prev_dir = await start_video_preview(cfg)

                fanout = CueFanout(stream_id=cfg["STREAM_ID"], broadcaster=broadcaster,
                                   publish_cue=publish_cue, persist_cue=persist_cue, vtt=vtt,
                                   caption_ts=caption_mux)

                frames = first_frame_hook(audio.frames(), _on_first_frame)
                cue_count = await fanout.run(assembler.run(frames))
                end_reason = "client_delete" if deleted["v"] else (audio.end_reason or "source_eof")
        except SourceError as e:
            log.error("source_failed", code=e.code, detail=e.detail)
            await _publish_failed(js, cfg["STREAM_ID"], cfg["POD_ID"], e.code, e.detail or e.code)
            end_reason = "source_failed"
        except Exception as e:
            log.error("inference_failed", err=str(e))
            await _publish_failed(js, cfg["STREAM_ID"], cfg["POD_ID"], "STREAM_INFERENCE_FAILED", str(e))
            end_reason = "source_failed"
        finally:
            if vtt is not None:
                try:
                    vtt.close()
                except Exception as e:
                    log.warning("vtt_close_failed", err=str(e))
            if cap_task is not None:
                cap_task.cancel()
                try:
                    await cap_task
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    # Belt-and-braces: caption egress is best-effort, so even an
                    # internal muxer error must not stop the rest of shutdown
                    # (heartbeat cancel, mark_ended, ws/nats close) from running.
                    log.warning("caption_egress_task_failed", err=str(e))
            if cap_proc is not None:
                try:
                    if cap_proc.stdin is not None:
                        cap_proc.stdin.close()
                    cap_proc.terminate()
                    try:
                        await asyncio.wait_for(cap_proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        # A wedged ffmpeg that ignores SIGTERM must not orphan;
                        # escalate to SIGKILL and reap it.
                        cap_proc.kill()
                        await cap_proc.wait()
                except Exception as e:
                    log.warning("caption_egress_close_failed", err=str(e))
            if prev_server is not None:
                try:
                    prev_server.close()
                    await prev_server.wait_closed()
                except Exception as e:
                    log.warning("video_preview_server_close_failed", err=str(e))
            if prev_proc is not None:
                try:
                    prev_proc.terminate()
                    try:
                        await asyncio.wait_for(prev_proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        prev_proc.kill()
                        await prev_proc.wait()
                except Exception as e:
                    log.warning("video_preview_close_failed", err=str(e))
            if prev_dir is not None:
                try:
                    import shutil as _sh
                    _sh.rmtree(prev_dir, ignore_errors=True)
                except Exception:
                    pass
            hb_task.cancel()
            try:
                await hb_task
            except asyncio.CancelledError:
                pass

            # Strictly after the heartbeat is cancelled: a beat racing this write
            # would set the row back to 'ready' and undo it.
            #
            # Best-effort, like the heartbeat itself. Failing to file the pod's
            # own death certificate must not stop the rest of shutdown, and the
            # reaper is the backstop that catches the row either way.
            try:
                await mark_exited(cfg["DATABASE_URL"], cfg["POD_ID"])
            except Exception as e:
                log.warning("pod_mark_exited_failed", err=str(e))

        await reporter.mark_ended(reason=end_reason, cue_count=cue_count)
        session_span.set_attribute("stream.end_reason", end_reason)
        session_span.set_attribute("stream.cue_count", cue_count)
        session_span.end()

    ws_server.close()
    await ws_server.wait_closed()
    await nc.drain()
    log.info("pod_exited", stream_id=cfg["STREAM_ID"], cues=cue_count, reason=end_reason)
