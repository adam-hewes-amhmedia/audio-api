"""Isolated HLS video preview.

A SEPARATE ffmpeg from the audio pipeline, so the preview can never break
captions. Pull sources are opened directly; an SRT source is read from a local
UDP relay the audio ffmpeg copies its transport stream to (an SRT connection
cannot be re-opened). Video is stream-copied (-c:v copy): no re-encode, and a
source with no video track fails only this process, not captions.
"""

from __future__ import annotations

import shutil
from typing import Dict, List


def relay_url_for(hls_port: int) -> str:
    """Loopback UDP relay address. UDP on the (TCP) HLS port number: distinct
    socket namespaces, and unique per pod because hls_port is unique per pod."""
    return f"udp://127.0.0.1:{hls_port}"


def build_preview_argv(
    *,
    source_kind: str,
    source_url: str,
    headers: Dict[str, str],
    relay_url: str,
    hls_dir: str,
    ffmpeg_bin: str = "ffmpeg",
) -> List[str]:
    argv = [shutil.which(ffmpeg_bin) or ffmpeg_bin, "-nostdin", "-loglevel", "error"]
    if source_kind == "srt":
        # The audio ffmpeg relays the SRT transport stream to loopback UDP.
        argv += ["-i", relay_url]
    else:
        if headers:
            joined = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
            argv += ["-headers", joined]
        argv += ["-i", source_url]
    # Optional video map: if the source has no video, only THIS process fails.
    # Video-only by design (player is muted; captions carry the words), so no
    # audio is mapped/muxed -- an audio-only source then yields no output and
    # the console falls back instead of showing a pictureless audio player.
    argv += [
        "-map", "0:v:0?", "-c:v", "copy", "-an",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
        "-hls_flags", "delete_segments+append_list+omit_endlist",
        "-hls_segment_filename", f"{hls_dir}/seg-%d.ts",
        f"{hls_dir}/index.m3u8",
    ]
    return argv
