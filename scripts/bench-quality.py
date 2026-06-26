#!/usr/bin/env python
"""Manual, non-gating translation-quality bench for the stream transcriber.

Decodes a source to 16kHz mono PCM with ffmpeg, runs FasterWhisperTranscriber at
each model size, and prints the English output. With a reference file + sacrebleu
installed it also prints chrF. Publish the numbers in the README before demos.

Usage (from the pod venv, ffmpeg on PATH):
  python scripts/bench-quality.py <source.(wav|mp4|url)> [--hint fr] [--ref ref.txt] \
    [--models small,medium,large-v3]
"""
import argparse
import subprocess
import sys


def decode_pcm(source: str) -> bytes:
    argv = ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", source,
            "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]
    return subprocess.run(argv, capture_output=True, check=True).stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("--hint", default=None)
    ap.add_argument("--ref", default=None)
    ap.add_argument("--models", default="small,medium,large-v3")
    args = ap.parse_args()

    from worker_stream_pod.transcriber import FasterWhisperTranscriber

    pcm = decode_pcm(args.source)
    reference = open(args.ref, encoding="utf-8").read().strip() if args.ref else None
    try:
        from sacrebleu import CHRF
        chrf = CHRF()
    except Exception:
        chrf = None

    for model_size in [m.strip() for m in args.models.split(",") if m.strip()]:
        print(f"\n=== {model_size} ===")
        tx = FasterWhisperTranscriber(model_size, device="cpu", compute_type="int8", source_hint=args.hint)
        cues = tx.transcribe(pcm, base_offset_ms=0)
        text = " ".join(c.text for c in cues).strip()
        print(text or "(no speech)")
        if reference and chrf is not None:
            print(f"chrF: {chrf.sentence_score(text, [reference]).score:.1f}")
        elif reference:
            print("(install sacrebleu for chrF)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
