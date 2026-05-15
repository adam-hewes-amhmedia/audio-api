import numpy as np
import soundfile as sf
from faster_whisper import WhisperModel

_model = None


def model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("small", device="cpu", compute_type="int8")
    return _model


def detect(path: str) -> dict:
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

        sig30 = sig[: 30 * sr_eff]
        lang, prob, _ = model().detect_language(sig30)
        per_channel.append({
            "channel": ch,
            "language": lang if prob > 0.05 else "und",
            "confidence": float(round(prob, 4)),
        })
    return {"per_channel": per_channel, "duration_s": duration_s}
