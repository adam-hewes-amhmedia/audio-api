"""Speech-to-English-translation interface for the stream pod.

The pipeline depends only on the ``Transcriber`` protocol so unit tests can
inject a deterministic fake. The real ``FasterWhisperTranscriber`` (faster-whisper,
task=translate) is implemented in a later task and exercised by a gated
CPU-model smoke test, never by the default unit suite.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Protocol


@dataclass
class Segment:
    text: str                       # English (translate task output)
    source_text: Optional[str]      # source-language transcript byproduct (internal only)
    start_ms: int
    end_ms: int
    confidence: Optional[float] = None


class Transcriber(Protocol):
    def transcribe(self, pcm: bytes, *, base_offset_ms: int) -> List[Segment]:
        """Translate a PCM buffer to English, timestamps offset by base_offset_ms."""
        ...
