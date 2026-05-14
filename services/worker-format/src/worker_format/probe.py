import json
import subprocess
from typing import Optional

CHANNEL_LAYOUTS = {
    1: "mono",
    2: "stereo",
    6: "5.1",
    8: "7.1",
}

class ProbeError(Exception):
    pass

def probe(path: str) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise ProbeError(f"ffprobe failed: {r.stderr.strip()}")
    data = json.loads(r.stdout)
    audio = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not audio:
        raise ProbeError("no audio streams")
    s = audio[0]
    chcount = int(s.get("channels", 0))
    layout = s.get("channel_layout") or CHANNEL_LAYOUTS.get(chcount, f"{chcount}ch")
    return {
        "codec": s.get("codec_name", "unknown"),
        "sample_rate": int(s.get("sample_rate", 0)),
        "bit_depth": int(s.get("bits_per_raw_sample", 0)) or None,
        "channel_count": chcount,
        "channel_layout": layout,
        "duration_s": float(data.get("format", {}).get("duration", 0.0)),
    }
