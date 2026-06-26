# Live subtitles — running the E2E

Two layers of E2E automation for the Plan 6 stream pipeline.

## 1. Gated pod pipeline test (Python)

Codifies the source -> ffmpeg -> VAD -> Whisper -> cues -> Postgres + WebVTT path
against live Postgres + MinIO and the real `small` model. Off by default.

```bash
make up && make migrate            # Postgres + MinIO (+ bootstraps)
cd services/worker-stream-pod
RUN_STREAM_E2E=1 \
  DATABASE_URL=postgres://audio:audio@localhost:5432/audio \
  OBJECT_STORE_ENDPOINT=http://localhost:9000 OBJECT_STORE_BUCKET=audio-api \
  OBJECT_STORE_ACCESS_KEY=audioadmin OBJECT_STORE_SECRET_KEY=audioadminpw \
  OBJECT_STORE_REGION=us-east-1 \
  .venv/Scripts/python -m pytest -q tests/test_e2e_stream.py
```

Point at your own clip with `STREAM_E2E_SOURCE=/path/clip.mp4 STREAM_E2E_HINT=fr`.
Defaults to the committed licence-clean SAPI English fixture (`en_probe.mp4`).

## 2. Full containerized service E2E

Drives the whole stack via `POST /v1/streams` (gateway -> orchestrator ->
supervisor -> pod -> archiver). The supervisor image bundles the pod (ffmpeg +
faster-whisper + Silero); `POD_MODEL_SIZE=small`, `WHISPER_DEVICE=cpu` and
`POD_MAX_DURATION_S=30` are set for a CPU-friendly run.

```bash
make up && make migrate                                  # full stack
TOKEN=$(scripts/seed-token.sh | sed 's/TOKEN=//')        # seed an API token
DEV_TOKEN="$TOKEN" \
  STREAM_SOURCE_URL="https://.../clip.mp4" STREAM_SOURCE_KIND=mp4 STREAM_HINT=fr \
  node --import tsx scripts/e2e-stream.ts
```

The pod downloads the model on first run (cached in the `modelcache` volume),
so the first `active` transition can take a couple of minutes on CPU.

## 3. Quality bench (manual, non-gating)

```bash
python scripts/bench-quality.py <source> --hint fr [--ref ref.txt] --models small,medium,large-v3
```

> A licence-clean ~30s French clip (`fr_30s.wav`) is still wanted for a committed
> FR->EN quality baseline; supply one and wire it into the bench.
