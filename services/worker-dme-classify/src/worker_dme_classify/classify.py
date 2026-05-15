import numpy as np
import soundfile as sf
from panns_inference import AudioTagging

SPEECH_LABELS = {0, 1, 2, 3, 4, 5, 6, 7}
MUSIC_LABELS = set(range(132, 280))
SILENCE_LABELS = {474}

_tagger = None


def tagger():
    global _tagger
    if _tagger is None:
        _tagger = AudioTagging(device="cpu")
    return _tagger


SEGMENT_MS_DEFAULT = 1000


def _label_bucket(top_idx: int) -> str:
    if top_idx in SPEECH_LABELS:
        return "dialog"
    if top_idx in MUSIC_LABELS:
        return "music"
    if top_idx in SILENCE_LABELS:
        return "silence"
    return "effects"


def classify(path: str, segment_ms: int = SEGMENT_MS_DEFAULT) -> dict:
    audio, sr = sf.read(path, always_2d=True, dtype="float32")
    samples_per_segment = int(sr * segment_ms / 1000)
    per_channel = []
    duration_s = audio.shape[0] / sr
    for ch in range(audio.shape[1]):
        sig = audio[:, ch]
        timeline = []
        cur_tag = None
        cur_start = 0
        cur_conf = 0.0
        for i in range(0, len(sig), samples_per_segment):
            window = sig[i : i + samples_per_segment]
            if len(window) < int(sr * 0.5):
                break
            clipwise, _ = tagger().inference(window[None, :])
            scores = clipwise[0]
            top = int(np.argmax(scores))
            tag = _label_bucket(top)
            conf = float(scores[top])
            start_ms = int(i / sr * 1000)
            if cur_tag is None:
                cur_tag, cur_start, cur_conf = tag, start_ms, conf
            elif tag == cur_tag:
                cur_conf = max(cur_conf, conf)
            else:
                timeline.append({
                    "start_ms": cur_start,
                    "end_ms": start_ms,
                    "tag": cur_tag,
                    "confidence": round(cur_conf, 4),
                })
                cur_tag, cur_start, cur_conf = tag, start_ms, conf
        if cur_tag is not None:
            timeline.append({
                "start_ms": cur_start,
                "end_ms": int(duration_s * 1000),
                "tag": cur_tag,
                "confidence": round(cur_conf, 4),
            })
        per_channel.append({"channel": ch, "timeline": timeline})
    return {"per_channel": per_channel, "duration_s": duration_s}
