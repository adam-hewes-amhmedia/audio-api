"""Silero VAD gate: accumulates 16kHz mono PCM frames into an open buffer and
signals when that buffer should commit to a finalised cue.

It implements the ``VadGate`` protocol the cue_assembler drives: ``push`` returns
``"silence_boundary"`` (enough audio followed by a trailing-silence gap) or
``"max_window"`` (the buffer hit ``max_cue_ms``), and ``commit``/``flush`` hand
the buffered PCM back with absolute stream timestamps.

Speech/silence detection is injectable (``is_speech``) so the gate is fully
unit-testable without the model; the default builds a real Silero predicate.
"""

from __future__ import annotations

from typing import Callable, List, Optional, Tuple

Buffer = Tuple[bytes, int, int]
IsSpeech = Callable[[bytes], bool]


def make_silero_is_speech(threshold: float = 0.5, sample_rate: int = 16000) -> IsSpeech:
    """Build a frame-level speech predicate backed by Silero VAD.

    Runs the model over 512-sample windows within each frame and reports speech
    if any window's probability clears ``threshold``. Imported lazily so the
    unit tests (which inject their own predicate) never need torch.
    """
    import numpy as np
    import torch
    from silero_vad import load_silero_vad

    model = load_silero_vad()
    win = 512

    def is_speech(frame: bytes) -> bool:
        audio = np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
        max_p = 0.0
        for i in range(0, len(audio) - win + 1, win):
            chunk = torch.from_numpy(audio[i:i + win].copy())
            max_p = max(max_p, model(chunk, sample_rate).item())
        return max_p >= threshold

    return is_speech


class VadGate:
    def __init__(
        self,
        *,
        min_cue_ms: int = 800,
        silence_hold_ms: int = 300,
        max_cue_ms: int = 8000,
        is_speech: Optional[IsSpeech] = None,
    ) -> None:
        self.min_cue_ms = min_cue_ms
        self.silence_hold_ms = silence_hold_ms
        self.max_cue_ms = max_cue_ms
        self._is_speech = is_speech
        self._chunks: List[bytes] = []
        self._start: Optional[int] = None
        self._clock = 0                 # absolute stream position consumed
        self._trailing_silence = 0

    def _lazy_predicate(self) -> IsSpeech:
        if self._is_speech is None:
            self._is_speech = make_silero_is_speech()
        return self._is_speech

    def push(self, frame: bytes, frame_ms: int) -> Optional[str]:
        if self._start is None:
            self._start = self._clock
        self._chunks.append(frame)
        self._clock += frame_ms

        if self._lazy_predicate()(frame):
            self._trailing_silence = 0
        else:
            self._trailing_silence += frame_ms

        buffer_ms = self._clock - self._start
        if buffer_ms >= self.max_cue_ms:
            return "max_window"
        if buffer_ms >= self.min_cue_ms and self._trailing_silence >= self.silence_hold_ms:
            return "silence_boundary"
        return None

    def open_buffer(self) -> Optional[Buffer]:
        if self._start is None or not self._chunks:
            return None
        return (b"".join(self._chunks), self._start, self._clock)

    def commit(self) -> Optional[Buffer]:
        buf = self.open_buffer()
        if buf is None:
            return None
        self._chunks = []
        self._start = None
        self._trailing_silence = 0
        return buf

    def flush(self) -> Optional[Buffer]:
        return self.commit()
