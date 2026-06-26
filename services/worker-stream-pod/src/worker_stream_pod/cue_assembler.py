"""The streaming cue loop: frames -> VAD gate -> Whisper -> interim/finalised cues.

The assembler drives an injected ``VadGate`` (which owns the open audio buffer
and signals commit boundaries) and a ``Transcriber``. While a buffer is open it
periodically re-infers it and emits *interim* cues; on a commit boundary (VAD
silence or max-window) it infers the committed buffer and emits *finalised* cues
with monotonically increasing ids. Both the gate and the transcriber are
injected, so this whole loop is unit-testable without ffmpeg or a model.

``run()`` yields ``(Cue, is_final)`` tuples. The caller (worker.py) routes
interim cues to the WebSocket only and finalised cues to the full persist path.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator, List, Optional, Protocol, Tuple

from .cue_emitter import Cue
from .transcriber import Transcriber

# (pcm, start_ms, end_ms)
Buffer = Tuple[bytes, int, int]


class VadGate(Protocol):
    def push(self, frame: bytes, frame_ms: int) -> Optional[str]:
        """Accumulate a frame; return 'silence_boundary' or 'max_window' when the
        open buffer should commit, else None."""
        ...

    def open_buffer(self) -> Optional[Buffer]:
        """Current uncommitted (pcm, start_ms, end_ms), or None if empty."""
        ...

    def commit(self) -> Optional[Buffer]:
        """Return and clear the committed buffer."""
        ...

    def flush(self) -> Optional[Buffer]:
        """Return and clear any remaining buffer at end of stream."""
        ...


class CueAssembler:
    def __init__(
        self,
        *,
        gate: VadGate,
        transcriber: Transcriber,
        interim_interval_ms: int = 1000,
        frame_ms: int = 100,
        min_cue_ms: int = 0,
    ) -> None:
        self.gate = gate
        self.transcriber = transcriber
        self.interim_interval_ms = interim_interval_ms
        self.frame_ms = frame_ms
        self.min_cue_ms = min_cue_ms
        self._next_id = 0
        self._last_interim_end = 0

    def _keep(self, seg) -> bool:
        # Drop empty and too-short cues (sub-second junk / leftover hallucinations).
        return bool(seg.text.strip()) and (seg.end_ms - seg.start_ms) >= self.min_cue_ms

    async def _transcribe(self, buf: Buffer):
        # Inference is a blocking C call (CTranslate2). Run it off the event loop
        # so the pod heartbeat keeps flowing — otherwise a long inference starves
        # the loop and the supervisor reaps the (healthy) pod as stale.
        pcm, start, _end = buf
        return await asyncio.to_thread(self.transcriber.transcribe, pcm, base_offset_ms=start)

    async def _finalise(self, buf: Buffer) -> List[Cue]:
        cues = []
        for seg in await self._transcribe(buf):
            if not self._keep(seg):
                continue
            cues.append(Cue(
                cue_id=self._next_id,
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                text=seg.text,
                source_text=seg.source_text,
                confidence=seg.confidence,
            ))
            self._next_id += 1
        return cues

    async def _interim(self, buf: Buffer) -> List[Cue]:
        cues = []
        for seg in await self._transcribe(buf):
            if not self._keep(seg):
                continue
            # Interim cues are ephemeral; they preview the in-progress utterance
            # under the id the next finalised cue will take.
            cues.append(Cue(
                cue_id=self._next_id,
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                text=seg.text,
                source_text=seg.source_text,
                confidence=seg.confidence,
            ))
        return cues

    async def run(self, frames: AsyncIterator[bytes]) -> AsyncIterator[Tuple[Cue, bool]]:
        async for frame in frames:
            signal = self.gate.push(frame, self.frame_ms)

            open_buf = self.gate.open_buffer()
            if open_buf is not None:
                _pcm, _start, end = open_buf
                if end - self._last_interim_end >= self.interim_interval_ms:
                    self._last_interim_end = end
                    for cue in await self._interim(open_buf):
                        yield (cue, False)

            if signal is not None:
                committed = self.gate.commit()
                if committed is not None:
                    for cue in await self._finalise(committed):
                        yield (cue, True)
                    self._last_interim_end = committed[2]

        remaining = self.gate.flush()
        if remaining is not None:
            for cue in await self._finalise(remaining):
                yield (cue, True)
