"""Rolling HLS-style WebVTT writer.

Finalised cues are appended into fixed-length (default 6s) WebVTT segment files
and an HLS-style playlist that references them, both uploaded to object storage
under streams/{id}/. Only finalised cues are written (interim cues never reach
here). The uploader is injected (a ``put(key, data, content_type)`` callable) so
this is unit-testable without a real object store.
"""

from __future__ import annotations

from typing import Callable, List, Optional

PutFn = Callable[[str, bytes, str], None]


def format_vtt_time(ms: int) -> str:
    ms_part = ms % 1000
    total_sec = ms // 1000
    s = total_sec % 60
    m = (total_sec // 60) % 60
    h = total_sec // 3600
    return f"{h:02d}:{m:02d}:{s:02d}.{ms_part:03d}"


class RollingVttWriter:
    def __init__(self, *, put: PutFn, stream_id: str, segment_ms: int = 6000) -> None:
        self._put = put
        self.stream_id = stream_id
        self.segment_ms = segment_ms
        self._cur_idx: Optional[int] = None        # 0-based segment index currently buffered
        self._cur_cues: List = []
        self._segment_files: List[str] = []        # filenames in playlist order

    # ---- internal helpers ---------------------------------------------------

    def _segment_key(self, filename: str) -> str:
        return f"streams/{self.stream_id}/segments/{filename}"

    def _playlist_key(self) -> str:
        return f"streams/{self.stream_id}/playlist.vtt"

    def _render_segment(self) -> bytes:
        lines = ["WEBVTT", ""]
        for c in self._cur_cues:
            lines.append(f"{format_vtt_time(c.start_ms)} --> {format_vtt_time(c.end_ms)}")
            lines.append(c.text)
            lines.append("")
        return ("\n".join(lines) + "\n").encode("utf-8")

    def _flush_segment(self) -> None:
        if self._cur_idx is None or not self._cur_cues:
            return
        filename = f"{self._cur_idx + 1:06d}.vtt"
        self._put(self._segment_key(filename), self._render_segment(), "text/vtt")
        self._segment_files.append(filename)
        self._cur_cues = []

    def _render_playlist(self, *, ended: bool) -> bytes:
        target = -(-self.segment_ms // 1000)  # ceil(segment_ms/1000)
        lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            f"#EXT-X-TARGETDURATION:{target}",
            "#EXT-X-MEDIA-SEQUENCE:0",
        ]
        for filename in self._segment_files:
            lines.append(f"#EXTINF:{self.segment_ms / 1000:.3f},")
            lines.append(f"segments/{filename}")
        if ended:
            lines.append("#EXT-X-ENDLIST")
        return ("\n".join(lines) + "\n").encode("utf-8")

    def _write_playlist(self, *, ended: bool) -> None:
        self._put(self._playlist_key(), self._render_playlist(ended=ended), "text/vtt")

    # ---- public API ---------------------------------------------------------

    def add(self, cue) -> None:
        idx = cue.start_ms // self.segment_ms
        if self._cur_idx is None:
            self._cur_idx = idx
        elif idx > self._cur_idx:
            self._flush_segment()
            self._write_playlist(ended=False)
            self._cur_idx = idx
        self._cur_cues.append(cue)

    def close(self) -> None:
        self._flush_segment()
        self._write_playlist(ended=True)
