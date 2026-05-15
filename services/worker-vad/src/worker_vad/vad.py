import numpy as np
import soundfile as sf
from silero_vad import load_silero_vad, get_speech_timestamps

_model = None


def model():
    global _model
    if _model is None:
        _model = load_silero_vad()
    return _model


def analyse(path: str) -> dict:
    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    per_channel = []
    duration_s = audio.shape[0] / sr
    for ch in range(audio.shape[1]):
        sig = audio[:, ch]
        if sr != 16000:
            import scipy.signal as sps
            sig = sps.resample_poly(sig, 16000, sr).astype(np.float32)
            sr_eff = 16000
        else:
            sr_eff = sr
        ts = get_speech_timestamps(sig, model(), sampling_rate=sr_eff, return_seconds=False)
        segs = [
            {
                "start_ms": int(t["start"] / sr_eff * 1000),
                "end_ms":   int(t["end"]   / sr_eff * 1000),
            }
            for t in ts
        ]
        total_speech = sum(s["end_ms"] - s["start_ms"] for s in segs)
        ratio = (total_speech / 1000.0) / max(duration_s, 1e-9)
        per_channel.append({"channel": ch, "speech_ratio": round(ratio, 4), "segments": segs})
    return {"per_channel": per_channel, "duration_s": duration_s}
