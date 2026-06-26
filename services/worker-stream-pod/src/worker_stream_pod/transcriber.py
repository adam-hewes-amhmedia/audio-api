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


class FasterWhisperTranscriber:
    """Real Transcriber backed by faster-whisper (CTranslate2), task=translate.

    Input is raw 16kHz mono s16le PCM (what the ffmpeg source yields). Output
    segments carry English text; timestamps are offset by ``base_offset_ms`` so
    they sit on the stream timeline. Heavy deps (numpy, faster-whisper) and the
    model are loaded once at construction.
    """

    def __init__(
        self,
        model_size: str = "medium",
        *,
        device: str = "cpu",
        compute_type: str = "int8",
        source_hint: Optional[str] = None,
    ) -> None:
        from faster_whisper import WhisperModel

        self.model = WhisperModel(model_size, device=device, compute_type=compute_type)
        self.source_hint = source_hint

    def transcribe(self, pcm: bytes, *, base_offset_ms: int) -> List[Segment]:
        import numpy as np

        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = self.model.transcribe(
            audio,
            task="translate",
            language=self.source_hint,
            vad_filter=False,
            word_timestamps=False,
        )
        out: List[Segment] = []
        for s in segments:
            out.append(Segment(
                text=s.text.strip(),
                source_text=None,  # source-language byproduct not emitted in v1
                start_ms=base_offset_ms + int(s.start * 1000),
                end_ms=base_offset_ms + int(s.end * 1000),
                confidence=getattr(s, "avg_logprob", None),
            ))
        return out
