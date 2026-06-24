import asyncio
from dataclasses import dataclass
from typing import AsyncIterator, List, Optional


@dataclass
class Cue:
    cue_id: int
    start_ms: int
    end_ms: int
    text: str
    source_text: Optional[str] = None
    confidence: Optional[float] = None


class StubCueSource:
    """Emits a sequence of placeholder cues at a fixed interval.
    Replaced by a real ASR-driven source in Plan 6."""

    def __init__(self, interval_ms: int = 5000, max_cues: Optional[int] = None) -> None:
        self.interval_ms = interval_ms
        self.max_cues = max_cues

    async def cues(self) -> AsyncIterator[Cue]:
        i = 0
        start = 0
        while self.max_cues is None or i < self.max_cues:
            yield Cue(
                cue_id=i,
                start_ms=start,
                end_ms=start + self.interval_ms,
                text=f"[stub cue {i}] live captioning placeholder",
                confidence=1.0,
            )
            i += 1
            start += self.interval_ms
            await asyncio.sleep(self.interval_ms / 1000.0)


class CueEmitter:
    def __init__(self, source) -> None:
        self.source = source

    async def collect_all(self) -> List[Cue]:
        out: List[Cue] = []
        async for c in self.source.cues():
            out.append(c)
        return out
