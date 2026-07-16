"""Cue fan-out: routes assembler output to the right sinks.

Interim cues are ephemeral and go to the WebSocket only. Finalised cues take
the full path: WebSocket + NATS + Postgres + the rolling VTT writer. The sinks
are injected so the routing is unit-testable without NATS, a DB, or a store.
"""

from __future__ import annotations

from typing import AsyncIterator, Awaitable, Callable, Optional, Tuple

from .audio_source import Gap, Item
from .cue_emitter import Cue

PublishFn = Callable[[Cue], Awaitable[None]]
PersistFn = Callable[[Cue], Awaitable[None]]


async def first_frame_hook(frames: AsyncIterator[Item], on_first: Callable[[], Awaitable[None]]) -> AsyncIterator[Item]:
    """Yield items unchanged, awaiting ``on_first`` exactly once before the first
    frame (used to flip the stream to `active` on the first decoded audio).

    A Gap is a hole where audio should have been, not audio, so it never counts
    as the first frame.
    """
    first = True
    async for f in frames:
        if first and not isinstance(f, Gap):
            await on_first()
            first = False
        yield f


class CueFanout:
    def __init__(
        self,
        *,
        stream_id: str,
        broadcaster,
        publish_cue: PublishFn,
        persist_cue: PersistFn,
        vtt=None,
        caption_ts=None,
    ) -> None:
        self.stream_id = stream_id
        self.broadcaster = broadcaster
        self.publish_cue = publish_cue
        self.persist_cue = persist_cue
        self.vtt = vtt
        self.caption_ts = caption_ts

    def _payload(self, cue: Cue, event: str) -> dict:
        return {
            "event": event,
            "stream_id": self.stream_id,
            "cue_id": cue.cue_id,
            "start_ms": cue.start_ms,
            "end_ms": cue.end_ms,
            "text": cue.text,
            "source_text": cue.source_text,
            "confidence": cue.confidence,
        }

    async def run(self, cues: AsyncIterator[Tuple[Cue, bool]]) -> int:
        cue_count = 0
        async for cue, is_final in cues:
            if is_final:
                await self.broadcaster.broadcast(self._payload(cue, "cue.finalised"))
                await self.publish_cue(cue)
                await self.persist_cue(cue)
                if self.vtt is not None:
                    self.vtt.add(cue)
                if self.caption_ts is not None:
                    self.caption_ts.add(cue)
                cue_count += 1
            else:
                await self.broadcaster.broadcast(self._payload(cue, "cue.interim"))
        return cue_count
