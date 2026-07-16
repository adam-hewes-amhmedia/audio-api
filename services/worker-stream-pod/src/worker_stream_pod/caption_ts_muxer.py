"""Background caption TS muxer: wall-clock frame loop feeding SRT egress.

Owns a nominal-fps ticker. Each tick it renders the current pop-on caption
(or padding) as a CDP, wraps it in SMPTE 2038, packetises to TS with a
wall-clock PTS/PCR, and writes to an injected byte sink (ffmpeg stdin in
production). Finalised cues arrive via add() on a bounded queue; overflow
drops oldest so captions never back-pressure ASR. See
docs/superpowers/specs/2026-07-15-cta708-caption-ts-design.md.
"""
from __future__ import annotations

import asyncio
import os
import time
from collections import deque
from typing import Awaitable, Callable, Deque, Optional

from .cue_emitter import Cue
from .cea708 import popon_triplets, clear_triplets
from .cdp import build_cdp, frame_rate_code
from .smpte2038 import wrap_cdp
from .ts_mux import TsMuxer, ms_to_pts, ms_to_pcr

SinkFn = Callable[[bytes], Awaitable[None]]


class Caption708Muxer:
    def __init__(
        self,
        *,
        sink: Optional[SinkFn],
        now: Callable[[], float],
        fps: int = 25,
        latency_ms: int = 1000,
        service: int = 1,
        psi_interval_frames: int = 25,
        queue_max: int = 256,
    ) -> None:
        self._sink = sink
        self._now = now
        self._fps = fps
        self._frame_ms = 1000.0 / fps
        self._frame_s = self._frame_ms / 1000.0
        self._latency_ms = latency_ms
        self._service = service
        self._psi_interval = psi_interval_frames
        self._queue: Deque[Cue] = deque()
        self._queue_max = queue_max
        self._ts = TsMuxer()
        self._rate_code = frame_rate_code(fps)
        self._seq = 0
        self._t0: Optional[float] = None
        self._clear_at_ms: Optional[float] = None
        self.frames_emitted = 0
        self.dropped = 0

    def add(self, cue: Cue) -> None:
        if len(self._queue) >= self._queue_max:
            self._queue.popleft()
            self.dropped += 1
        self._queue.append(cue)

    def _elapsed_ms(self) -> float:
        return (self._now() - self._t0) * 1000.0

    def _triplets_for_tick(self, elapsed_ms: float):
        # Promote a queued cue to the active caption.
        if self._queue:
            cue = self._queue.popleft()
            triplets = popon_triplets(cue.text, service=self._service)
            self._clear_at_ms = elapsed_ms + max(0, cue.end_ms - cue.start_ms)
            return triplets                  # send the caption commands once
        if self._clear_at_ms is not None and elapsed_ms >= self._clear_at_ms:
            self._clear_at_ms = None
            return clear_triplets(service=self._service)
        return []                            # padding-only frame (keepalive)

    async def run(self, stop: asyncio.Event) -> None:
        self._t0 = self._now()
        frame = 0
        next_tick = self._now()
        while not stop.is_set():
            elapsed_ms = self._elapsed_ms()
            triplets = self._triplets_for_tick(elapsed_ms)
            cdp = build_cdp(triplets, sequence=self._seq & 0xFFFF,
                            frame_rate_code=self._rate_code)
            self._seq += 1
            payload = wrap_cdp(cdp)
            pts = ms_to_pts(elapsed_ms + self._latency_ms)
            pcr = ms_to_pcr(elapsed_ms + self._latency_ms)
            out = bytearray()
            if frame % self._psi_interval == 0:
                out += self._ts.psi_packets()
            out += self._ts.pes_packet(payload, pts_90k=pts, pcr_27m=pcr)
            if self._sink is not None:
                await self._sink(bytes(out))
            self.frames_emitted += 1
            frame += 1
            next_tick += self._frame_s
            await asyncio.sleep(max(0.0, next_tick - self._now()))


def build_muxer_from_env(cfg: dict, sink: SinkFn) -> Caption708Muxer:
    return Caption708Muxer(
        sink=sink,
        now=time.time,
        fps=int(cfg.get("CAPTION_FPS", os.environ.get("POD_CAPTION_FPS", "25"))),
        latency_ms=int(cfg.get("CAPTION_LATENCY_MS", os.environ.get("POD_CAPTION_LATENCY_MS", "1000"))),
        service=int(cfg.get("CAPTION_SERVICE", os.environ.get("POD_CAPTION_SERVICE", "1"))),
    )
